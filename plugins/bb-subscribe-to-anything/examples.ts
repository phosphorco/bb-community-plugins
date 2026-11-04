// Public starting points. Adapt coverage to the actual request before installing.
export const EXAMPLES = [
  {
    name: "Public GitHub PR head changes",
    parameters: {
      PR_API_URL: "https://api.github.com/repos/OWNER/REPO/pulls/NUMBER",
    },
    script:
      'set -euo pipefail\ncurl --fail --silent --show-error --max-time 20 "$PR_API_URL" > "$SUB_WORKDIR/pr.json"\njq -e \'{url: .html_url, head: .head.sha, additions: .additions} | select(.head != null)\' "$SUB_WORKDIR/pr.json" >> "$SUB_OUTPUT"',
    evaluation: { kind: "json_changes", path: ["head"] },
    coverage:
      "Sampled PR heads. May miss intervening heads/commits; does not establish ancestry.",
  },
  {
    name: "Public deployment revision equals an exact SHA",
    parameters: { STATUS_URL: "https://example.com/status.json" },
    script:
      'set -euo pipefail\ncurl --fail --silent --show-error --max-time 20 "$STATUS_URL" > "$SUB_WORKDIR/status.json"\njq -e \'{revision} | select(.revision != null)\' "$SUB_WORKDIR/status.json" >> "$SUB_OUTPUT"',
    evaluation: {
      kind: "json_equals",
      path: ["revision"],
      value: "EXPECTED_SHA",
    },
    coverage: "Current endpoint revision only; no descendant-commit proof.",
  },
];
