import { TokenCache } from "./auth.js";
import { MandalaClient } from "./mandala.js";
import type { ServerDeps } from "./tools.js";

/** Server settings from the environment. HUBID_* keys are app secrets: server-side only. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const mandala = new MandalaClient({
    baseUrl: env.HUBID_API_URL ?? "https://id.hubculture.com",
    publicKey: env.HUBID_PUBLIC_KEY,
    privateKey: env.HUBID_PRIVATE_KEY,
  });
  return {
    mandala,
    tokens: new TokenCache(mandala),
    claimUrl: env.MANDALA_CLAIM_URL ?? "https://hubculture.com/account/details",
    archipelagoUrl: env.ARCHIPELAGO_URL || undefined,
  };
}
