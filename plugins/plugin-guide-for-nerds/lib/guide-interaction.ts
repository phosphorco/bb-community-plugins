/** The frame is nonmodal; only nested controls suppress guide shortcuts. */
export function guideInnerLayer(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const layer = target.closest(
    '[data-guide-inner-layer], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  );
  return layer?.hasAttribute("data-guide-frame") ? null : layer;
}

export function guideEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
  ) !== null;
}

/** Restore only focus being removed with this layer, preserving outside focus. */
export function restoreGuideLayerFocus(layer: Element | null, opener: HTMLElement | null, fallback?: HTMLElement | null) {
  if (!layer?.contains(document.activeElement)) return;
  const target = [opener, fallback].find(element => element?.isConnected &&
    !element.closest('[hidden], [inert]'));
  target?.focus({ preventScroll: true });
}
