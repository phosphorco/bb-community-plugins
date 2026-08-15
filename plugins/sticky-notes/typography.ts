export const MIN_FONT_SIZE = 16
export const MAX_FONT_SIZE = 64
export const FONT_SIZE_STEP = 0.5
export const EMPTY_NOTE_FONT_SIZE = 32

export type NoteWrapStyle = "auto" | "stable" | "balance" | "pretty"

export interface TextMeasurement {
  fits: boolean
  lineCount: number
}

export interface FittedTypography {
  fontSize: number
  wrapStyle: NoteWrapStyle
}

/** Find the greatest half-pixel tick whose layout fits. */
export function largestFittingFontSize(
  fits: (fontSize: number) => boolean,
  minimum = MIN_FONT_SIZE,
  maximum = MAX_FONT_SIZE,
  step = FONT_SIZE_STEP,
): number {
  if (!fits(minimum)) return minimum
  let low = Math.round(minimum / step)
  let high = Math.round(maximum / step)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle * step)) low = middle
    else high = middle - 1
  }
  return low * step
}

export function preferredWrapStyles(lineCount: number): readonly NoteWrapStyle[] {
  return lineCount <= 5 ? ["balance", "pretty"] : ["pretty", "balance"]
}

let pooledTextarea: HTMLTextAreaElement | null = null
let measurementClients = 0

export function retainTextareaMeasurer(): () => void {
  measurementClients += 1
  return () => {
    measurementClients = Math.max(0, measurementClients - 1)
    if (measurementClients === 0) {
      pooledTextarea?.remove()
      pooledTextarea = null
    }
  }
}

function measurer(): HTMLTextAreaElement {
  if (pooledTextarea?.isConnected) return pooledTextarea
  const element = document.createElement("textarea")
  element.tabIndex = -1
  element.setAttribute("aria-hidden", "true")
  element.setAttribute("inert", "")
  element.wrap = "soft"
  Object.assign(element.style, {
    border: "0",
    boxSizing: "border-box",
    contain: "strict",
    left: "-10000px",
    margin: "0",
    opacity: "0",
    overflow: "hidden",
    pointerEvents: "none",
    position: "fixed",
    resize: "none",
    top: "0",
    visibility: "hidden",
    zIndex: "-1",
  })
  document.body.append(element)
  pooledTextarea = element
  return element
}

const copiedProperties = [
  "font-family",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-feature-settings",
  "font-kerning",
  "font-optical-sizing",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "text-rendering",
  "direction",
  "writing-mode",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const

export function measureTextarea(
  source: HTMLTextAreaElement,
  text: string,
  fontSize: number,
  wrapStyle: NoteWrapStyle,
): TextMeasurement {
  const mirror = measurer()
  const computed = window.getComputedStyle(source)
  for (const property of copiedProperties) {
    mirror.style.setProperty(property, computed.getPropertyValue(property))
  }
  mirror.style.setProperty("font-size", `${fontSize}px`)
  const sourceFontSize = Number.parseFloat(computed.fontSize) || MIN_FONT_SIZE
  const sourceLineHeight = Number.parseFloat(computed.lineHeight) || sourceFontSize * 1.4
  const lineHeight = fontSize * (sourceLineHeight / sourceFontSize)
  mirror.style.setProperty("line-height", `${lineHeight}px`)
  mirror.style.setProperty("text-wrap-mode", "wrap")
  mirror.style.setProperty("text-wrap-style", wrapStyle)
  mirror.style.width = `${source.clientWidth}px`
  mirror.style.height = `${source.clientHeight}px`
  mirror.value = text

  const tolerance = 1
  const fits = mirror.scrollHeight <= mirror.clientHeight + tolerance
    && mirror.scrollWidth <= mirror.clientWidth + tolerance
  const padding = Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom)
  const lineCount = Math.max(1, Math.round((mirror.scrollHeight - padding) / lineHeight))
  return { fits, lineCount }
}

function wrapStyleSupported(style: NoteWrapStyle): boolean {
  return style === "auto" || CSS.supports("text-wrap-style", style)
}

export function fitTextareaTypography(
  source: HTMLTextAreaElement,
  text: string,
  focused: boolean,
): FittedTypography {
  if (text.length === 0) {
    return {
      fontSize: EMPTY_NOTE_FONT_SIZE,
      wrapStyle: focused && wrapStyleSupported("stable") ? "stable" : "pretty",
    }
  }

  const sizingStyle: NoteWrapStyle = focused && wrapStyleSupported("stable") ? "stable" : "auto"
  const fontSize = largestFittingFontSize(
    (candidate) => measureTextarea(source, text, candidate, sizingStyle).fits,
  )
  const baseline = measureTextarea(source, text, fontSize, sizingStyle)
  if (focused) return { fontSize, wrapStyle: sizingStyle }

  for (const wrapStyle of preferredWrapStyles(baseline.lineCount)) {
    if (!wrapStyleSupported(wrapStyle)) continue
    const result = measureTextarea(source, text, fontSize, wrapStyle)
    if (result.fits && result.lineCount <= baseline.lineCount) {
      return { fontSize, wrapStyle }
    }
  }
  return { fontSize, wrapStyle: "auto" }
}
