import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { credentialFrom, TokenCache } from "./auth.js";
import { createHttpServer } from "./http.js";
import { MandalaClient } from "./mandala.js";
import { buildServer, type ServerDeps } from "./tools.js";

const KEY = `magk_${"ab".repeat(24)}`;

/** A fake HubID that answers the Mandala routes the server uses, and records every call. */
function fakeHubId() {
  const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  let tokenN = 0;
  const state = { sendStatus: 200, meFails: 0 };
  const env = (data: unknown, code = 200) =>
    new Response(JSON.stringify({ status: "success", errors: [], data, code }), { status: code, headers: { "Content-Type": "application/json" } });
  const fail = (code: number, error_code: string, msg: string) =>
    new Response(JSON.stringify({ status: "error", errors: [msg], data: null, code, error_code }), { status: code });

  const f: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, headers, body });
    const auth = headers.authorization;
    switch (`${init?.method ?? "GET"} ${u.pathname}`) {
      case "POST /mandala/agent":
        return env({ token: "a.b.new", user_id: 7001, email: "ava-agent-7001-mandala@hubculture.com" });
      case "POST /mandala/key/token":
        if (body.key !== KEY) return fail(401, "invalid_request", "Invalid or revoked key.");
        return env({ token: `t.o.${++tokenN}`, user_id: 7001, email: "x" });
      case "POST /mandala/v1/agent-keys":
        return env({ id: 1, label: body.label, prefix: "magk_abab", expires_at: null, key: KEY });
      case "GET /mandala/v1/me":
        if (state.meFails > 0) {
          state.meFails--;
          return fail(401, "token_stale", "Token is stale");
        }
        return env({ id: 7001, type: "hub_user", status: "active", name: "Ava Agent", ven_balance: 12.5, scopes: ["identity:read", "ven:read"], owner_hubid: null, auth });
      case "POST /mandala/v1/owner-claims":
        return env({ claim_code: "v1.7001.42.1800000000.sig", owner_hubid: body.owner_hubid, expires_at: 1800000000 });
      case "POST /mandala/send":
        if (state.sendStatus === 202) return env({ status: "pending_approval", approval_id: 9 }, 202);
        if (state.sendStatus === 403) return fail(403, "forbidden", "Forbidden");
        return env({ transaction_id: 555 });
      case "GET /lineages/42":
        return env({ agent_id: 42, bound: true, governing_law: "BM" });
      default:
        return fail(404, "not_found", "Not Found");
    }
  };
  return { f, calls, state };
}

function deps(f: typeof fetch): ServerDeps {
  const mandala = new MandalaClient({ baseUrl: "https://id.test", publicKey: "pub", privateKey: "priv", fetch: f });
  return { mandala, tokens: new TokenCache(mandala), claimUrl: "https://hub.test/account/details" };
}

