// Hosted panels place the header beside the conversation, inside the same
// split-pane wrapper. Non-hosted layouts put it inside the conversation.
export function findTimingPane(header: HTMLElement): HTMLElement | null {
  return header.closest<HTMLElement>("[data-split-pane-id]")
    ?? header.closest<HTMLElement>("[data-conversation-collapsed]");
}
