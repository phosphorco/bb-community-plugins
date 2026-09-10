const MAX_HTML_BYTES = 128 * 1024
const REQUEST_TIMEOUT_MS = 3_500

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>()
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu
  for (const match of tag.matchAll(pattern)) {
    result.set(match[1]!.toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ""))
  }
  return result
}

function cleanTitle(value: string | null): string | null {
  const cleaned = value?.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim()
  return cleaned ? decodeHtml(cleaned).slice(0, 300) : null
}

export function titleFromHtml(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0])
    const property = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase()
    if (property === "og:title" || property === "twitter:title") {
      const title = cleanTitle(attrs.get("content") ?? null)
      if (title) return title
    }
  }
  return cleanTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? null)
}

async function readHtml(response: Response): Promise<string | null> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) return null
  if (!response.body) return (await response.text()).slice(0, MAX_HTML_BYTES)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size <= MAX_HTML_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_HTML_BYTES) return null
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/** Best-effort browser request. Cross-origin sites that deny CORS simply retain their domain label. */
export async function fetchClientLinkTitle(rawUrl: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(rawUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!response.ok || (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml"))) {
      return null
    }
    const html = await readHtml(response)
    return html ? titleFromHtml(html) : null
  } catch {
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}
