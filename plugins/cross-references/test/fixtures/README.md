`native-restart-partial.responses.json` is an unchanged capture from the
independent review's real native SQLite/projection/window-service reproduction
of PR #13 at `4976b51233b0f522d6702d87d67d32019b7d1aba`.
SHA-256: `eacdcb029ac225f034a8f69ad3a553887e95d31b268de162dcbc0a67fa9de7fb`.

The synthetic conversation has 101 completed turns and max sequence 505.
`original` is its first 200 rows; `warm` reflects a same-sequence historical
correction after constructing a fresh native window service. Another client
warms that window before `witness` requests afterSequence 505, so the witness
is an empty delta despite the content change. `older` completes traversal.
The native rewrite floor is local to the old service lifetime.

The committed regression replays these captured public DTOs through the installed
SDK HTTP-query path and actual plugin SQLite reopen/start. It does not launch
native BB or test a native process restart itself. Subscription delivery is
injected; the separate native-observation tests exercise the real SDK/socket
boundary. The capture and actual-native reproduction are documented in
https://github.com/phosphorco/bb-community-plugins/pull/13#pullrequestreview-5889855182.
