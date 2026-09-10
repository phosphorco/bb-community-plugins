import type { StickyNoteLink } from "./notes.ts"

const HTTP_URL = /https?:\/\/[^\s<>"']+/giu
const TRAILING_PUNCTUATION = /[),.;!?\]}]+$/u
export const MAX_LINKS = 50

export interface ExtractedPaste {
  text: string
  links: StickyNoteLink[]
}

export interface LinkActivation {
  button: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

function normalizedHttpUrl(candidate: string): URL | null {
  const trimmed = candidate.replace(TRAILING_PUNCTUATION, "")
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    return url
  } catch {
    return null
  }
}

export function extractLinksFromPaste(value: string): ExtractedPaste {
  const links: StickyNoteLink[] = []
  const seen = new Set<string>()
  const text = value.replace(HTTP_URL, (candidate) => {
    const trimmedCandidate = candidate.replace(TRAILING_PUNCTUATION, "")
    const url = normalizedHttpUrl(trimmedCandidate)
    if (!url) return candidate
    const normalized = url.toString()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      links.push({ url: normalized, domain: url.hostname, title: null })
    }
    return candidate.slice(trimmedCandidate.length)
  })

  return {
    text: text
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n[ \t]+/gu, "\n")
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([,.;!?])/gu, "$1"),
    links,
  }
}

export function mergeNoteLinks(
  current: readonly StickyNoteLink[],
  incoming: readonly StickyNoteLink[],
): StickyNoteLink[] {
  const next = [...current]
  const seen = new Set(current.map((link) => link.url))
  for (const link of incoming) {
    if (seen.has(link.url) || next.length >= MAX_LINKS) continue
    seen.add(link.url)
    next.push(link)
  }
  return next
}

export function removeNoteLink(current: readonly StickyNoteLink[], url: string): StickyNoteLink[] {
  return current.filter((link) => link.url !== url)
}

export function insertPastedText(
  current: string,
  start: number,
  end: number,
  pasted: string,
): { text: string; caret: number } {
  const text = `${current.slice(0, start)}${pasted}${current.slice(end)}`
  return { text, caret: start + pasted.length }
}

/** Replaces admitted URLs with the visible citation marker for their stable list position. */
export function citationTextForPaste(value: string, links: readonly StickyNoteLink[]): string {
  const citationByUrl = new Map(links.map((link, index) => [link.url, index + 1]))
  return value.replace(HTTP_URL, (candidate) => {
    const trimmedCandidate = candidate.replace(TRAILING_PUNCTUATION, "")
    const url = normalizedHttpUrl(trimmedCandidate)
    if (!url) return candidate
    const citation = citationByUrl.get(url.toString())
    return citation === undefined ? candidate : `(${citation}.)${candidate.slice(trimmedCandidate.length)}`
  })
}

/** Drops a removed reference's marker and shifts every later managed marker down one. */
export function removeAndRenumberCitationMarkers(text: string, removedReference: number): string {
  return text.replace(/\((\d+)\.\)/gu, (marker, capturedNumber: string) => {
    const reference = Number(capturedNumber)
    if (reference === removedReference) return ""
    return reference > removedReference ? `(${reference - 1}.)` : marker
  })
}

export function noteLinkLabel(link: StickyNoteLink, currentHost: string): string {
  try {
    const url = new URL(link.url)
    if (url.host === currentHost) {
      if (link.title) return link.title
      if (/\/threads\/thr_[a-z0-9]+(?:\/|$)/iu.test(url.pathname)) return "BB thread"
      return "BB link"
    }
  } catch {
    // A stored link has already been validated, but retain a safe label for old data.
  }
  return link.title ? `${link.domain} · ${link.title}` : link.domain
}

export function threadIdForBbLink(linkUrl: string, currentOrigin: string): string | null {
  try {
    const url = new URL(linkUrl)
    if (url.origin !== currentOrigin) return null
    return url.pathname.match(/\/threads\/(thr_[a-z0-9]+)(?:\/|$)/iu)?.[1] ?? null
  } catch {
    return null
  }
}

export function nativeThreadIdForLinkActivation(
  linkUrl: string,
  currentOrigin: string,
  activation: LinkActivation,
): string | null {
  if (
    activation.button !== 0
    || activation.altKey
    || activation.ctrlKey
    || activation.metaKey
    || activation.shiftKey
  ) return null
  return threadIdForBbLink(linkUrl, currentOrigin)
}

export function linksEqual(
  left: readonly StickyNoteLink[],
  right: readonly StickyNoteLink[],
): boolean {
  return left.length === right.length && left.every((link, index) => {
    const other = right[index]
    return other !== undefined
      && link.url === other.url
      && link.domain === other.domain
      && link.title === other.title
  })
}
