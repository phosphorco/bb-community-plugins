# Sentry for BB

Use the official [Sentry MCP server](https://mcp.sentry.dev/) from BB through
one shared sign-in. This follows the Figma plugin's server-owned OAuth,
private storage, live tool discovery, native aliases, settings and CLI pattern.

## Install and connect

```sh
bb plugin install git:https://github.com/phosphorco/bb-community-plugins.git --plugin sentry
```

For development in the canonical workspace:

```sh
bb plugin build /home/ubuntu/bb/community-plugins/plugins/sentry
bb plugin install /home/ubuntu/bb/community-plugins/plugins/sentry --yes
```

Open **Settings → Installed plugins → Sentry**, choose **Connect Sentry**, and
open **Approve access in Sentry**. After approving, paste the callback address
from the browser into **Callback URL** and choose **Finish sign-in**. The default
callback is `http://127.0.0.1:38560/callback`; the page need not load. BB validates
the copied address and exchanges the code on its server.

Advanced settings support a preregistered client ID, optional secret, and a
deployment HTTPS callback at
`https://<bb-host>/api/v1/plugins/sentry/http/oauth/callback`. That callback
completes sign-in directly. Leave client credentials empty for automatic
registration. Sentry's public clients use PKCE without a client secret; issued
confidential clients retain their advertised token authentication method.

The connection is shared by everyone using this BB deployment. Tools act with
the authorizing Sentry account's permissions. Tokens and client secrets never
appear in settings snapshots or agent arguments. The plugin stores credentials
in its scoped storage with directory mode `0700` and file mode `0600`, atomically.
Pending consent, registration, and grants survive reloads. Disconnect removes
the saved authorization. Startup and status checks never initiate sign-in.

## Agent tools and CLI

- `sentry_discover`: current upstream tool names, exact schemas, annotations,
  capabilities and native alias status.
- `sentry_call`: call a tool by its original discovered name and arguments.
- `sentry_mcp`: advertised resources, prompts, subscriptions, completion,
  logging and task operations.
- `sentry_<upstream-name>`: native aliases registered from the discovered
  catalog. Cached descriptors are hints; calls still validate the live catalog.

```sh
bb sentry discover --json
bb sentry call whoami --json
bb sentry call <discovered-name> --arguments-stdin --json < arguments.json
bb sentry mcp resources/list --json
```

Tools and CLI commands execute on the BB server for all enrolled machines.
No local MCP process or credentials are needed. Existing provider sessions can
use the CLI immediately; reload the plugin and start a fresh provider session
to expose newly discovered native aliases. Generic calls remain available.

The upstream catalog determines available operations and entitlements; this
plugin does not embed a fixed Sentry tool list. Results retain mixed content,
structured fields and extensions. Protocol payloads and discovery pagination
are bounded; unsupported server-driven authorization requests are not approved.

Calls are never automatically replayed. Expired tokens refresh before a new
dispatch. A lost response or transport failure can leave a mutation's outcome
unknown; inspect Sentry before deciding whether to retry.

## Verification

```sh
npm run typecheck --workspace @phosphorco/bb-plugin-sentry
npm run test --workspace @phosphorco/bb-plugin-sentry
npm run build --workspace @phosphorco/bb-plugin-sentry
```

Tests exercise the actual SDK transport and plugin adapters against synthetic
vendor endpoints, including PKCE and callback state across reloads, public and
confidential clients, secret redaction, token renewal, catalog changes,
single-dispatch failures, settings recovery, CLI and private filesystem storage.
Authenticated access to a real Sentry organization requires operator sign-in.
