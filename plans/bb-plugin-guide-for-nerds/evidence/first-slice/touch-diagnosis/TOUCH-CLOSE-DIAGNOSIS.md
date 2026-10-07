# Native touch close diagnosis

Read-only worker result for steward `thr_pk5kwrdyjm`. All probes used fresh
public Playwright/Chromium 153.0.8010.12 contexts; no personal profile/credentials,
installs, builds, reloads, source edits or canonical evidence writes.

**Finding:** the failed witness loses the browser-generated click after an abrupt
single-step CDP drag. It is reproducible without BB/React/plugin code. A paced
native CDP drag makes first-tap close pass on the actual canonical plugin,
including viewport resize and scrolling. Evidence supports revising the gesture
witness before changing the plugin. It does not certify physical-device behavior
or establish the exact Chromium gesture-recognizer implementation cause.

## Retained experiments

* `touch-close-diagnosis.cjs/.json/.log` and per-case PNGs: actual canonical
  thread route and plugin, with document event/default-prevention traces.
  Plain, drag-only and resize/scroll-only cases closed on first tap. Combined
  abrupt drag/resize/scroll did not; a second tap closed. First tap's target was
  the × span inside Close guide at x279,y39, within button x257,y17,44x44.
  Pointer/touch events arrived with final defaultPrevented=false; the instrumented
  Event.preventDefault logged no calls for the close tap. No click was emitted.
* `touch-close-minimal.cjs/.json/.log`: bare HTML with native DOM pointer capture,
  movable header, scroll body and a click close handler; no BB/React/SDK. Abrupt
  drag/resize/scroll suppresses first click both with and without drag
  preventDefault, after 100ms or 450ms pre-tap delays. Observation continues
  500ms after tap. These controls rule out relying on a simple additional delay
  or removing plugin drag preventDefault as an evidenced fix.
* `touch-close-controls.cjs/.json/.log`: bare no-drag resize control emits click
  and closes. Abrupt drag-only and drag/resize without scrolling still lose the
  click; a screenshot before tap does not repair it. Thus resize, scrolling and
  frame code are not individually necessary to reproduce the minimal failure.
* `touch-close-input-modes.cjs/.json/.log`: after the abrupt drag, Playwright tap,
  sequential CDP start/end, and CDP tap with an 80ms finger-down dwell all lose
  first click. Playwright's concurrent start/end implementation alone does not
  explain the failure.
* `touch-close-paced.cjs/.json/.log`: bare A/B control. Single 40px move loses
  the click; five 8px moves paced 40ms apart, then a 40ms hold before touchEnd,
  emits a click and closes. Both use the same subsequent resize/scroll/tap.
* `touch-close-native-paced.cjs/.json/.log` and its PNG: the paced gesture on
  the actual canonical plugin then 390x844→320x568 resize, body scrollTop=200,
  and one native Close guide tap yields one click and **zero remaining frames**.
  Close target remains x257,y17,44x44; visual viewport width320, height568,
  scale1. No default prevention is recorded for that tap.
* `touch-diagnosis-receipt.json`: current frame/entry/build-metadata hashes and
  browser version; each canonical JSON retains event timings/paths/targets.

The minimal probes initially used native readonly `window.closed` as a result
flag; that fixture mistake was corrected to an owned flag and all retained
minimal outputs were rerun with a 500ms post-tap observation. Final results above
refer to the corrected outputs. Canonical results use actual frame count.

## Source-supported interpretation and recommendation

Current frame header skips interactive descendants through `closest('button…')`;
Close guide invokes close through onClick. In the failed native witness no click
exists for React to handle. The plugin abort/close code cannot be judged from an
input sequence that never dispatches its activation event.

The native host sidebar swipe start handlers require a physical sidebar-inset/
backdrop ancestor (`sidebar.tsx:271`, with start guards at 1309/1372); the owned
body portal is outside those targets. Donor touch swipe handlers belong to its
page toolbar, not the frame header. Together with the event traces and bare
control, there is no evidence for a BB host listener or plugin close handler
consuming this tap. This is a bounded diagnosis, not proof of every host listener.

Recommend updating the owner's gesture witness to the demonstrated paced
sequence: touchStart at header x+60,y+20; successive touchMove y+28,+36,+44,+52,+60
with 40ms between samples; hold40ms, then touchEnd. Preserve all existing native
resize/scroll assertions, target traces and first-tap detached assertion. The
owner should rerun their exact lifecycle script independently; this worker's
probe does not authorize marking the entire first-slice suite passed.

Do not substitute a synthetic DOM click, second tap, arbitrary timeout or
pointerup-based close implementation to label the original failing sequence a
pass. No source fix is recommended from the current evidence. Actual physical
mobile/touch hardware remains untested; the abrupt raw-input edge case is real
in this Chromium automation lane and can stay documented as a witness limitation.
