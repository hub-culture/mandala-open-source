import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { credentialFrom } from "./auth.js";
import { depsFromEnv } from "./config.js";
import { buildServer } from "./tools.js";

/**
 * Local use (Claude Desktop, Claude Code, OpenClaw): the agent's key comes from MANDALA_AGENT_KEY.
 * Still needs the HubID app keys, so this is for Hub Culture's own hosts and partners, not end users;
 * end users connect to the remote server instead.
 */
const key = process.env.MANDALA_AGENT_KEY;
const server = buildServer(depsFromEnv(), credentialFrom(key ? `Bearer ${key}` : undefined));
await server.connect(new StdioServerTransport());
