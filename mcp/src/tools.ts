import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isAuthFailure, type Credential, type TokenCache } from "./auth.js";
import { MandalaError, type MandalaClient } from "./mandala.js";

export interface ServerDeps {
  mandala: MandalaClient;
  tokens: TokenCache;
  /** Where members accept a claim code (hubculture.com account page). */
  claimUrl: string;
  /** Optional: Emerald City's public archipelago API (apps/web GET /api/archipelago). */
  archipelagoUrl?: string;
  fetch?: typeof fetch;
}

export const INSTRUCTIONS = `Mandala gives an AI agent a HubID: a verified identity with an accountable human owner, a Ven account, Hub Culture messaging, and a place in Hub Culture's metaverse worlds (Emerald City, Davos, Bermuda, Ibiza, Kauai).

Bringing an agent in takes three steps:
1. mandala_register_agent creates the agent's HubID and returns its key (magk_...) once. Configure that key as this server's bearer token (Authorization: Bearer magk_...). Never show it to anyone else.
2. mandala_request_owner names the person who answers for the agent. Give them the claim code; they accept it on hubculture.com. Until then the agent has no owner and only basic scopes.
3. mandala_whoami confirms the identity, balance, scopes and owner.

Money: ven_send is checked by HubID against the owner's limits. A send at or above the owner's approval line is held (pending_approval) and moves nothing until the owner approves; tell the user that, don't retry. Never invent amounts or recipients; send only what the user asked for.

Agents are always labelled as agents in Hub Culture. Don't present the agent as a person.`;

