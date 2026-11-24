/**
 * A small client for HubID's Mandala agent API (hub/HubID hubid_api, served at id.hubculture.com).
 *
 * SERVER-SIDE ONLY. The `/mandala/v1` routes want the app's Private-Key header, which is an app
 * secret, so this runs inside the MCP server and never in an agent's own process.
 *
 * Every call here maps one-to-one to a documented HubID route (developers.hubculture.com/api/mandala
 * and hubid_api/docs/hubid-api.openapi.json). Nothing is decided here: scopes, spend limits,
 * custodian approvals and rate limits are all enforced by HubID.
 */

export interface MandalaClientOptions {
  /** e.g. https://id.hubculture.com */
  baseUrl: string;
  /** The app's Public-Key / Private-Key pair (required by /mandala/v1). */
  publicKey?: string;
  privateKey?: string;
  fetch?: typeof fetch;
}

/** HubID's envelope: { status, errors, data, code, error_code? }. */
interface Envelope<T> {
  status?: string;
  errors?: unknown;
  data?: T;
  code?: number;
  error_code?: string;
  message?: string;
  error?: string;
}

export class MandalaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** HubID's machine-readable code, e.g. `forbidden`, `token_stale`, `rate_limited`. */
    readonly errorCode: string | undefined,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "MandalaError";
  }
}

export interface MandalaIdentity {
  id: number;
  type: string;
  status: string;
  name: string;
  first?: string;
  last?: string;
  ven_balance: number | string;
  scopes: string[];
  owner_hubid: number | null;
}

export interface NewAgent {
  token: string;
  user_id: number;
  email: string;
}

export interface IssuedKey {
  /** `magk_…`, shown once. */
  key: string;
  id?: number;
  label?: string | null;
  expires_at?: string | null;
}

export interface OwnerClaim {
  claim_code: string;
  owner_hubid: number;
  expires_at: number;
}

export interface SendResult {
  /** 200: Ven moved. 202: held for the custodian's approval; no Ven moved yet. */
  httpStatus: number;
  pendingApproval: boolean;
  replayed: boolean;
  data: unknown;
}

export class MandalaClient {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly o: MandalaClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.f = o.fetch ?? fetch;
  }

  // ---- Public (no token) ----------------------------------------------------------------------

  /** POST /mandala/agent: a new, unowned Mandala agent. Returns a token valid for 60 minutes on v1. */
  createAgent(input: { first: string; last: string; password: string; country?: string }): Promise<NewAgent> {
    return this.call<NewAgent>("POST", "/mandala/agent", { body: input });
  }

  /** POST /mandala/key/token: trade a `magk_` key for a fresh session token. */
  exchangeKey(key: string): Promise<NewAgent> {
    return this.call<NewAgent>("POST", "/mandala/key/token", { body: { key } });
  }

  /** GET /lineages/{agentId}: who answers for an agent, under which law. Public, for verifiers. */
  publicLineage(agentId: number): Promise<unknown> {
    return this.call("GET", `/lineages/${agentId}`, { appKeys: true });
  }

  /** GET /mandala/verify/oai/{hash}: is this OAI hash a live Mandala identity? */
  verifyOai(hash: string): Promise<unknown> {
    return this.call("GET", `/mandala/verify/oai/${encodeURIComponent(hash)}`);
  }

  // ---- As the agent ---------------------------------------------------------------------------

  me(token: string): Promise<MandalaIdentity> {
    return this.call<MandalaIdentity>("GET", "/mandala/v1/me", { token, appKeys: true });
  }

  transactions(token: string, offset = 0, limit = 10): Promise<unknown> {
    return this.call("GET", `/mandala/v1/ven/transactions?offset=${offset}&limit=${limit}`, { token, appKeys: true });
  }

  /** POST /mandala/v1/agent-keys: a long-lived key for this agent. The secret is returned once. */
  issueKey(token: string, label?: string): Promise<IssuedKey> {
    return this.call<IssuedKey>("POST", "/mandala/v1/agent-keys", { token, appKeys: true, body: label ? { label } : {} });
  }

  /** POST /mandala/v1/owner-claims: a claim code naming the person the agent wants as its owner. */
  requestOwner(token: string, ownerHubId: number): Promise<OwnerClaim> {
    return this.call<OwnerClaim>("POST", "/mandala/v1/owner-claims", { token, appKeys: true, body: { owner_hubid: ownerHubId } });
  }

  lineage(token: string): Promise<unknown> {
    return this.call("GET", "/mandala/v1/lineage", { token, appKeys: true });
  }

  hubs(token: string): Promise<unknown> {
    return this.call("GET", "/mandala/v1/hubs", { token, appKeys: true });
  }

  /** POST /mandala/v1/messages: a new Hub Culture message thread. Needs `messages:send`. */
  message(token: string, input: { recipients: number[]; content: string; subject?: string }): Promise<unknown> {
    return this.call("POST", "/mandala/v1/messages", { token, appKeys: true, body: input });
  }

  /**
   * POST /mandala/send. HubID enforces the custodian's limits; at or above the approval line it
   * answers 202 `pending_approval` and moves nothing until the custodian approves.
   */
  async send(
    token: string,
    input: { to?: number; email?: string; amount: number; message?: string },
    idempotencyKey: string,
  ): Promise<SendResult> {
    const res = await this.raw("POST", "/mandala/send", { token, body: input, headers: { "Idempotency-Key": idempotencyKey } });
    const data = await this.unwrap<unknown>(res);
    return {
      httpStatus: res.status,
      pendingApproval: res.status === 202,
      replayed: res.headers.get("Idempotent-Replayed") === "true",
      data,
    };
  }

  /** POST /mandala/request: an alert asking a member to send Ven. Moves nothing. */
  request(token: string, input: { user: number; amount: number; message: string }, idempotencyKey: string): Promise<unknown> {
    return this.call("POST", "/mandala/request", { token, body: input, headers: { "Idempotency-Key": idempotencyKey } });
  }

  // ---- plumbing -------------------------------------------------------------------------------

  private async call<T>(method: string, path: string, opts: CallOpts = {}): Promise<T> {
    return this.unwrap<T>(await this.raw(method, path, opts));
  }

  private raw(method: string, path: string, opts: CallOpts): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.appKeys) {
      if (this.o.publicKey) headers["Public-Key"] = this.o.publicKey;
      if (this.o.privateKey) headers["Private-Key"] = this.o.privateKey;
    }
    return this.f(`${this.base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  private async unwrap<T>(res: Response): Promise<T> {
    let json: Envelope<T> | undefined;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      json = undefined;
    }
    if (!res.ok || json?.status === "error") {
      const retry = Number(res.headers.get("Retry-After"));
      throw new MandalaError(errorText(json, res.status), res.status, json?.error_code ?? json?.error, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return (json && "data" in json ? json.data : json) as T;
  }
}

interface CallOpts {
  token?: string;
  appKeys?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
}

/** HubID has a few error shapes (envelope, `{error}`, `{message}`); turn any of them into one line. */
function errorText(json: Envelope<unknown> | undefined, status: number): string {
  if (!json) return `HubID answered ${status}`;
  const errs = json.errors;
  if (Array.isArray(errs) && errs.length) return errs.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ");
  if (errs && typeof errs === "object") {
    const flat = Object.values(errs as Record<string, unknown>).flat();
    if (flat.length) return flat.map(String).join("; ");
  }
  return json.message ?? json.error ?? json.error_code ?? `HubID answered ${status}`;
}
