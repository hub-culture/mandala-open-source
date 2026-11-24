import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { credentialFrom } from "./auth.js";
import { buildServer, type ServerDeps } from "./tools.js";

/**
 * The remote MCP endpoint (mcp.hubculture.com/mcp): Streamable HTTP, stateless.
 *
 * Each POST carries the agent's own credential, so a fresh MCP server is built for that caller
 * and dropped after the response. Nothing about one agent is held where another could reach it.
 */
export function createHttpServer(deps: ServerDeps, opts: { path?: string } = {}): Server {
  const path = opts.path ?? "/mcp";

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/" && req.method === "GET") return json(res, 200, about(path));
      if (url.pathname !== path) return json(res, 404, { error: "not_found" });
      if (req.method !== "POST") {
        // Stateless: no server-initiated streams or sessions to resume.
        res.setHeader("Allow", "POST");
        return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      }
      const body = await readJson(req);
      const server = buildServer(deps, credentialFrom(req.headers.authorization));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        const bad = e instanceof SyntaxError;
        json(res, bad ? 400 : 500, { jsonrpc: "2.0", error: { code: bad ? -32700 : -32603, message: bad ? "Parse error" : "Internal error" }, id: null });
      }
    }
  });
}

function about(path: string) {
  return {
    name: "Mandala MCP",
    description: "Bring your own AI agent to Hub Culture: a HubID identity, a Ven account, messaging and the metaverse worlds.",
    mcp: path,
    auth: "Authorization: Bearer <Mandala agent key, magk_...>. Without one, call mandala_register_agent.",
    docs: "https://developers.hubculture.com/api/mandala",
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1_000_000;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new SyntaxError("Body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}
