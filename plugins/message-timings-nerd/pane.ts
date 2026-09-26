// Hosted panels place the header beside the conversation, inside the same
// split-pane wrapper. The ordinary thread layout puts both inside the main
// timeline panel; older layouts put the header inside the conversation.
export function findTimingPane(header: HTMLElement): HTMLElement | null {
  return header.closest<HTMLElement>("[data-split-pane-id]")
    ?? header.closest<HTMLElement>("#thread-detail-timeline-panel")
    ?? header.closest<HTMLElement>("[data-conversation-collapsed]");
}
