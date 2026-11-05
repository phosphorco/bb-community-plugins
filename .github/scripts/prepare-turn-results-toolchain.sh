#!/usr/bin/env bash
set -euo pipefail

# This checkout is an ephemeral CI compiler input. Nothing starts BB or installs
# a plugin into a running host. Local development uses the canonical workspace.
test "${GITHUB_ACTIONS:-}" = true || { echo 'CI tool preparation only' >&2; exit 1; }
tool_root="${GITHUB_WORKSPACE:?}/.bb-toolchain/fork"
expected_commit=3976be61002511a61ca07f0969ff5838772ed5c0
expected_tree=5789e7b1c5405f4bd85b372bc6827716dec8f7a9
test "$(git -C "$tool_root" rev-parse HEAD)" = "$expected_commit"
test "$(tr -d '[:space:]' < "$tool_root/result-tree.lock")" = "$expected_tree"
test -z "$(git -C "$tool_root" status --porcelain --untracked-files=no)"

(cd "$tool_root" && ./scripts/verify && ./scripts/materialize)
test "$(git -C "$tool_root/build/bb" rev-parse 'HEAD^{tree}')" = "$expected_tree"
npm install --global --ignore-scripts --no-audit --no-fund pnpm@9.15.0
(cd "$tool_root/build/bb" && pnpm install --frozen-lockfile && pnpm run cli:prepare)

cli="$tool_root/build/bb/apps/cli/dist/index.js"
test -f "$cli"
wrapper_dir="$(mktemp -d "${RUNNER_TEMP:?}/turn-results-cli.XXXXXXXX")"
wrapper="$wrapper_dir/bb"
printf '#!/usr/bin/env bash\nset -euo pipefail\nunset BB_CLI\nexec %q %q "$@"\n' "$(command -v node)" "$cli" > "$wrapper"
chmod 700 "$wrapper"
printf 'BB_CLI=%s\nBB_TOOLCHAIN_CLI=%s\n' "$wrapper" "$cli" >> "${GITHUB_ENV:?}"
export BB_TOOLCHAIN_CLI="$cli" BB_TOOLCHAIN_FORK_SHA="$expected_commit" BB_TOOLCHAIN_RESULT_TREE="$expected_tree"
node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const cli = process.env.BB_TOOLCHAIN_CLI;
writeFileSync('turn-results-toolchain.json', JSON.stringify({
  forkCommit: process.env.BB_TOOLCHAIN_FORK_SHA,
  resultTree: process.env.BB_TOOLCHAIN_RESULT_TREE,
  cli, cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
  node: process.version, pnpm: '9.15.0',
  selectedSdkArchiveSha256: 'f9bca05575191c8e9be5bf8d641755dbea95cd00853869e9e472b428c366d5ae',
}, null, 2) + '\n');
JS
