# New Thread Templates

Reusable first messages become forms below BB’s native New thread composer. Search Templates, fill the fields, inspect destination and execution, then start an ordinary BB thread. The native composer keeps its own prompt, mentions, attachments, history and execution controls.

On mobile New thread, usable Templates take the place of the native Recent list while the independent freeform composer stays available. Desktop keeps its normal layout. This uses a cleanup-owned content-script stylesheet and the native compact-home/Recent markers, rather than a replacement slot. If those markers or browser selector support are unavailable, the native layout remains. Initial unavailable identity/data and an empty unselected catalog also retain Recent. Last-good choices and selected form loading, errors and recovery controls remain reachable; the actual error and recovery actions stay visible. Disabling the plugin restores the native presentation.

## Run a template

Choose a published template, complete its fields, and inspect **Details**. The form shows the destination, environment policy and effective model before **⏎ Start thread**. Cmd/Ctrl+Enter sends; Enter in a long-text field inserts a newline. Validation retains inputs and focuses the first actionable error.

Input drafts are personal to the captured owner and template. They survive returning to the gallery, remounts and reloads through `@phosphorco/bb-identity` state and recovery checkpoints. Inspecting another subject does not impersonate them or retarget pending writes.

## Edit the complete request with BB

After the form resolves an existing destination, **Edit with BB** opens BB’s full native composer for the generated request. It supports native mentions, commands and attachments along with visible project, environment and run settings. These actual choices and the complete structured input are sent through the same durable server launch path. Returning to the form retains its inputs and keeps the editor’s live choices within that selected form and actor.

Native text, mentions and attachments use a separate owner-scoped draft key. After an actual reload, BB restores that content and the original run-setting seed; recheck the destination and run settings. Unsubmitted picker changes are not exposed for persistence by the public component. Existing native edits are retained when form inputs change; resetting to generated text requires an explicit choice.

This option opens for existing projects, including a matching existing local source. A template that genuinely creates a project keeps direct form send; the project is created when sent. The optional editor does not create projects merely by opening. It edits the complete request; individual template fields remain ordinary form controls. The native freeform composer stays separate.

## Author and publish

**Settings → Templates** contains the management console. **New template** in the chooser and **Edit** on a selected template open the same editor, with a return to the chooser/form. Create, duplicate or edit a shared definition using the freely navigable **Fields / Project / Model / Prompt** tabs. **Save draft** keeps unfinished work. **Publish** validates and snapshots an immutable revision; a failed edit or publication leaves the last published revision available. **Unpublish** removes it from the chooser while retaining launch evidence. **History** inside management opens prior launches and their recovery actions, including launches from unpublished or older revisions.

**Remove** permanently removes a definition from the catalog. It retains historical revisions, launch receipts and personal inputs, reserves its ID, and prevents built-in seeds from restoring it. A concurrent edit or publication must be reloaded before removal. There is no Restore action; duplicate before removing if you want another editable copy.

Definitions and saved editor drafts are shared across this trusted workspace. Collaborators can edit them; identity records who made the change. Concurrent changes use revision checks. Unsaved editor work is guarded on plugin navigation and retained in a personal recovery checkpoint across shell exits. Compact field rows expand the selected configuration; the management panel owns its scroll area so the last field and actions remain reachable.

Fields support short text, long text, URL, number, select and checkbox, with stable unique keys, labels, order, help, defaults, required values and bounded validation. Prompt, title and new-project name templates accept `{{field_key}}` and `{{field_key|literal fallback}}`. Empty optional values render as empty text or the literal fallback; zero and false retain their values. An unchecked checkbox without an explicit default is false. Unknown or malformed tokens block publication. Rendering uses the bounded plain-text language described below.

The **Prompt** tab lists the valid placeholders for the current fields, with their labels and types. Choose a placeholder to insert it at the selection in the title or first message. Renaming or removing a field updates the list immediately; any old token in the text still needs correcting before publication. Routine local checkpointing and successful saves are silent. Recovery or conflict notices retain the unfinished work they describe.

Sample preview renders a title and first message without creating projects, environments or threads. The starter set contains Feedback Session and PR Review. Feedback Session keeps rapid feedback and review separate; PR Review requests an independent posted review and thoughtful handling of initial feedback before any squash-merge step. A local-source definition requires a real enrolled host and existing source path before publication.

## Destinations and execution

**Default destination project** is saved on each template; templates are shared workspace definitions rather than per-project libraries. A definition can select an existing project, let the runner choose a project, or create/reuse a project from an enrolled host and existing absolute local source path. Native local-path project creation may reuse a project already registered for that source. This local-source destination does not clone repositories or bootstrap machines; paths are never executed as shell commands. The optional BB editor also exposes installed native environment and machine providers through their normal controls.

**Machine** can use **BB default** or a specific enrolled machine. BB default retains the existing routing policy; automatic project-default setup uses BB’s primary machine and chooses checkout/worktree during startup. A specific machine requires an explicit source checkout or worktree on that machine. An unfinished configuration can be saved, but incompatible choices block preview and publication. Reusing an environment fixes the machine to that environment; new-project setup uses its one source machine. Missing sources, unavailable machines and unavailable explicit models block before launch.

The optional BB editor checks the selected machine and source before opening. Its visible controls can then intentionally change the destination; the actual submitted choices remain authoritative. A later source change can affect BB’s native selection, so a seed is not a permanent machine pin.

Execution inherits from the final destination project, or uses an explicit provider/model/reasoning choice from the native catalog. Explicit unavailable choices block launch. Templates carries the submitted execution provenance and BB checks run permissions. When the full BB editor selects a provider that creates a machine, target model availability and permission checks happen during BB admission on that machine; Templates preserves the exact choice. New-project preview is advisory until native creation resolves the final project.