async function connect(d: ServerDeps, authorization?: string) {
  const server = buildServer(d, credentialFrom(authorization));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

const text = (r: any) => (r.content[0] as { text: string }).text;
const parsed = (r: any) => JSON.parse(text(r));

describe("Mandala MCP", () => {
  it("lists the tools, with money marked destructive", async () => {
    const c = await connect(deps(fakeHubId().f));
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["mandala_register_agent", "mandala_request_owner", "mandala_whoami", "mandala_verify_agent", "ven_send", "ven_request", "hub_send_message"]));
    expect(names).not.toContain("hub_islands"); // only with ARCHIPELAGO_URL
    expect(tools.find((t) => t.name === "ven_send")?.annotations?.destructiveHint).toBe(true);
  });

  it("registers a new agent and hands back its key once; the password never leaves", async () => {
    const hub = fakeHubId();
    const c = await connect(deps(hub.f));
    const out = parsed(await c.callTool({ name: "mandala_register_agent", arguments: { first: "Ava", last: "Agent" } }));
    expect(out).toMatchObject({ agent_id: 7001, key: KEY, key_shown_once: true });
    expect(JSON.stringify(out)).not.toContain(hub.calls[0]!.body.password);
    expect(hub.calls[0]!.body.password.length).toBeGreaterThanOrEqual(12);
    // the new key was issued with the new agent's token and the app keys
    expect(hub.calls[1]).toMatchObject({ path: "/mandala/v1/agent-keys", headers: { authorization: "Bearer a.b.new", "private-key": "priv" } });
  });

  it("refuses agent tools when no agent is connected", async () => {
    const c = await connect(deps(fakeHubId().f));
    const r = await c.callTool({ name: "mandala_whoami", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/mandala_register_agent/);
  });

  it("trades the key for a token once and reuses it", async () => {
    const hub = fakeHubId();
    const d = deps(hub.f);
    const c = await connect(d, `Bearer ${KEY}`);
    await c.callTool({ name: "mandala_whoami", arguments: {} });
    const me = parsed(await c.callTool({ name: "mandala_whoami", arguments: {} }));
    expect(me.auth).toBe("Bearer t.o.1");
    expect(hub.calls.filter((x) => x.path === "/mandala/key/token")).toHaveLength(1);
  });

  it("re-exchanges the key once when HubID says the token is stale", async () => {
    const hub = fakeHubId();
    hub.state.meFails = 1;
    const c = await connect(deps(hub.f), `Bearer ${KEY}`);
    const me = parsed(await c.callTool({ name: "mandala_whoami", arguments: {} }));
    expect(me.auth).toBe("Bearer t.o.2");
  });

  it("asks for an owner and says where they accept", async () => {
    const c = await connect(deps(fakeHubId().f), `Bearer ${KEY}`);
    const out = parsed(await c.callTool({ name: "mandala_request_owner", arguments: { owner_hubid: 42 } }));
    expect(out.claim_code).toMatch(/^v1\./);
    expect(out.how_to_accept).toContain("https://hub.test/account/details");
  });

  it("sends Ven with an idempotency key, and reports a held send as pending, not sent", async () => {
    const hub = fakeHubId();
    const c = await connect(deps(hub.f), `Bearer ${KEY}`);
    const sent = parsed(await c.callTool({ name: "ven_send", arguments: { to: 42, amount: 5 } }));
    expect(sent.outcome).toBe("sent");
    const send = hub.calls.find((x) => x.path === "/mandala/send")!;
    expect(send.headers["idempotency-key"]).toBe(sent.idempotency_key);

    hub.state.sendStatus = 202;
    const held = parsed(await c.callTool({ name: "ven_send", arguments: { to: 42, amount: 500 } }));
    expect(held.outcome).toBe("pending_approval");
  });

  it("explains a refusal instead of failing silently", async () => {
    const hub = fakeHubId();
    hub.state.sendStatus = 403;
    const c = await connect(deps(hub.f), `Bearer ${KEY}`);
    const r = await c.callTool({ name: "ven_send", arguments: { to: 42, amount: 5 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/forbidden.*owner/s);
  });

  it("checks inputs before money moves", async () => {
    const hub = fakeHubId();
    const c = await connect(deps(hub.f), `Bearer ${KEY}`);
    expect(text(await c.callTool({ name: "ven_send", arguments: { amount: 5 } }))).toMatch(/recipient/);
    expect(text(await c.callTool({ name: "ven_send", arguments: { to: 42, amount: 1.234 } }))).toMatch(/2 decimal/);
    expect(hub.calls.some((x) => x.path === "/mandala/send")).toBe(false);
  });

  it("verifies another agent without a connected agent", async () => {
    const c = await connect(deps(fakeHubId().f));
    expect(parsed(await c.callTool({ name: "mandala_verify_agent", arguments: { agent_id: 42 } }))).toMatchObject({ bound: true });
  });
});

describe("over HTTP", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("serves MCP at /mcp with the caller's key as the bearer", async () => {
    const hub = fakeHubId();
    const http = createHttpServer(deps(hub.f));
    await new Promise<void>((r) => http.listen(0, r));
    close = () => http.close();
    const { port } = http.address() as AddressInfo;

    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }),
    );
    const me = parsed(await client.callTool({ name: "mandala_whoami", arguments: {} }));
    expect(me).toMatchObject({ id: 7001, name: "Ava Agent" });
    await client.close();

    const about = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { mcp: string };
    expect(about.mcp).toBe("/mcp");
  });
});
