# People Accounts

Feature-owned roster and per-person bot credentials for trusted attribution.
Matching preserves input order, skips ambiguous names and lets consumers use
their default account when no suitable bot is available. Token health is advisory.

## Set up your own row

Set **GitHub organization** to the organization that owns your repositories
(for example, `example-team`). It has no default. Missing or whitespace-only
configuration shows setup guidance and omits PAT creation links; attribution
and token checks continue to work. Organization edits update setup links and
status immediately without reloading or resetting checked token health.

Each engineer adds or updates their own row in the shared `roster` JSON array,
keeping teammates’ rows. Find your opaque person key with **Find a person key**,
fill in your aliases, human GitHub login, bot login and committer name/email,
then save and choose **Reload settings**. Paste your own PAT into the native
secret field labeled with your name and expected bot account.

Use **Create PAT for @your-bot** in your row while signed in to GitHub as that
bot. The link pre-fills your configured organization as the resource owner, **Pull requests:
read/write**, and **Contents: read**. If your bot login is missing, fill it in
and reload first. The link uses GitHub’s [documented URL parameters](https://docs.github.com/en/enterprise-cloud@latest/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters);
its name is limited to 40 characters and description to 1024. It contains only
the bot login, configured organization and setup text, never a PAT or opaque person key.

Choose **Run checks** after saving your token. Your row puts the checked token
account beside the expected bot. A mismatch prominently says “Token belongs to
@X; roster expects @Y” and remains advisory: routing still works.
Ordinary saves do not rebuild the secret schema. Missing or malformed roster
configuration keeps the plugin loaded; `status` explains omitted entries.
Valid entries in a partly invalid roster remain available. Conflicting person
keys are omitted. Different people may share a bot login: credential lookup
uses the first configured token in roster order, and every human still resolves
independently for assignees and co-authors. Shared-account health reflects the
first configured slot; clearing one slot can leave the shared account configured
through another person’s slot.

```json
[{
  "personKey": "opaque-bb-identity-key",
  "displayName": "Example Person",
  "aliases": {"emails": ["example@example.test"], "nicknames": ["example"], "handles": []},
  "githubLogin": "example-human",
  "botLogin": "example-bot",
  "committer": {"name": "Example Person", "email": "example@example.test"}
}]
```

Keys come from the public bb-identity directory, never from display names.
Known opaque keys work even when that directory is unavailable. Alias matching
ignores case, surrounding whitespace and a leading `@`. Email, nickname,
handle, person key, human/bot GitHub login, committer email and display name all
participate; multiple matching people always produce ambiguity.

Each secret field is `github_pat_` plus the 64-character SHA-256 hex digest of the person
key (a fixed-size filename mapping). Display-name changes preserve storage. Removing an entry and reloading
removes its field but retains its secret; re-adding that same key restores it.
Explicitly set a defined field to `null` to clear it. Tokens belong only in
secret fields, never in roster JSON.

## Commands

```sh
bb people-accounts resolve --for example --for unknown --format json
bb people-accounts resolve --for example --format trailers
bb people-accounts status
bb people-accounts status --check
```

JSON is the default. Trailer mode prints only valid `Co-Authored-By` lines to
stdout, and default/unknown reasons to stderr. Valid people still get trailers
alongside unknown names; unavailable attribution returns success so committing
can continue. Invalid CLI syntax is reported as a usage error.

## Integration and diagnostics

The server registers the real supplier with the exact public
`@phosphorco/bb-people-accounts@0.1.0-attribution.0` contract. Public describe,
resolve and roster RPCs never return PATs or check GitHub. The dedicated
credential RPC is a trusted backend convention: consumers use its token for a
GitHub call and never render, persist, return or log it. There are no caller
checks or attribution permissions.

`peopleAccountsStatus(null)` returns active roster rows, diagnostics and
`reloadRequired`. `peopleAccountsDirectory({query})` searches up to 50 public
identity profiles through one factory-owned bb-identity binding. It reports
unavailability/truncation without blocking manual known-key configuration.

The native settings form owns the roster JSON and secret fields. The settings
section shows missing credentials, actual token login, expiry, advertised scopes,
last check and fixed error messages. **Run checks** explicitly performs bounded
GitHub `/user` reads; `status --check` does the same from the CLI. Ordinary status,
resolve, directory search and roster reads never check GitHub. Health is cached
in memory until token edits or plugin reload; a reload shows unchecked health.
No idle polling or relative-time timers run. Failed summary reads use the shared
visibility-aware bounded retry loop, with a quiet 30-second outage grace; retries
stop on recovery or unmount. Token checks and reload actions are never retried. Absent expiry/scopes are unknown, not
proof of fine-grained permissions. Account mismatches and stale/failing health
are advisory and never block attribution. A token edit discards old health,
and results from a check of an older token are ignored.

`peopleAccountsCheck({personKeys})` checks at most 16 effective slots, with four
concurrent reads and a five-second deadline over the full fetch and body read, even if transport ignores
abort; disposal settles outstanding checks and cleans up deadline listeners/timers. Shared accounts check their
first configured slot. The UI batches larger rosters on explicit request.
**Reload settings** deliberately reloads this plugin via the public SDK and
refreshes the native settings page to display the new secret schema. Directory
lookup runs only on **Search directory** and reports missing matches or provider
failure without blocking known opaque keys. Profile/participant extensions must
reuse this binding; profile batches are limited to 64 and participant history
may be partial.

Tests drive the actual factory through the installed SDK fake host and public
package conformance kit. That is source conformance, not live deployment proof.