## Launch receipts and recovery

The server validates and renders the published revision and submitted values again, then persists an immutable launch snapshot before effects. SQLite claims project creation and thread spawn durably; concurrent requests cannot claim the same operation twice. Confirmed project steps survive later failures, and navigation requires a confirmed native thread ID. The BB editor’s complete structured input, destination, run settings and provenance are captured alongside the original template fields and revision.

After a lost response or restart, Templates reconciles the same operation. An uncertain spawn remains check-only: a lookup finding no thread does not prove that the earlier request cannot still commit. A provisional pending thread row is not proof of acceptance: a lost acknowledgement stays check-only until BB acknowledges creation or retained active/idle evidence confirms admission. Deleted or failed provisional candidates remain inspectable. Templates never automatically resends an uncertain spawn and makes no native exactly-once guarantee. Inputs, provisioned projects and source data remain intact. New sends first save the exact versioned direct/native request. **Resume saved request** explicitly resumes that same operation with the original actor and current session; a missing receipt is not proof that an earlier call cannot still arrive. Claimed or uncertain effects stay check-only. Safe pre-effect failures may resume the same immutable operation. Older references without an exact saved request and without a server journal remain check-only: the original request cannot be safely reconstructed from today’s form, so inputs and native drafts are retained. After a plugin reload, a late launch acknowledgement may need **Check launch status** or reopening to refresh its result; its receipt remains saved in **Manage → History** and the restored input draft. Other authoritative recovery updates refresh mounted views automatically.

Opening a previously used template keeps the form available for another run. A completed launch offers **Open thread**; restoring its receipt does not redirect you. A new active send navigates after its completed input reference has been saved.

Native thread origin is this plugin. The public server SDK can show machine authorship for the native first message; Templates separately retains the captured submitting actor in its launch journal and seeded thread metadata. It does not fabricate human native authorship or add sender envelopes to prompts.

## Optional Inbox assignment

When Inbox Sidebar Nerd supports the assignment protocol, a confirmed template launch can assign its thread to the original submitting person if ownership has never been touched. Existing assignments and explicit Unassign decisions are preserved. Thread creation succeeds independently of assignment availability or uncertainty. **Last checked Inbox assignment** describes the saved ownership snapshot; an initial claim receipt does not prove current ownership. **Check assignment** refreshes it, and **Retry assignment** is offered only when the same original person can safely retry the same conditional operation. History retains recovery after template unpublication or removal; opening History does not backfill assignments.

## Development

The canonical plugin ID, collection entry and directory are `new-thread-templates`; package name is `@phosphorco/bb-plugin-new-thread-templates`. Release tag prefix is `new-thread-templates/`.

From the community repository, install with `npm ci`. Run `npm run test`, `npm run typecheck` and `npm run build` before handoff. Focused checks use the same commands with `--workspace @phosphorco/bb-plugin-new-thread-templates`. The build uses the repository’s pinned BB target CLI and public Plugin SDK declarations. Generated `dist/` stays uncommitted.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the RPC/state contract, durable claims and verification boundaries. Fault-injection/database-reopen tests, hosted plugin smoke and a complete BB process restart prove different things; delivery evidence must name which ran.

### Live prompt preview and saved samples

The Prompt tab continuously renders the current draft’s title and first message alongside the source, or below it on narrow screens. Its editable sample inputs are preview-only. Selecting one of your last five complete, distinct submissions keeps the original revision, values and observed time available for comparison; it does not replace the shared definition, personal launch form or BB editor draft. Missing, unknown or incompatible values are shown for correction against the current fields. Samples follow the actual submitting identity, including a stable fallback identity; they are not another person’s history. Only confirmed thread admission records a sample. Typing, previewing, failed preparation and provisional native rows do not.

The shared plain-text language is a bounded subset, not full Handlebars or Hugo. Existing `{{field}}` and `{{field|literal fallback}}` keep their behavior, including literal pipes/spaces, zero and false. Values are never evaluated again or HTML-escaped. Helpers are `upper`, `lower`, `trim`, `concat`, `default`, `eq`, `not`, `and`, `or` and `date`; `if`/`unless` blocks support `else` and parenthesized helper expressions. `default` replaces missing values or empty text only. Conditions treat missing values, empty text, false and zero as false; `eq` compares values and types. Bare field names may match helper names. There are no loops, property traversal, custom registrations, scripts, filesystem or network operations. Syntax errors include line/column locations and block publication.

For example:

```text
{{upper subject}}
{{#if (and subject (not focus))}}Add focus{{else}}{{trim focus}}{{/if}}
{{date @now "yyyy-MM-dd HH:mm"}}
```

Set a real IANA time zone on the template, such as `Europe/Berlin`; the visible default is UTC. The observed instant stays fixed until **Refresh time** or selecting a different preview sample. Date arguments accept `@now` or calendar-valid ISO timestamps with an explicit `Z`/offset. Format tokens are `yyyy MM dd HH mm ss EEE`: **MM is month; mm is minute**. Every generated date includes its actual GMT offset and `[IANA zone]`, even a time-only or year-only format.

The invocation form displays its own frozen clock. Opening/previewing existing personal work does not rewrite it; an intentional input/time edit or send saves the clock with that work. Preview, exact request, recovery checkpoint and server journal use the same context. An opened BB editor retains its original generated title, prompt and clock across Back, form changes and reload; refreshing the form never rewrites edited native text. Explicit reset creates a fresh origin. History retries preserve whether the original request supplied a context, and unknown operations retain their exact saved request.
