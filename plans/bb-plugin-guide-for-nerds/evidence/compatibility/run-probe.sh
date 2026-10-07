#!/usr/bin/env bash
# No host starts, installs, reloads, shared caches, or canonical plugin outputs.
set -euo pipefail
receipt_root="$(cd "$(dirname "$0")" && pwd)"
result_root="${1:?Usage: run-probe.sh /absolute/owned-result-directory}"
[[ "$result_root" = /* ]] || { echo 'result directory must be absolute' >&2; exit 2; }
mkdir -p "$result_root"
probe_root="$(mktemp -d /tmp/bb-guide-compat-recheck-XXXXXX)"
trap 'rm -rf -- "$probe_root"' EXIT
export npm_config_cache="$probe_root/npm-cache"
unset BB_CLI
python3 "$receipt_root/fetch-packages.py" "$probe_root" "$result_root/package-provenance.json" > "$result_root/fetch.log" 2>&1
cp -R "$receipt_root/fixture" "$probe_root/fixture"
npm ci --prefix "$probe_root/fixture" --no-audit --no-fund > "$result_root/install.log" 2>&1
node "$probe_root/fixture/harness.mjs" > "$result_root/harness.log" 2>&1
"$probe_root/fixture/node_modules/.bin/tsc" -p "$probe_root/fixture/tsconfig.json" > "$result_root/typecheck.log" 2>&1
npm install --prefix "$probe_root/cli-deps" --ignore-scripts --no-audit --no-fund npm@11.16.0 > "$result_root/cli-deps-install.log" 2>&1
ln -s "$probe_root/cli-deps/node_modules" "$probe_root/bb-app-0.44.0/package/node_modules"
BB_DATA_DIR="$probe_root/data-044" node "$probe_root/bb-app-0.44.0/package/dist/bb.js" plugin build "$probe_root/fixture" > "$result_root/build-044.log" 2>&1
cp -R "$probe_root/fixture/dist" "$result_root/output-044"
set +e
BB_DATA_DIR="$probe_root/data-042" node "$probe_root/bb-app-0.42.0/package/dist/bb.js" plugin build "$probe_root/fixture" > "$result_root/build-042.log" 2>&1
old_status=$?
set -e
[[ "$old_status" = 1 ]] || { echo "unexpected 0.42.0 exit: $old_status" >&2; exit 1; }
rg -q 'No matching export.*experimental_Icon' "$result_root/build-042.log"
rg -q 'No matching export.*useSdk' "$result_root/build-042.log"
npm ci --prefix "$probe_root/fixture" --omit=dev --no-audit --no-fund > "$result_root/omit-dev-install.log" 2>&1
npm install --prefix "$probe_root/fixture" --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund > "$result_root/git-install-flags.log" 2>&1
npm ls --prefix "$probe_root/fixture" --omit=dev --all --json > "$result_root/omit-dev-tree.json"
BB_DATA_DIR="$probe_root/data-044" node "$probe_root/bb-app-0.44.0/package/dist/bb.js" plugin build "$probe_root/fixture" > "$result_root/build-044-omit-dev.log" 2>&1
cmp "$probe_root/fixture/dist/app.js" "$result_root/output-044/app.js"
if [[ -n "${BB_GUIDE_FORK_CLI:-}" ]]; then
  [[ -x "$BB_GUIDE_FORK_CLI" ]] || { echo 'explicit fork CLI must be executable' >&2; exit 2; }
  rm -rf -- "$probe_root/fixture/dist"
  BB_DATA_DIR="$probe_root/data-fork" "$BB_GUIDE_FORK_CLI" plugin build "$probe_root/fixture" > "$result_root/build-fork-omit-dev.log" 2>&1
  cp -R "$probe_root/fixture/dist" "$result_root/output-fork"
  cp "$receipt_root/check-output.mjs" "$result_root/check-output.mjs"
  node "$result_root/check-output.mjs" > "$result_root/check-output.log" 2>&1
fi
printf '%s\n' '{"public044Build":0,"public042BuildExpectedFailure":1,"sdkHarness":0,"typecheck":0,"omitDevInstall":0,"omitDevPublicBuild":0}' > "$result_root/exit-status.json"
echo "PASS; receipts retained in $result_root; exact scratch installation/cache retired on exit"
