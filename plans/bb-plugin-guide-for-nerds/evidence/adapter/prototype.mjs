// Isolated proposal models: not plugin implementation or an SDK harness.
export function innerLayer(target, frame) {
  const inner = target.closest('[data-guide-inner-layer], [role="dialog"], [role="menu"], [role="listbox"]');
  return inner !== null && inner !== frame;
}
export function editable(target) {
  return Boolean(target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
}
export function scopeFrameEscape(event, frame, close) {
  if (event.key !== 'Escape' || event.defaultPrevented || !frame.contains(event.target) || innerLayer(event.target, frame)) return;
  event.preventDefault(); event.stopPropagation(); close();
}
export function contentEscape(event, frame, dismissCard) {
  if (event.key !== 'Escape' || event.defaultPrevented || innerLayer(event.target, frame)) return;
  if (dismissCard()) { event.preventDefault(); event.stopPropagation(); }
}
export function pageArrow(event, frame, show) {
  if (event.defaultPrevented || innerLayer(event.target, frame) || editable(event.target)) return;
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (direction) { event.preventDefault(); show(direction); }
}
export function clamp(rect, viewport, margin = 8) {
  // Frame size is constrained BEFORE position. viewport uses visualViewport
  // offsetLeft/Top/width/height when available; layout viewport otherwise.
  margin = Math.min(margin, viewport.w / 2, viewport.h / 2);
  const w = Math.min(rect.w, Math.max(0, viewport.w - margin * 2));
  const h = Math.min(rect.h, Math.max(0, viewport.h - margin * 2));
  const x = Math.max(viewport.x + margin, Math.min(rect.x, viewport.x + viewport.w - w - margin));
  const y = Math.max(viewport.y + margin, Math.min(rect.y, viewport.y + viewport.h - h - margin));
  return { x, y, w, h };
}
export function releaseDrag(drag) {
  if (!drag) return null;
  if (drag.element.hasPointerCapture(drag.id)) drag.element.releasePointerCapture(drag.id);
  return null;
}
export function returnFocus(invoker, frame, active) {
  // Restore only if focus was owned by this frame (or fell to body on removal).
  if (invoker?.isConnected && (frame.contains(active) || active === frame.ownerDocument.body)) invoker.focus();
}
export class OpenLifetime {
  controller = null; current = 0; disposed = false; timers = new Set();
  begin() { this.end(); this.controller = new AbortController(); const serial = ++this.current;
    return { serial, signal: this.controller.signal }; }
  valid(token) { return !this.disposed && token.serial === this.current && !token.signal.aborted; }
  end() { this.controller?.abort(); for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  dispose() { this.end(); this.disposed = true; }
  async load(token, loader, commit, fail) {
    try { const value = await loader(); if (this.valid(token)) commit(value); }
    catch (error) { if (this.valid(token)) fail(error); }
  }
  async copy(token, action, commit, timerFactory = setTimeout) {
    let result; try { result = await action(); } catch { result = false; }
    if (!this.valid(token)) return;
    commit(result);
    const timer = timerFactory(() => { this.timers.delete(timer); if (this.valid(token)) commit('idle'); }, 2000);
    this.timers.add(timer);
  }
}
