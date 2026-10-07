import type { ComponentType } from 'react';

// Frozen by the Execution Steward during the independent package scaffold.
// Type-only imports from guide-content.tsx do not load the floating implementation.
export type GuideSelection = Readonly<{ section: 'surfaces'; pageId: string }>;
export type GuideCloseReason = 'toggle' | 'button' | 'escape';
export interface GuideContentProps {
  /** Initial selection for this mounted content session; no host route is read. */
  initialSelection: GuideSelection;
  /** Report local selection for the next open. Does not navigate BB. */
  onSelectionChange(selection: GuideSelection): void;
  /** Aborted on close/retry supersession/reload. Async completions must guard it. */
  sessionSignal: AbortSignal;
}
export interface GuideContentModule {
  default: ComponentType<GuideContentProps>;
}
export interface FloatingGuideProps {
  /** Stable injected loader. Frame imports no ProductMap/content modules. */
  loadContent(): Promise<GuideContentModule>;
  /** Namespaced per-plugin event, dispatched by native footer action. */
  toggleEvent: string;
  title: string;
  initialSelection?: GuideSelection;
}
// Frame owns open/close/import state and the portal. Closed means no content tree.
// Source owns keyboard/card/menu handling: consumed Escape prevents default AND
// stops propagation before frame's bubble handler. No global card Escape listener.
// Menus/inner dialogs carry data-guide-inner-layer; frame checks this plus
// defaultPrevented. No capture-phase frame Escape and no composer interception.
