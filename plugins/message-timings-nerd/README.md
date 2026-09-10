# Message Timings Nerd

Send times and the time between human messages and agent replies, directly below
the existing BB timeline rows. Inspired by
[Message Timestamps by bighitbiker3](https://github.com/bighitbiker3/bb-plugin-message-timestamps),
independently implemented for Phosphor.

- Human messages show their local send time, the gap since the preceding human
  message, and the wait after the preceding agent finish when available.
- At an agent turn's end, the last rendered row shows its completion time and
  elapsed time from the preceding human message.
- The latest human message shows its approximate age. After the agent finishes,
  its footer shows both time since finishing and time since your last message.
- Once another human message arrives, the earlier finish shows the fixed wait
  until that message. Historical durations do not keep growing.

For example, a message at 10:00, an agent finish at 10:03, and a follow-up at
10:10 show `3m from your message · 7m until next message` below the agent reply,
and `10m since previous message · 7m after agent finished` below the follow-up.
Hover a label for the full local date and time. Use the clock button in each
thread header to hide/show its labels, or retry an unavailable timing lookup.

## Develop

From this repository, run:

```sh
npm ci
npm run test --workspace @phosphorco/bb-plugin-message-timings-nerd
npm run typecheck --workspace @phosphorco/bb-plugin-message-timings-nerd
npm run build --workspace @phosphorco/bb-plugin-message-timings-nerd
```

The collection entry is `message-timings-nerd`; its independent release tag is
`message-timings-nerd/v0.1.0`. On an authorized development host:

```sh
bb plugin install path:. --plugin message-timings-nerd --yes
```

## Timing semantics and compatibility

Durations are wall-clock intervals, including scheduling, tools, and approvals;
they are not CPU time or billable model time. Accepted human steering messages
reset the origin for their turn. Pending/rejected messages remain visible but
do not change completed-work attribution. System prompts and delegated child
timelines do not reset it. Stops and failures
use their recorded completion status. Missing timestamps or backwards clock
intervals are omitted rather than invented.

The backend joins the public timeline with recorded `turn/completed` events.
A folded work summary is not a completion event. Reads are bounded to 12 timeline
pages, 1,000 completions, and 1,000 request/acceptance events; the header indicates incomplete older history.
Accepted steering is joined back to its original request by request identity;
acceptance time is not used as send time. When that request is outside the
available history, send-based intervals remain unknown. Completions without a
visible row still establish wait boundaries. Unknown predecessors remain unknown. No message text is returned by this
plugin's RPC or stored by the plugin. Classification follows BB's recorded
`initiator`; legacy automated notifications recorded by BB as `user` also count.

BB currently has no native message-footer slot. The native thread-header slot
provides exact thread identity and per-pane lifecycle; the DOM adapter appends
only plugin-owned labels to `data-timeline-row-id` wrappers within the owning
`data-split-pane-id` pane (or its non-hosted `data-conversation-collapsed`
fallback). Hosted headers may be siblings of the conversation. It respects `data-timeline-windowed-realized`.
These host DOM attributes are a compatibility boundary tested against the local
BB fork. Standalone embedded chats without the native thread header are not
decorated. No text, titles, classes, URL guesses, or sidebar-label matching is
used to identify a thread. A future footer slot can replace this narrow adapter.

## Performance

- One row index, observer, and deadline timer per visible pane, never per row.
- Streaming text is ignored. Known rows repaint locally on windowing changes.
  Only uncovered row IDs, reconnect/visibility recovery, and thread lifecycle
  signals request data; requests coalesce and never overlap per pane.
- A bounded server cache coalesces concurrent clients and queues loads behind
  two global slots. Unchanged history needs one head-page probe rather than
  another full traversal; visible rows before the declared history boundary
  do not trigger futile older-history reads. Lifecycle invalidation
  prevents obsolete requests from restoring stale results, including failures.
- Minute deadlines update only the live footer. Raw clock state never enters
  React. Equal historical snapshots skip formatting as well as DOM writes;
  local-date and UTC-offset changes invalidate cached calendar text. Hidden snapshots
  reconcile once on return. Historical duration labels have no repeating timers, and there is no
  network polling. A shared daily deadline rolls calendar labels over at local
  midnight; day-scale ages update hourly. Hidden tabs pause clocks and defer
  data reads until visible.
- Unmount, hide, navigation, and reload remove owned labels, observers, timers,
  and listeners. Selected timing text is held until selection ends, retaining
  its spans and text nodes. Transient RPC errors retain the last successful
  footers and flag potentially stale data in the header; fatal decoration
  errors clean up locally and allow manual retry. Reconnect requests fresh data; async results are tied to the
  component generation that requested them.

Tests cover source-order timing, steering, folded work, child isolation,
incomplete history, DST, clock regression, invalidation races, windowing,
hidden/resumed tabs, disposal/remount, and streaming into 1,000 historical rows.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance.

## Review and verification

Independent timing, DOM/performance, and backend/release reviews identified and
led to fixes for acceptance-vs-send time, rejected steering, invisible completion
boundaries, hosted-pane discovery, cache concurrency across invalidation, and
scroll-triggered history reads. The requested integration/accessibility review
was unavailable; keyboard toggling, desktop/mobile layout, and actual installed
plugin reload are covered by browser verification. The focused suite additionally
covers request limits, in-turn page boundaries, and equal-snapshot DOM writes.

The host DOM adapter is verified against Phosphor's materialized BB 0.39 runtime
and SDK 0.4.15. Stock/future BB DOM layouts are not claimed to be verified. The
header reports unsupported layouts rather than silently omitting timestamps.

A second four-lens performance review led to stable refresh-error handling,
selection preservation, computation reuse, bounded head probes, a two-load
queue, and local failure containment. A controlled Chromium fixture with 1,000
historical rows measured median equal-snapshot updates at roughly 0.5 ms after
these changes versus 41 ms before, with zero DOM writes. A 100-leaf-markup
stream produced zero descendant searches and no refresh requests. These are
isolated fixture measurements, not end-to-end BB latency claims. Complex newly
mounted subtrees still need bounded discovery to preserve nested timeline rows;
footers participate in the host's normal layout and measurement.

Live BB verification retained footer/span identity across an injected transient
RPC failure and automatic recovery. A scrolled visible row stayed at the same
screen offset across refresh (0 px delta), and a narrow viewport had no horizontal
overflow. These checks do not exhaust every prepend, search, or history-navigation
sequence; the host DOM/measurement compatibility boundary still applies.
