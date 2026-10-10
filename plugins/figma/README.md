# Figma for BB

One settings page manages a shared connection to the [official Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/) for design reads and edits. [Figmog](https://github.com/sanctuarycomputer/figmog) is an optional cache for repeated reads. Neither figmog nor a local Figma desktop installation is required for the official connection.

## Setup

Install on the BB server through BB's normal plugin manager:

```sh
bb plugin install git:https://github.com/phosphorco/bb-community-plugins.git --plugin figma
```

BB selects the `figma` entry from the repository's plugin collection, installs its runtime dependencies and builds its native server/settings surfaces. This Git installation does not require an npm release, a copy of this workspace, or machine-specific source paths. Use **Installed plugins → Figma** to manage it; the plugin is not yet published as a BB Community catalog entry.

Install once per BB deployment. Agents on its enrolled machines call the server-owned plugin through BB's normal tool bridge and share that deployment's sign-in. They do not install this plugin, figmog or Codex separately, and Figma credentials never travel to those machines. An independent BB deployment installs the plugin and signs in separately; authorization is not copied between deployments.

Open **Settings → Installed plugins → Figma**, or `/settings/plugins/figma`. Connections are shared: every agent using this deployment acts through the configured Figma accounts.

The optional cache is **off by default**, including existing configurations without an explicit preference. To use it, expand **Read cache** and enable **Cache reads with figmog**, supply a read token, and save. Settings detects an executable on the BB host's PATH when the path is `figmog`, or checks your configured absolute path. Missing installations show an upstream installation link; agents use the official connection instead. No installation is required on each user's computer. Automatic installation is deferred; the plugin does not bundle or download figmog. The current inspected release is v0.0.2; its Linux binary needs glibc 2.39 or later.

Expand **Read cache**, supply a file URL and use **Test read** to check actual cache access. Merely starting figmog does not validate a token. Turning the cache off retains the saved token and stops its process. Re-enabling uses a fresh cache so data that missed edits while disabled is not reused; old cache generations remain isolated on disk. **Remove read token** also removes the saved token.

For official tools, click **Connect Figma** and follow the authorization link. Connect uses Codex-compatible registration metadata (`client_name: "Codex"`) and MCP identifiers (`codex-mcp-client`, title `Codex`, version `0.160.1`). BB implements OAuth and Streamable HTTP directly and stores the issued client credentials, access token and refresh token privately. No Codex executable, app-server, agent, or Codex credential store is involved. Figma rejects a public HTTPS redirect for this native client profile (`invalid_redirect_uri`), so its default callback matches the working native flow:

```text
http://127.0.0.1:38559/callback
```

After approving in Figma, copy the address from your browser into the visible **Callback URL** field and click **Finish sign-in**. The localhost page can fail to load on a remote BB deployment; the address still contains the authorization result. BB verifies the callback origin/path, state and issuer, then exchanges the code itself. Callback input is transient and never logged or stored as configuration. If Figma supplies a pre-registered MCP client, enter both its ID and secret under **Advanced** to skip automatic registration. **Use automatic registration** clears that override and disconnects the official session; it does not change your read token. Registration runs only from an explicit Connect action, never from a health check or agent call.

Pending consent survives closing settings or reloading the plugin: reopen settings and paste the original callback without starting another Connect. A malformed copied address can be corrected before submission. Once a matching callback is consumed, an expired/denied/failed exchange requires a new Connect flow. If the token exchange succeeded but MCP initialization failed, authorization remains saved: use **Test Figma** instead of submitting the callback again. Successful sign-in moves keyboard focus to the connection result. **Test Figma** checks the connection and account identity; **Test read** uses the file URL to check optional cache access.

The registration identifiers follow the working Codex/Pi flow. This is a compatibility profile, not a Figma-issued BB integration. A rejected registration is reported with its HTTP status; no alternative names or automatic registration retries are attempted. The loopback callback is used consistently in registration, consent and token exchange. A preregistered override can instead use this deployment's HTTPS `/api/v1/plugins/figma/http/oauth/callback` for automatic completion. Figma still controls account/seat entitlements and edit permission; the actual authenticated catalog determines available tools. A REST read token is separate from MCP OAuth.

Secrets are write-only in the UI and stored in atomic mode-0600 files in this plugin's private connection directory. Disconnecting reads removes the token and closes its process. Disconnecting official Figma removes its BB-owned tokens, pending consent and dynamically issued registration. Existing Codex credentials are untouched. Upgrading from the retired Codex handoff keeps the read token and cache preferences but requires a new BB-owned Figma sign-in. A manually supplied client override remains configured. Credential replacement isolates the previous mirror cache.

Connections open lazily after a BB restart. Settings restores pending consent and saved-grant presence without network requests. **Test Figma** or the next agent call resumes saved authorization; **Connect Figma** reuses an existing registration and starts a new consent flow. A reconnect preserves the current grant until replacement authorization succeeds. A disconnected process status with saved authorization does not mean the credentials were removed. A rejected refresh grant is retired; subsequent agent calls require Connect instead of repeatedly submitting the same rejected token.

## Tools

`figma_discover` returns live upstream descriptors, including their exact schemas and annotations. `figma_call` invokes an original tool on a selected connection. `figma_mcp` accesses supporting advertised MCP operations, including resources/templates/read, prompts and completion/task methods when available. These three tools default to the official connection; select `source: "mirror"` only for an enabled, available cache. Agents choose the corresponding official read tool if the optional cache is unavailable; the plugin does not rewrite incompatible tool schemas or replay calls. `figma_sync` refreshes a mirrored file; its explicit `acceptUnverified` option allows recovery from a pending/no-op/uncertain write after inspection, without claiming that edit is visible.

Native activity rows use BB's standard tool presentation, with readable Figma operation labels and the plugin icon. Existing tool names remain stable: `figma_discover`, `figma_call`, `figma_mcp`, `figma_sync` and the upstream `figma_*` aliases.

BB also exposes the same validated handlers through its native CLI, including on enrolled machines whose existing provider session has an older tool list:

```sh
bb figma discover --json
bb figma call whoami --json
bb figma mcp resources/read --arguments '{"uri":"skill://index.json"}' --json
```

Use the discovered upstream schema for arguments. For long code/JSON, pipe a local file through `--arguments-stdin`; BB reads stdin on the invoking machine before forwarding the request. `bb figma --help` documents all operations. CLI calls use the same cancellation, schema validation, result adaptation and write cleanup as agent tools, and do not retry writes. BB's CLI output limit also applies; use native agent tools for results that exceed it. No diagnostic shell script or local executable is part of this interface.

All discovered tools can receive native aliases: mirror tools keep their `figmog_*` names; official tools use `figma_*`, including `figma_use_figma`. Name collisions, recursive schemas and changed schemas retain the generic call path. BB applies native tool changes when a provider session is next constructed. Reload the plugin and start a new provider session when settings says shortcuts need refreshing; the generic tools do not require that refresh.

The adapter preserves text and images natively. BB's native tool surface does not accept every MCP content type, so other content, structured results and metadata are preserved as labeled JSON text. Resource URIs remain usable through resource-read operations. The plugin does not silently drop large results; bounded limits report an explicit error.

Argument validation defaults to JSON Schema 2020-12 and also supports an explicitly declared draft-07 schema. Discovery reports when a dialect/reference cannot be validated locally; those arguments remain upstream-authoritative rather than being rejected under the wrong dialect. Output schemas and structured results are preserved without local output validation.

This is a bridge to client-initiated MCP operations. It does not advertise client-side sampling or interactive elicitation, and does not automatically approve server requests or charges. Resource subscription notifications are not pushed into an agent conversation; read resources explicitly. If an upstream tool requires an unsupported client capability, its limitation remains visible. Task creation does not establish write completion: inspect the task's terminal result before explicitly recovering its pending cache.

## Freshness and lifecycle

One managed figmog process owns each connection's cache, shared by concurrent agents. It runs with its desktop proxy disabled because the official remote MCP connection is separate. The plugin persists mirror bookkeeping across process restarts and fences old work on credential changes.

Possible official writes persist active tickets and mark mirrors pending before dispatch. Cached reads wait until active writes finish and a refresh observes a changed version. Version changes are a heuristic: they do not prove that a particular edit is visible. Concurrent or uncertain writes may require explicit recovery. After inspecting the official canvas, use `figma_sync` with `acceptUnverified: true`, or the corresponding settings checkbox, to accept a successful full pull as the new baseline. Its disclosure states that the prior edit remains unverified. A read-only `use_figma` call or a no-op can also require this recovery because arbitrary JavaScript cannot safely be classified by the adapter. A successful write remains successful even if cache bookkeeping fails. Neither the plugin nor its transport automatically replays an uncertain write.

The official connection uses the upstream TypeScript MCP SDK for OAuth, explicit dynamic client registration and Streamable HTTP. The settings page owns sign-in; the MCP transport cannot initiate authorization or replay a failed tool call. No model request is required to connect or inspect the tool catalog.

Token renewal retires the old catalog while allowing already-dispatched requests to finish under their existing deadlines. Cancellation, disconnect or reload after dispatch reports an unknown write outcome and requires canvas inspection before retry. Internal/custom JSON-RPC tool failures receive the same guidance; clear framing/method/argument errors retain their actionable error. Connection health can recover after another successful request, but that does not resolve an earlier unknown tool outcome. With the optional cache off, the plugin has no durable write-ticket journal; retain the reported outcome and inspect the canvas after an interrupted operation. Reload drains cache-ticket cleanup before replacing its manager.

The current write fence conservatively blocks cached reads across files while any tracked write is active. An unseen target has no cached bytes to invalidate; its first mirror pull can still observe ordinary REST lag. Mirror requests have a bounded 60-second budget, including queue time, so particularly large first pulls may time out. These limits require live validation with the intended files and account.

## Development and verification

Use BB 0.44 or later. Types are pinned to Plugin SDK 0.5.29; native loading and CLI invocation are also verified on the 0.6.29 host SDK. The manifest declares these two supported SDK ranges. The build honors `BB_CLI`; outside a BB thread, set it to the absolute path of the matching BB executable so the monorepo's older development CLI is not selected.

```sh
npm run test --workspace @phosphorco/bb-plugin-figma
npm run typecheck --workspace @phosphorco/bb-plugin-figma
npm run build --workspace @phosphorco/bb-plugin-figma
```

For in-place workspace development only, build the Figma directory and install that local path:

```sh
bb plugin build ./community-plugins/plugins/figma
bb plugin install ./community-plugins/plugins/figma
```

Tests cover local fixtures and injected transport/lifecycle boundaries. They do not establish live Figma admission, token scopes, seat entitlement or successful design edits. The workspace execution plan and evidence ledger track that separate acceptance.

## Upstream attribution

This MIT-licensed plugin calls existing external tools. Figmog is authored by Sanctuary Computer; current source declares AGPL-3.0-only and documents unresolved licensing for its embedded fold dependency. Use its separately obtained executable under its own terms. No figmog or fold binary/source is redistributed in this plugin. The runtime dependency `@modelcontextprotocol/sdk` retains its own MIT license. Figma's server, schemas and content remain provided by Figma.

The explicit registration flow follows [DianP/pi-figma-remote-auth](https://github.com/DianP/pi-figma-remote-auth/tree/4e407d63fb26f378140d13e4c69da262fe3926ce) (MIT): discover endpoints, register, use PKCE/browser consent, and retain the issued secret for token exchange. BB uses its existing SDK, deployment callback and private store instead of Pi's local callback listener and adapter files. BB uses the same Codex registration name. The MCP client identifiers match [Codex rust-v0.160.1](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/codex-mcp/src/rmcp_client.rs). See [third-party notices](THIRD_PARTY_NOTICES.md).
