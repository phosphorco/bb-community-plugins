import { linksEqual } from "./links.ts"
import type { StickyNoteLink } from "./notes.ts"

export interface StickyNoteContent {
  text: string
  links: readonly StickyNoteLink[]
}

export function noteContentEqual(left: StickyNoteContent, right: StickyNoteContent): boolean {
  return left.text === right.text && linksEqual(left.links, right.links)
}

export class ConfirmedTextSaveQueue {
  #confirmedText: string
  #chain: Promise<void> = Promise.resolve()

  constructor(confirmedText: string) {
    this.#confirmedText = confirmedText
  }

  get confirmedText(): string {
    return this.#confirmedText
  }

  updateConfirmed(text: string): void {
    this.#confirmedText = text
  }

  enqueue(text: string, save: (text: string) => Promise<boolean>): Promise<string> {
    const result = this.#chain.then(async () => {
      if (text === this.#confirmedText) return this.#confirmedText
      let saved = false
      try {
        saved = await save(text)
      } catch {
        saved = false
      }
      if (saved) this.#confirmedText = text
      return this.#confirmedText
    })
    this.#chain = result.then(() => undefined, () => undefined)
    return result
  }
}

export class ConfirmedLinksSaveQueue {
  #confirmedLinks: StickyNoteLink[]
  #chain: Promise<void> = Promise.resolve()

  constructor(confirmedLinks: readonly StickyNoteLink[]) {
    this.#confirmedLinks = [...confirmedLinks]
  }

  updateConfirmed(links: readonly StickyNoteLink[]): void {
    this.#confirmedLinks = [...links]
  }

  enqueue(
    links: readonly StickyNoteLink[],
    save: (links: StickyNoteLink[]) => Promise<boolean>,
  ): Promise<readonly StickyNoteLink[]> {
    const queued = [...links]
    const result = this.#chain.then(async () => {
      if (linksEqual(queued, this.#confirmedLinks)) return this.#confirmedLinks
      let saved = false
      try {
        saved = await save(queued)
      } catch {
        saved = false
      }
      if (saved) this.#confirmedLinks = queued
      return this.#confirmedLinks
    })
    this.#chain = result.then(() => undefined, () => undefined)
    return result
  }
}

export class ConfirmedNoteContentSaveQueue {
  #confirmed: StickyNoteContent
  #chain: Promise<void> = Promise.resolve()

  constructor(confirmed: StickyNoteContent) {
    this.#confirmed = { text: confirmed.text, links: [...confirmed.links] }
  }

  updateConfirmed(confirmed: StickyNoteContent): void {
    this.#confirmed = { text: confirmed.text, links: [...confirmed.links] }
  }

  enqueue(
    content: StickyNoteContent,
    save: (content: StickyNoteContent) => Promise<boolean>,
  ): Promise<StickyNoteContent> {
    const queued = { text: content.text, links: [...content.links] }
    const result = this.#chain.then(async () => {
      if (noteContentEqual(queued, this.#confirmed)) return this.#confirmed
      let saved = false
      try {
        saved = await save(queued)
      } catch {
        saved = false
      }
      if (saved) this.#confirmed = queued
      return this.#confirmed
    })
    this.#chain = result.then(() => undefined, () => undefined)
    return result
  }
}
