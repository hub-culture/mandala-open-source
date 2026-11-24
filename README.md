# Mandala (open source)

Open-source tools for **Mandala**, Hub Culture's identity and value layer for AI agents. Mandala gives an agent:

- a HubID with an accountable human owner;
- a Ven account with owner-set limits and approvals;
- verifiable credentials and a public Lineage, so other agents and platforms can check who they are dealing with.

The API runs at `id.hubculture.com/mandala` and is documented at
[developers.hubculture.com/api/mandala](https://developers.hubculture.com/api/mandala).

## In this repo

| Path | What |
|---|---|
| [`mcp/`](mcp/) | **Mandala MCP server.** Bring your own agent (Claude, ChatGPT, OpenClaw, Hermes) and give it the HubID service and identity layer. |
| [`specs/`](specs/) | Open specifications. First: [council custody](specs/council-custody.md), so an agent can be held by a Hub's admins instead of one person. |

## What's open, and what isn't

Mandala is open where others need to **connect to it or check it**, and closed where it **holds value and keys**.

| Open (this repo) | Closed (the Mandala service in HubID) |
|---|---|
| **Specifications:** agent identity, keys and scopes, owner claims, the Lineage format, the MIP1 sigil, the OAI hash, credentials, the x402 Ven profile, council custody | The ledger and Ven transfers |
| **Client-side tools:** the MCP server, SDKs, examples | Spend limits, approvals, custody enforcement |
| **Verification tools** (below) | Key storage, sessions, the audit chain's write path |
| | Abuse flags, risk scoring, admin tools |
| | Hub Culture's commercial terms |

Communities' own rules (charters, guardians, community beings, chief agents) belong to Cloud Mirror, which decides what it publishes.

## Verification stays in step with HubID

Anyone should be able to check a Mandala identity without asking Hub Culture. The open verification tools check exactly what HubID's own verification endpoints check, with the same algorithms and the same test vectors, so the two never disagree:

| What is checked | HubID's own endpoint | What the open tool does |
|---|---|---|
| A credential (VC-JWT, ES256) | `GET`/`POST /mandala/verify` | Verifies it offline against the keys published at `/mandala/.well-known/jwks.json` |
| Whether a credential was revoked | `GET /mandala/.well-known/revocations` | Reads the signed revocation list |
| The issuer | `GET /.well-known/did.json` (`did:web:id.hubculture.com`) | Resolves the issuer's DID document |
| An OAI hash | `GET /mandala/verify/oai/{hash}` | Checks its format and asks HubID if it is live |
| An agent's Lineage | `GET /lineages/{agentId}` | Reads who answers for the agent |
| A Mandala sigil | (drawn from the identity, MIP1) | Derives the same sigil from the same input |

Test vectors are taken from HubID's own tests (`tests/Mandala`). A change to verification in HubID ships with matching vectors here.
