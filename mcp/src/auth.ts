import { createHash } from "node:crypto";
import { MandalaError, type MandalaClient } from "./mandala.js";

/**
 * Who is calling the MCP server.
 *
 * A connected agent presents its Mandala key (`magk_…`) as a bearer credential, the way any MCP
 * client sends an API key. Mandala session tokens are only accepted for 60 minutes on `/mandala/v1`,
 * so the server trades the key for a token and keeps it for 50 minutes. The key itself is never
 * stored: the cache is keyed by its SHA-256.
 *
 * A raw Mandala JWT is also accepted as the bearer, for agents that already hold one.
 */
export type Credential = { kind: "key"; key: string } | { kind: "token"; token: string } | { kind: "none" };

const KEY_PATTERN = /^magk_[0-9a-f]{48}$/;
const TOKEN_TTL_MS = 50 * 60 * 1000;

export function credentialFrom(authorization: string | undefined | null): Credential {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!m) return { kind: "none" };
  const value = m[1]!;
  if (KEY_PATTERN.test(value)) return { kind: "key", key: value };
  if (value.split(".").length === 3) return { kind: "token", token: value };
  return { kind: "none" };
}

export class TokenCache {
  private readonly tokens = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly mandala: MandalaClient,
    private readonly now: () => number = Date.now,
  ) {}

  /** A token for this credential, or null when the caller hasn't connected an agent. */
  async tokenFor(c: Credential): Promise<string | null> {
    if (c.kind === "none") return null;
    if (c.kind === "token") return c.token;
    const id = createHash("sha256").update(c.key).digest("hex");
    const hit = this.tokens.get(id);
    if (hit && hit.until > this.now()) return hit.token;
    const { token } = await this.mandala.exchangeKey(c.key);
    this.tokens.set(id, { token, until: this.now() + TOKEN_TTL_MS });
    if (this.tokens.size > 10_000) this.prune();
    return token;
  }

  /** Forget a token HubID has refused (revoked key, stale session), so the next call re-exchanges. */
  forget(c: Credential): void {
    if (c.kind === "key") this.tokens.delete(createHash("sha256").update(c.key).digest("hex"));
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.tokens) if (v.until <= now) this.tokens.delete(k);
  }
}

export function isAuthFailure(e: unknown): boolean {
  return e instanceof MandalaError && e.status === 401;
}
