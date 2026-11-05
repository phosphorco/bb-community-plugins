---
name: attributing-git-commits
description: Add Co-Authored-By trailers for humans explicitly named as commit coauthors. Use before committing when a user or task names people who contributed to the change.
---

# Attribute Git commits

Before committing, resolve only humans explicitly named as coauthors. Pass each email or handle separately:

```sh
bb people-accounts resolve --for EMAIL_OR_HANDLE --for ANOTHER_PERSON --format trailers
```

Trailers mode writes only valid `Co-Authored-By:` lines to stdout and diagnostics to stderr. Default JSON includes a result per input and `fallbackReason`. Never infer coauthors from thread participants or other context.

Keep Git's configured author (normally the machine author); attribution does not change it. Preserve the intended message and existing trailers, adding each resolved coauthor at most once. Normal Git configuration or an explicit author choice remains available when requested.

Stage only the intended changes first. Set `message_source` to this invocation's own intended message file, or pass that path as the first argument to a standalone script. All working files are private to this invocation. It keeps the commit possible on unavailable CLI, errors, unknown names, empty or malformed output; report a short plain-text note with the reason. Do not add approval, verification, hooks, or identity gates. Do not install `prepare-commit-msg`.

```sh
message_source=${1:?Pass the invocation-specific intended message file as the first argument}
work=$(mktemp -d "${TMPDIR:-/tmp}/bb-attribution.XXXXXX") || {
  printf '%s\n' 'Attribution setup failed; committing with the original message.' >&2
  git commit -F "$message_source"
  exit $?
}
message_file="$work/message"
trailers_file="$work/trailers"
cp "$message_source" "$message_file" || {
  printf '%s\n' 'Could not prepare attribution files; committing with the original message.' >&2
  git commit -F "$message_source"
  exit $?
}
trap 'rm -rf "$work"' EXIT

if bb people-accounts resolve --for cole --for flo --for cole --format trailers > "$trailers_file"; then
  if [ ! -s "$trailers_file" ]; then
    printf '%s\n' 'No coauthor trailers were resolved; committing with the original message.' >&2
    git commit -F "$message_source"
  elif python3 - "$message_file" "$trailers_file" <<'PY'
from pathlib import Path
import re
import subprocess
import sys

message_path, trailers_path = map(Path, sys.argv[1:])
message = message_path.read_text()
lines = [line for line in trailers_path.read_text().splitlines() if line]
valid = re.compile(r"^Co-Authored-By: .+ <[^<>\s]+@[^<>\s]+>$")
if any(not valid.fullmatch(line) for line in lines):
    raise SystemExit("Attribution output was malformed.")

parsed = subprocess.run(
    ["git", "interpret-trailers", "--parse"], input=message,
    text=True, capture_output=True, check=True,
).stdout.splitlines()
def key_value(line):
    key, value = line.split(":", 1)
    return key.strip().casefold(), value.strip().casefold()

seen = {key_value(line) for line in parsed if ":" in line}
for line in dict.fromkeys(lines):
    identity = key_value(line)
    if identity in seen:
        continue
    message = subprocess.run(
        ["git", "interpret-trailers", "--if-exists", "addIfDifferent",
         "--if-missing", "add", "--where", "end", "--trailer", line],
        input=message, text=True, capture_output=True, check=True,
    ).stdout
    seen.add(identity)
message_path.write_text(message)
PY
  then
    git commit -F "$message_file"
  else
    printf '%s\n' 'Attribution failed validation; committing with the original message.' >&2
    git commit -F "$message_source"
  fi
else
  printf '%s\n' 'Attribution could not be resolved; committing with the original message.' >&2
  git commit -F "$message_source"
fi
```

Pass the current invocation's intended message file as the first argument. Unknown names reported by the CLI should be named in the plain-text note; validly resolved coauthors may still be included when another name is unknown.