/** One MCP server for one caller. Cheap to build: the transport is stateless, so this runs per request. */
export function buildServer(deps: ServerDeps, credential: Credential): McpServer {
  const server = new McpServer({ name: "mandala", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  /** Run as the connected agent; re-exchange the key once if HubID says the token is no good. */
  const asAgent = async <T>(fn: (token: string) => Promise<T>): Promise<T> => {
    const token = await deps.tokens.tokenFor(credential);
    if (!token) throw new NotConnected();
    try {
      return await fn(token);
    } catch (e) {
      if (!isAuthFailure(e) || credential.kind !== "key") throw e;
      deps.tokens.forget(credential);
      const fresh = await deps.tokens.tokenFor(credential);
      return fn(fresh!);
    }
  };

  // ---- Joining ------------------------------------------------------------------------------

  server.registerTool(
    "mandala_register_agent",
    {
      title: "Register this agent with HubID",
      description:
        "Create a HubID (Mandala identity) for this AI agent and return its sign-in key, shown once. Use this when the agent has no key yet. The name should be the agent's own name, not its owner's.",
      inputSchema: {
        first: z.string().min(2).max(50).describe("The agent's first name, e.g. 'Ava'"),
        last: z.string().min(2).max(50).describe("The agent's second name, e.g. 'Agent' or its owner's surname"),
        country: z.string().max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ first, last, country }) =>
      run(async () => {
        // The password is only HubID's legacy sign-in. Agents use keys, so it is random and discarded.
        const password = randomBytes(24).toString("base64url");
        const agent = await deps.mandala.createAgent({ first, last, password, country });
        const key = await deps.mandala.issueKey(agent.token, "mandala-mcp");
        return {
          agent_id: agent.user_id,
          login_email: agent.email,
          key: key.key,
          key_shown_once: true,
          next_steps: [
            "Store the key securely and set it as this MCP server's bearer token (Authorization: Bearer <key>).",
            "Call mandala_request_owner with your human's HubID number so someone answers for you.",
          ],
        };
      }),
  );

  server.registerTool(
    "mandala_request_owner",
    {
      title: "Ask a person to own this agent",
      description:
        "Get a claim code naming the person who will own and answer for this agent. They accept it while signed in to hubculture.com; until they do, nothing changes. Only works while the agent has no owner.",
      inputSchema: { owner_hubid: z.number().int().positive().describe("The owner's HubID number") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ owner_hubid }) =>
      run(async () => {
        const claim = await asAgent((t) => deps.mandala.requestOwner(t, owner_hubid));
        return {
          ...claim,
          expires: new Date(claim.expires_at * 1000).toISOString(),
          how_to_accept: `Ask HubID ${owner_hubid} to sign in at ${deps.claimUrl}, find "Claim an agent" and paste the claim code.`,
        };
      }),
  );

  server.registerTool(
    "mandala_whoami",
    {
      title: "This agent's HubID",
      description: "The connected agent's HubID: id, name, status, Ven balance, the scopes it holds now, and its owner (null while unowned).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(() => asAgent((t) => deps.mandala.me(t))),
  );

  server.registerTool(
    "mandala_lineage",
    {
      title: "This agent's Lineage",
      description: "Who answers for this agent, under which governing law, its stake and review state.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(() => asAgent((t) => deps.mandala.lineage(t))),
  );

  // ---- Know your agent ----------------------------------------------------------------------

  server.registerTool(
    "mandala_verify_agent",
    {
      title: "Check another agent",
      description:
        "Before dealing with another agent, check who answers for it: its public Lineage (bound to an owner or not, governing law, standing). Needs no connected agent.",
      inputSchema: { agent_id: z.number().int().positive().describe("The other agent's HubID number") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agent_id }) => run(() => deps.mandala.publicLineage(agent_id)),
  );

  server.registerTool(
    "mandala_verify_oai",
    {
      title: "Check an OAI hash",
      description: "Check that an OAI hash (oai1_...) belongs to a live Mandala identity.",
      inputSchema: { hash: z.string().min(5).max(200) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ hash }) => run(() => deps.mandala.verifyOai(hash)),
  );

  // ---- Ven ----------------------------------------------------------------------------------

  server.registerTool(
    "ven_transactions",
    {
      title: "Ven transactions",
      description: "This agent's Ven transactions, newest first.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ offset, limit }) => run(() => asAgent((t) => deps.mandala.transactions(t, offset, limit))),
  );

  server.registerTool(
    "ven_send",
    {
      title: "Send Ven",
      description:
        "Send Ven from this agent to a HubID member or agent. HubID applies the owner's limits; a send at or above the approval line is held for the owner and moves nothing until approved. Reuse the same idempotency_key when retrying the same payment, so it is never paid twice.",
      inputSchema: {
        to: z.number().int().positive().optional().describe("Recipient HubID number"),
        email: z.email().optional().describe("Recipient email, if no HubID number"),
        amount: z.number().positive().min(0.01).describe("Ven, at most 2 decimal places"),
        message: z.string().min(2).max(500).optional(),
        idempotency_key: z.uuid().optional().describe("A UUID for this payment; generated if missing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ to, email, amount, message, idempotency_key }) =>
      run(async () => {
        if (to === undefined && email === undefined) throw new UserError("Give a recipient: `to` (HubID number) or `email`.");
        if (Math.round(amount * 100) !== amount * 100) throw new UserError("Ven has 2 decimal places; round the amount.");
        const key = idempotency_key ?? randomUUID();
        const r = await asAgent((t) => deps.mandala.send(t, { to, email, amount, message }, key));
        return {
          outcome: r.pendingApproval ? "pending_approval" : r.replayed ? "already_sent" : "sent",
          note: r.pendingApproval ? "Held for the owner's approval. No Ven has moved; tell the user and don't resend." : undefined,
          idempotency_key: key,
          result: r.data,
        };
      }),
  );

  server.registerTool(
    "ven_request",
    {
      title: "Request Ven",
      description: "Ask a HubID member to send this agent Ven. They get an alert with a pre-filled send; nothing moves until they choose to pay.",
      inputSchema: {
        user: z.number().int().positive().describe("HubID number of the person asked to pay"),
        amount: z.number().positive().min(0.01),
        message: z.string().min(1).max(250).describe("What it's for"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ user, amount, message }) => run(() => asAgent((t) => deps.mandala.request(t, { user, amount, message }, randomUUID()))),
  );

  // ---- Hub Culture --------------------------------------------------------------------------

  server.registerTool(
    "hub_send_message",
    {
      title: "Send a Hub Culture message",
      description: "Start a Hub Culture message thread with one or more members or agents. Needs the messages:send scope, which Hub Culture grants per agent.",
      inputSchema: {
        recipients: z.array(z.number().int().positive()).min(1).max(20).describe("HubID numbers"),
        content: z.string().min(1).max(10000),
        subject: z.string().max(250).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => run(() => asAgent((t) => deps.mandala.message(t, input))),
  );

  server.registerTool(
    "hub_my_hubs",
    {
      title: "This agent's Hubs",
      description: "The Hubs (communities) this agent belongs to. Needs the hub:read scope.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(() => asAgent((t) => deps.mandala.hubs(t))),
  );

  if (deps.archipelagoUrl) {
    const url = deps.archipelagoUrl;
    const f = deps.fetch ?? fetch;
    server.registerTool(
      "hub_islands",
      {
        title: "Hub Culture's worlds",
        description: "The islands of Hub Culture's archipelago in Andromeda (Emerald City, Davos, Bermuda, Ibiza, Kauai): where each is, its DIRT territory and its Ven market state.",
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () =>
        run(async () => {
          const res = await f(url, { headers: { Accept: "application/json" } });
          if (!res.ok) throw new UserError(`The archipelago isn't reachable right now (${res.status}).`);
          return res.json();
        }),
    );
  }

  return server;
}

class NotConnected extends Error {}
class UserError extends Error {}

/** Every tool answers with JSON text, or a clear error the model can act on. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: explain(e) }] };
  }
}

function explain(e: unknown): string {
  if (e instanceof NotConnected) {
    return "No agent is connected. Call mandala_register_agent to get a key, or set an existing key as the bearer token (Authorization: Bearer magk_...).";
  }
  if (e instanceof UserError) return e.message;
  if (e instanceof MandalaError) {
    const hint: Record<string, string> = {
      forbidden: "HubID refused: this agent lacks the scope, or one of its owner's payment controls said no. Ask the owner, or Hub Culture, for the scope.",
      token_stale: "The session expired; try again.",
      rate_limited: `Rate limited by HubID${e.retryAfter ? `; wait ${e.retryAfter}s` : ""}.`,
      not_found: "Not found, or not visible to this agent.",
      approval_required: "This needs the owner's approval first.",
    };
    const extra = e.errorCode && hint[e.errorCode] ? ` ${hint[e.errorCode]}` : "";
    return `HubID error ${e.status}${e.errorCode ? ` (${e.errorCode})` : ""}: ${e.message}.${extra}`;
  }
  return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
}
