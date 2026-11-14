# One staged first release of thread attachments

This narrowly scoped workflow prepares `@phosphorco/bb-thread-attachments@0.1.0`
for a maintainer's human 2FA approval. It does not automate approval, direct
publication, rejection, token changes, trusted-publisher changes or package
policy changes. The original annotated tag `bb-thread-attachments/v0.1.0`
(`1e5212ab73098d70067038eaec5c046c09556f5c`) remains at package source
`93ac7456f429ada7e369aeba89d816928ed05884`. Failed ordinary run
[42085600383](https://github.com/phosphorco/bb-community-plugins/actions/runs/42085600383)
remains intact; its old conditional rerun is suspended while staging is selected.

The Owner explicitly accepts npm's public `0.0.0-stage` placeholder and the
reservation of version `0.1.0` for this one initial stage. A package metadata
response of 200, a placeholder, a stage acknowledgement or a provenance log
entry is **not** installable `0.1.0` or completed release proof.

## Supported API and remaining trust gate

The workflow pins Node 24 and npm **11.19.1**, whose stage implementation was
inspected. npm supports staging without immediate 2FA; a maintainer must approve
with 2FA later. It can stage a new package, creating the public placeholder.
Staged and published versions share the version uniqueness constraint. The
staged dist-tag is immutable; this workflow selects `latest` explicitly.
See [npm staged publishing](https://docs.npmjs.com/staged-publishing/) and
[npm stage commands](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

Use the existing repository `NPM_TOKEN` as `NODE_AUTH_TOKEN`. Its ability to
create this package, submit a stage, and list/view/download stages is still
unknown until the separately authorized run. Short-lived OIDC trust tokens
cannot perform stage management. A token denial is a concrete blocker, never
permission to change shared authentication or fall back to direct publication.
OIDC is available for provenance signing; npm may also attempt its normal trust
exchange during submission. Management commands run separately with the existing
token configuration. No credential values or OTPs belong in receipts or chat.

Pinned primary implementation:

- [stage publish](https://github.com/npm/cli/blob/v11.19.1/lib/commands/stage/publish.js)
  extends Publish with `stage: true`; [Publish](https://github.com/npm/cli/blob/v11.19.1/lib/commands/publish.js)
  bypasses the ordinary OTP wrapper for staging. JSON output is keyed by package
  name and adds `stageId` to its tarball details.
- [libnpmpublish](https://github.com/npm/cli/blob/v11.19.1/workspaces/libnpmpublish/lib/publish.js)
  submits a POST to `/-/stage/package/<escaped-package-name>`. Transport retries
  are explicitly disabled by both configuration and command flag here.
- [list](https://github.com/npm/cli/blob/v11.19.1/lib/commands/stage/list.js)
  returns a flat JSON array after pagination; [view](https://github.com/npm/cli/blob/v11.19.1/lib/commands/stage/view.js)
  returns `{id, packageName, version, tag, shasum, ...}`.
- [download](https://github.com/npm/cli/blob/v11.19.1/lib/commands/stage/download.js)
  downloads the stage tarball to `phosphorco-bb-thread-attachments-0.1.0-<stage-id>.tgz`.
  The workflow validates that exact file and its actual bytes.

## Separate candidate and effect handoffs

1. Independently review the four new workflow/helper/test/documentation files.
   Commit/push them separately under the owning Steward's finite grant. The
   package, lock, original publish workflow and release tag are not changed.
   Record the complete reviewed **workflow commit**. The Steward creates a new
   immutable annotated tooling tag `bb-thread-attachments-stage/workflow-v1`
   at that commit and records its object/peeled SHA. This tag does not match
   the ordinary publisher's `bb-thread-attachments/v*` filter. It is distinct
   from the original package release tag; neither tag may be moved.
2. Dispatch `stage-thread-attachments.yml` using the supported tooling tag ref
   `bb-thread-attachments-stage/workflow-v1` with
   `mode=candidate` and `workflow_sha=<same-full-commit>`. This run performs no
   npm stage or publication write. It executes the focused offline safety suite,
   checks out package source `93ac745` separately, verifies the original SDK
   artifact and provenance hashes, installs the historical lock, and runs the
   package build, emitted tests and typecheck before packing once.
3. Inspect/download artifact `attachment-stage-candidate`. Its `candidate.json`
   binds the candidate run, workflow commit, package source, original tag object,
   lock hash, exact 10-entry payload manifest, and full SHA1/SHA256/SHA512/SRI.
   Six emitted JS/declaration entries must match the approved output hashes;
   four documentation/license/manifest entries must match the reviewed source.
   The full tarball SHA1 must also match the old runner's
   `bbc44044952a1ab779535c1ad9c5b546562c0160`. A mismatch stops preparation;
   do not adjust expected hashes to fit a new build without independent review.
4. Only after that actual artifact review and the Steward's explicit finite
   effect handoff, dispatch the **same reviewed workflow commit** once with
   `mode=stage`, `workflow_sha`, `candidate_run`, and the candidate's complete
   `candidate_sha256` and `candidate_sha512`, again dispatching from that same
   immutable tooling tag. The runtime requires its tag ref and exact workflow
   SHA; a moving main or raw-SHA CLI dispatch is not the handoff. Receipts record
   the tooling ref separately from both commit identities and the package tag.
   This job does not rebuild or repack.
   It downloads the successful same-workflow candidate artifact, validates the
   GitHub ZIP digest and unpacked receipt, then independently validates full
   tarball digests and all 10 payload entries against the fixed baseline.
5. Before any stage call, it fences the unchanged remote annotated tag, clean
   fixed package checkout/lock, original failed run/attempt, complete bounded
   ordinary publication history since that original failure, no previous or
   unresolved stage job, absent package
   and version endpoints, and an explicitly successful empty stage list. It
   refuses all non-404 metadata errors and all stage-list errors, including
   401/403/404; those are not evidence of an empty queue. A placeholder already
   present also stops this initial-stage path for investigation.
   A completed/failed/cancelled publication can still have an unknown write
   outcome. Every later attempt needs positive disposition: a downloaded,
   integrity-verified, source-bound selection receipt for a different package,
   or an attachment dry-run receipt plus actual job evidence that all publish
   and bootstrap steps were skipped. A later real attachment attempt or any
   missing/expired/ambiguous evidence stops this path. History overflow stops;
   nothing is silently truncated or inferred from run status or branch name.
6. A persisted intent precedes the single `npm stage publish <retained.tgz>`
   invocation. No retries, interactive stdin, `approve` or `reject` calls exist.
   Every dispatched outcome gets one registry/stage-list postflight, including
   nonzero exit, timeout or malformed/missing acknowledgement. Failed or unclear
   outcomes retain evidence as **unknown** and stop; never infer non-execution.
   Partial timeout stdout/stderr are retained with only exact authentication
   secret values masked using their credential provenance.
   Rerunning a stage job is rejected. The fixed concurrency lane serializes runs;
   previous stage-job history prevents a fresh dispatch bypassing that fence.
7. For a successful acknowledgement, validate the exact stage UUID, package,
   version, tag and SHA1 against list and view. Download the stage once and
   compare its entire bytes, SHA256/SHA512/SRI and all 10 entries to the retained
   candidate. Only then does `stage-outcome.json` say
   `verified-awaiting-human-2fa` and `approvalReady: true`.

Read-only stage management failing after submission is an unresolved write
outcome, not a reason for another stage. Inspect artifact
`attachment-stage-attempt-<run-id>` for intent, raw nonsecret diagnostics,
postflight, original candidate and downloaded bytes. An interrupted run may
lack an uploaded artifact; run/job history still prevents automatic replay.
Authentication and registry conditions are not atomically locked by preflight;
a competing external action may still make the one submission fail. Preserve
that outcome and inspect rather than retrying.

## Human approval and final release proof

The Steward returns the exact stage ID, candidate/run/artifact bindings, both
full archive digests, matching downloaded-stage manifest and the npm package
page. The Owner then asks the maintainer to open the **Staged Packages** tab on
[the package page](https://www.npmjs.com/package/@phosphorco/bb-thread-attachments),
review that exact UUID/version/digest and approve with human 2FA. The equivalent
human CLI operation is `npm stage approve <verified-stage-id>`. This document
does not authorize any agent to execute that operation or supply an OTP.

Record **both** source revisions. npm's GitHub provenance may identify the new
workflow commit in `GITHUB_SHA`, while the package was built from fixed source
`93ac745`. Do not call it provenance from the original tag run. Exact retained
archive bytes, the old SHA1 witness and the independently approved 10-entry
manifest provide the separate package-content binding. Actual registry
provenance must still be inspected and verified after approval.

After human approval, verify actual `0.1.0`, `latest`, registry tarball integrity,
downloaded public bytes and provenance before registry adoption. Then complete
real full-authored-manifest install/lock/frozen checks and adopter/live evidence.
Neither the candidate run nor the staged placeholder clears a runtime or
restart prerequisite. Repository-wide validation is a separate owning-Steward
check; the workflow's selected package checks do not establish full-repo PASS.

Safe focused check, with no npm/network calls or shared build outputs:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 .github/scripts/test-thread-attachments-stage.py
```
