# Figma for BB

One settings page manages a shared connection to the [official Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/) for design reads and edits. [Figmog](https://github.com/sanctuarycomputer/figmog) is an optional cache for repeated reads. Neither figmog nor a local Figma desktop installation is required for the official connection.

## Setup

Build and install this plugin from its canonical source directory:

```sh
npm run build --workspace @phosphorco/bb-plugin-figma
bb plugin install /home/ubuntu/bb/community-plugins/plugins/figma --yes
```

Open **Settings → Installed plugins → Figma**, or `/settings/plugins/figma`. Connections are shared: every agent using this deployment acts through the configured Figma accounts.

The optional cache is **off by default**, including existing configurations without an explicit preference. To use it, enable **Use figmog for cached reads**, supply a read token, and save. Settings detects an executable on the BB host's PATH when the path is `figmog`, or checks your configured absolute path. Missing installations show an upstream installation link; agents use the official connection instead. No installation is required on each user's computer. Automatic installation is deferred; the plugin does not bundle or download figmog. The current inspected release is v0.0.2; its Linux binary needs glibc 2.39 or later.

Supply a file URL and use **Test read** to check actual cache access. Merely starting figmog does not validate a token. Turning the cache off retains the saved token and stops its process. Re-enabling uses a fresh cache so data that missed edits while disabled is not reused; old cache generations remain isolated on disk. **Disconnect read** also removes the saved token.

For official tools, configure BB's own Figma MCP client ID, client secret and registered callback URL, then **Connect Figma** and follow the authorization link. The callback is:

```text
https://YOUR-BB-HOST/api/v1/plugins/figma/http/oauth/callback
```

The default uses BB's configured public app URL. Figma currently documents a client-admission process through its [MCP catalog](https://www.figma.com/mcp-catalog/). A REST personal access token does not replace MCP OAuth; an ordinary REST OAuth app is not proof of MCP admission. This plugin does not impersonate another client, extract agent credentials or silently register an application. For writes, Figma requires the applicable seat and edit permission for the target file. Live admission and entitlements must be tested with the actual account.

Secrets are write-only in the UI and stored in atomic mode-0600 files in this plugin's private connection directory. Disconnecting reads removes the token and closes its process. Disconnecting official Figma removes its authorization session while retaining the operator's client registration for a later connection. Credential replacement isolates the previous mirror cache.

Connections open lazily after a BB restart. **Test Figma** or the next agent call resumes saved authorization; **Connect Figma** starts a new consent flow. A disconnected process status after restart does not mean the saved credentials were removed.

## Tools

`figma_discover` returns live upstream descriptors, including their exact schemas and annotations. `figma_call` invokes an original tool on a selected connection. `figma_mcp` accesses supporting advertised MCP operations, including resources/templates/read, prompts and completion/task methods when available. These three tools default to the official connection; select `source: "mirror"` only for an enabled, available cache. Agents choose the corresponding official read tool if the optional cache is unavailable; the plugin does not rewrite incompatible tool schemas or replay calls. `figma_sync` refreshes a mirrored file; its explicit `acceptUnverified` option allows recovery from a pending/no-op/uncertain write after inspection, without claiming that edit is visible.

All discovered tools can receive native aliases: mirror tools keep their `figmog_*` names; official tools use `figma_*`, including `figma_use_figma`. Name collisions, recursive schemas and changed schemas retain the generic call path. BB applies native tool changes when a provider session is next constructed. Reload the plugin and start a new provider session when settings says shortcuts need refreshing; the generic tools do not require that refresh.

The adapter preserves text and images natively. BB's native tool surface does not accept every MCP content type, so other content, structured results and metadata are preserved as labeled JSON text. Resource URIs remain usable through resource-read operations. The plugin does not silently drop large results; bounded limits report an explicit error.

This is a bridge to client-initiated MCP operations. It does not advertise client-side sampling or interactive elicitation, and does not automatically approve server requests or charges. Resource subscription notifications are not pushed into an agent conversation; read resources explicitly. If an upstream tool requires an unsupported client capability, its limitation remains visible. Task creation does not establish write completion: inspect the task's terminal result before explicitly recovering its pending cache.

## Freshness and lifecycle

One managed figmog process owns each connection's cache, shared by concurrent agents. It runs with its desktop proxy disabled because the official remote MCP connection is separate. The plugin persists mirror bookkeeping across process restarts and fences old work on credential changes.

Possible official writes persist active tickets and mark mirrors pending before dispatch. Cached reads wait until active writes finish and a refresh observes a changed version. Version changes are a heuristic: they do not prove that a particular edit is visible. Concurrent or uncertain writes may require explicit recovery. After inspecting the official canvas, use `figma_sync` with `acceptUnverified: true`, or the corresponding settings checkbox, to accept a successful full pull as the new baseline. Its disclosure states that the prior edit remains unverified. A read-only `use_figma` call or a no-op can also require this recovery because arbitrary JavaScript cannot safely be classified by the adapter. A successful write remains successful even if cache bookkeeping fails. Neither the plugin nor its transport automatically replays an uncertain write.

The official connection uses the upstream TypeScript MCP SDK for OAuth and Streamable HTTP. Automatic interactive OAuth and dynamic client registration are disabled; the settings page owns explicit sign-in. No model request is required to connect or inspect the tool catalog.

The current write fence conservatively blocks cached reads across files while any tracked write is active. An unseen target has no cached bytes to invalidate; its first mirror pull can still observe ordinary REST lag. Mirror requests have a bounded 60-second budget, including queue time, so particularly large first pulls may time out. These limits require live validation with the intended files and account.

## Development and verification

Use BB 0.44 or later with Plugin SDK 0.5.29. The build honors `BB_CLI`; outside a BB thread, set it to the absolute path of the matching BB executable so the monorepo's older development CLI is not selected.

```sh
npm run test --workspace @phosphorco/bb-plugin-figma
npm run typecheck --workspace @phosphorco/bb-plugin-figma
npm run build --workspace @phosphorco/bb-plugin-figma
```

Tests cover local fixtures and injected transport/lifecycle boundaries. They do not establish live Figma admission, token scopes, seat entitlement or successful design edits. The workspace execution plan and evidence ledger track that separate acceptance.

## Upstream attribution

This MIT-licensed plugin calls existing external tools. Figmog is authored by Sanctuary Computer; current source declares AGPL-3.0-only and documents unresolved licensing for its embedded fold dependency. Use its separately obtained executable under its own terms. No figmog or fold binary/source is redistributed in this plugin. The runtime dependency `@modelcontextprotocol/sdk` retains its own MIT license. Figma's server, schemas and content remain provided by Figma.
