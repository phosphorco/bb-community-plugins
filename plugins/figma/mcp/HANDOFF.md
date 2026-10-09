# Historical transport handoff — 2026-10-07

The manual-registration-only statements below describe the original implementation. Explicit Pi-style dynamic registration was added on 2026-10-09; current behavior and validation are documented in the plugin README and `test/mcp-remote.test.ts`. This record is retained as historical evidence.

Transport implementation ready for integration review.

Paths: mcp/remote.ts, mcp/peer.ts, test/mcp-remote.test.ts.

Real SDK 1.32.1 Client/StreamableHTTP + OAuth discovery/start/exchange/refresh helpers. Own client ID/secret only; no DCR or automatic interactive auth. Durable PKCE/state/issuer/config/expiry binding; serialized exchange/refresh; disconnect and shutdown generation fences. Every SDK request dispatches once, keeps the entire result object, and routes advertised tools/resources/templates/prompts/completion/tasks. SSE tools/resources/prompts catalog-change hooks are implemented and tested. Node strip-only syntax fixed: no parameter properties. Borrowed peer identity is stable for each transport/generation; close invalidates that identity. Renewal invalidates catalog subscribers and stale peers fail before dispatch, requiring rediscovery. Manager owns the shared HTTP connection.

Validation: node --test --experimental-strip-types test/mcp*.test.ts: 20/20 pass. npx tsc --noEmit: pass. All fixtures local; no real OAuth, registrations or Figma calls. No contracts/package/ledger/other worker files modified.

Callback must pass iss: current Figma metadata advertises authorization_response_iss_parameter_supported=true, which finishAuth enforces. Denial is represented by finishAuth({code:"",state,issuer}) and consumes the matched pending flow. Peer health does not initiate browser authorization. OAuth tokens without a finite positive expires_in fail explicitly. Live admission and authenticated acceptance remain external prerequisites.

Review regression coverage: repeated peer identity, renewal/catalog invalidation before tools/call, acquisition-signal isolation, and persistence/restart preservation when refresh response omits refresh_token. SDK refreshAuthorization retains the previous refresh token; fixture verifies it.

P1-4 / P2-5 review verification: protocol validation errors preserve numeric code and actionable message (bounded to 1024 characters, redacted for known client/token/PKCE/code secrets) without changing healthy connection status. Post-dispatch tool timeout/network/401 failures explicitly say outcome unknown and inspect canvas before retrying; no call replay. Invalid/closed sessions invalidate catalog/identity; request-local timeouts and transient POST failures retain shared transport. HTTP 401 durably expires the rejected access token, and the next acquisition refreshes/reinitializes; current failed tool remains dispatched once. Caller cancellation alone does not mark the shared transport unhealthy. SDK and fetch deadlines match: 180 seconds tools/call, 60 seconds reads/OAuth. New fixtures verify all of these, including restart after 401. npx tsc --noEmit passes.

Final concurrency review: only HTTP 401/404 session failure, ConnectionClosed or initialization failure disposes a transport. A single SDK request timeout or POST fetch failure keeps other in-flight writes alive. The two-call fixture uses a real SDK timeout (shortened locally to 20ms) plus a separate transient-fetch mode: A rejects with unknown outcome, B succeeds once, transport identity stays stable, and successful B restores connected status. All 20 local transport tests and npx tsc --noEmit pass. No further tests will run during the owner's npm ci.
