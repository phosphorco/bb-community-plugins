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
