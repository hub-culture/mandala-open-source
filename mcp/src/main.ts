import { depsFromEnv } from "./config.js";
import { createHttpServer } from "./http.js";

const port = Number(process.env.PORT ?? 8795);
createHttpServer(depsFromEnv()).listen(port, () => {
  console.log(`Mandala MCP listening on :${port}/mcp`);
});
