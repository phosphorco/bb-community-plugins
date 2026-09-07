import "./app.css"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import {
  definePluginApp,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app"

import {
  anchorPlacement,
  clamp,
  clampPlacement,
  isBelowViewport,
  MIN_NOTE_HEIGHT,
  MIN_NOTE_WIDTH,
  noteSizeForBounds,
  placementCenteredAt,
  pointIsWithinBounds,
  resolvePlacement,
  type AbsolutePlacement,
} from "./geometry.ts"
import { HUE_COUNT, type StickyNote, type StickyNotePatch } from "./notes.ts"
import type { rpcContract } from "./server.ts"
import {
  EMPTY_NOTE_FONT_SIZE,
  fitTextareaTypography,
  measureTextarea,
  retainTextareaMeasurer,
  type FittedTypography,
} from "./typography.ts"
import { intersectPaneBounds, type OverlayBounds } from "./overlay-bounds.ts"
import { reconcileAcknowledgedPatch, reconcileNoteSnapshot } from "./note-state.ts"
import { ConfirmedTextSaveQueue } from "./save-queue.ts"
import { createClickSuppression, type CreateClickSource } from "./create-gesture.ts"

type NewNotePreview = {
  placement: AbsolutePlacement
  hueIndex: number
  valid: boolean
}
type SurfaceController = {
  bounds: OverlayBounds | null
  click(source: CreateClickSource): void
  beginCreateDrag(event: ReactPointerEvent<HTMLButtonElement>): void
}
type SurfaceControllerHandle = { current: SurfaceController | null }

const HUES = Array.from({ length: HUE_COUNT }, (_, index) => index * (360 / HUE_COUNT))
const surfaceControllers = new Map<string, Set<SurfaceControllerHandle>>()
const GAEGU_STYLESHEET = "https://fonts.bunny.net/css?family=gaegu:700"

function ensureGaeguFont(): void {
  if (document.head.querySelector('[data-bb-sticky-notes-font="gaegu"]')) return
  const preconnect = document.createElement("link")
  preconnect.rel = "preconnect"
  preconnect.href = "https://fonts.bunny.net"
  preconnect.dataset.bbStickyNotesFont = "gaegu-preconnect"
  const stylesheet = document.createElement("link")
  stylesheet.rel = "stylesheet"
  stylesheet.href = GAEGU_STYLESHEET
  stylesheet.dataset.bbStickyNotesFont = "gaegu"
  document.head.append(preconnect, stylesheet)
}

ensureGaeguFont()

function registerSurfaceController(threadId: string, handle: SurfaceControllerHandle): () => void {
  const handles = surfaceControllers.get(threadId) ?? new Set<SurfaceControllerHandle>()
  handles.add(handle)
  surfaceControllers.set(threadId, handles)
  return () => {
    handles.delete(handle)
    if (handles.size === 0) surfaceControllers.delete(threadId)
  }
}

function controllerFor(
  threadId: string,
  viewportPoint?: { x: number; y: number },
): SurfaceController | null {
  const controllers = Array.from(surfaceControllers.get(threadId) ?? [], (handle) => handle.current)
    .filter((controller): controller is SurfaceController => controller !== null)
  if (!viewportPoint) return controllers[0] ?? null
  return controllers.find((controller) => {
    const bounds = controller.bounds
    return bounds
      ? viewportPoint.x >= bounds.left
        && viewportPoint.x <= bounds.left + bounds.width
        && viewportPoint.y >= bounds.top
        && viewportPoint.y <= bounds.top + bounds.height
      : false
  }) ?? null
}

function noteColorStyle(hueIndex: number): CSSProperties {
  const hue = HUES[hueIndex] ?? 0
  return {
    "--sticky-note-background": `oklch(0.9 0.085 ${hue})`,
    "--sticky-note-foreground": `oklch(0.27 0.035 ${hue})`,
  } as CSSProperties
}

function useFittedTypography(
  textareaRef: { current: HTMLTextAreaElement | null },
  text: string,
  focused: boolean,
): FittedTypography & { refit(): void } {
  const [typography, setTypography] = useState<FittedTypography>({
    fontSize: EMPTY_NOTE_FONT_SIZE,
    wrapStyle: "pretty",
  })
  const typographyRef = useRef(typography)
  const textRef = useRef(text)
  const focusedRef = useRef(focused)
  const frameRef = useRef<number | null>(null)
  const idleRef = useRef<number | null>(null)

  typographyRef.current = typography
  textRef.current = text
  focusedRef.current = focused

  const commitFit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea || textarea.clientWidth === 0 || textarea.clientHeight === 0) return
    const next = fitTextareaTypography(textarea, textRef.current, focusedRef.current)
    if (
      next.fontSize !== typographyRef.current.fontSize
      || next.wrapStyle !== typographyRef.current.wrapStyle
    ) {
      typographyRef.current = next
      setTypography(next)
    }
  }, [textareaRef])

  const schedule = useCallback((exact = false) => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    if (idleRef.current !== null) window.clearTimeout(idleRef.current)
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const textarea = textareaRef.current
      if (!textarea || textarea.clientWidth === 0 || textarea.clientHeight === 0) return
      if (exact || textRef.current.length === 0) {
        commitFit()
        return
      }
      const current = measureTextarea(
        textarea,
        textRef.current,
        typographyRef.current.fontSize,
        focusedRef.current ? "stable" : "auto",
      )
      if (!current.fits) {
        commitFit()
        return
      }
      idleRef.current = window.setTimeout(() => {
        idleRef.current = null
        commitFit()
      }, 180)
    })
  }, [commitFit, textareaRef])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    let disposed = false
    const releaseMeasurer = retainTextareaMeasurer()
    const observer = new ResizeObserver(() => schedule(false))
    observer.observe(textarea)
    schedule(true)
    const fonts = document.fonts
    const refitAfterFontLoad = () => schedule(true)
    fonts.addEventListener("loadingdone", refitAfterFontLoad)
    void fonts.ready.then(() => {
      if (!disposed) schedule(true)
    })
    return () => {
      disposed = true
      observer.disconnect()
      fonts.removeEventListener("loadingdone", refitAfterFontLoad)
      releaseMeasurer()
    }
  }, [schedule, textareaRef])

  useEffect(() => {
    schedule(focused)
  }, [focused, schedule, text])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    if (idleRef.current !== null) window.clearTimeout(idleRef.current)
  }, [])

  return { ...typography, refit: () => schedule(true) }
}

function paneBoundsFrom(anchor: HTMLElement): { host: HTMLElement; bounds: OverlayBounds } | null {
  const viewport = window.visualViewport
  const viewportLeft = viewport?.offsetLeft ?? 0
  const viewportTop = viewport?.offsetTop ?? 0
  const viewportWidth = viewport?.width ?? window.innerWidth
  const viewportHeight = viewport?.height ?? window.innerHeight
  const minimumHeight = Math.min(520, viewportHeight * 0.6)
  const viewportBounds = {
    left: viewportLeft,
    top: viewportTop,
    width: viewportWidth,
    height: viewportHeight,
  }
  let candidate: HTMLElement | null = anchor.parentElement
  while (candidate && candidate !== document.body) {
    const rect = candidate.getBoundingClientRect()
    if (rect.width >= MIN_NOTE_WIDTH && rect.height >= Math.max(MIN_NOTE_HEIGHT, minimumHeight)) {
      const bounds = intersectPaneBounds(rect, viewportBounds, 48, {
        width: MIN_NOTE_WIDTH,
        height: MIN_NOTE_HEIGHT,
      })
      if (bounds) return { host: candidate, bounds }
    }
    candidate = candidate.parentElement
  }
  return null
}

function usePaneBounds(anchorRef: { current: HTMLElement | null }): OverlayBounds | null {
  const [bounds, setBounds] = useState<OverlayBounds | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    let observedHost: HTMLElement | null = null
    let frame: number | null = null
    const measure = () => {
      const next = paneBoundsFrom(anchor)
      if (!next) {
        if (observedHost) resizeObserver.unobserve(observedHost)
        observedHost = null
        setBounds((current) => current === null ? current : null)
        return
      }
      if (next.host !== observedHost) {
        if (observedHost) resizeObserver.unobserve(observedHost)
        observedHost = next.host
        resizeObserver.observe(next.host)
      }
      setBounds((current) => current
        && current.left === next.bounds.left
        && current.top === next.bounds.top
        && current.width === next.bounds.width
        && current.height === next.bounds.height
        ? current
        : next.bounds)
    }
    const scheduleMeasure = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    const ancestryObserver = new MutationObserver(scheduleMeasure)
    ancestryObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener("resize", scheduleMeasure)
    window.addEventListener("scroll", scheduleMeasure, true)
    window.visualViewport?.addEventListener("resize", scheduleMeasure)
    window.visualViewport?.addEventListener("scroll", scheduleMeasure)
    measure()
    return () => {
      resizeObserver.disconnect()
      ancestryObserver.disconnect()
      window.removeEventListener("resize", scheduleMeasure)
      window.removeEventListener("scroll", scheduleMeasure, true)
      window.visualViewport?.removeEventListener("resize", scheduleMeasure)
      window.visualViewport?.removeEventListener("scroll", scheduleMeasure)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [anchorRef])

  return bounds
}

function StickyNoteIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M4 2.75h8.6L16.5 6.7v10.55H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12.5 2.9v4h3.8" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

interface NoteProps {
  note: StickyNote
  bounds: OverlayBounds
  autoFocus: boolean
  zIndex: number
  onBringForward(): void
  onDelete(id: string): void
  onUpdate(id: string, patch: StickyNotePatch): Promise<boolean>
}

function Note({
  note,
  bounds,
  autoFocus,
  zIndex,
  onBringForward,
  onDelete,
  onUpdate,
}: NoteProps) {
  const placementBounds = { width: bounds.width, height: bounds.height }
  const [placement, setPlacement] = useState(() => resolvePlacement(note, placementBounds))
  const placementRef = useRef(placement)
  const [text, setText] = useState(note.text)
  const textRef = useRef(text)
  const textSaverRef = useRef(new ConfirmedTextSaveQueue(note.text))
  const textDirtyRef = useRef(false)
  const textTimerRef = useRef<number | null>(null)
  const placementSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [discarding, setDiscarding] = useState(false)
  const [positioning, setPositioning] = useState(false)
  const [textFocused, setTextFocused] = useState(false)
  const [keyboardStatus, setKeyboardStatus] = useState("")
  const discardingRef = useRef(false)
  const cleanupGestureRef = useRef<(() => void) | null>(null)
  const interactingRef = useRef(false)
  const keyboardPlacementDirtyRef = useRef(false)
  const typography = useFittedTypography(textareaRef, text, textFocused)

  const setCurrentPlacement = useCallback((next: AbsolutePlacement) => {
    placementRef.current = next
    setPlacement(next)
  }, [])

  useEffect(() => {
    if (interactingRef.current) {
      cleanupGestureRef.current?.()
      interactingRef.current = false
      discardingRef.current = false
      setDiscarding(false)
      setPositioning(false)
    }
    keyboardPlacementDirtyRef.current = false
    setCurrentPlacement(resolvePlacement(note, placementBounds))
  }, [note.horizontalAnchor, note.verticalAnchor, note.offsetX, note.offsetY, note.width, note.height, note.rotation, bounds.width, bounds.height, setCurrentPlacement])

  useEffect(() => {
    textSaverRef.current.updateConfirmed(note.text)
    if (!textDirtyRef.current) {
      textRef.current = note.text
      setText(note.text)
    }
  }, [note.text])

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const flushText = useCallback(() => {
    if (textTimerRef.current !== null) window.clearTimeout(textTimerRef.current)
    textTimerRef.current = null
    const next = textRef.current
    if (next === textSaverRef.current.confirmedText) {
      textDirtyRef.current = false
      return
    }
    void textSaverRef.current.enqueue(next, (value) => onUpdate(note.id, { text: value })).then((confirmed) => {
      textDirtyRef.current = textRef.current !== confirmed
    })
  }, [note.id, onUpdate])

  useEffect(() => () => {
    cleanupGestureRef.current?.()
    flushText()
  }, [flushText])

  const changeText = (next: string) => {
    textRef.current = next
    textDirtyRef.current = true
    setText(next)
    if (textTimerRef.current !== null) window.clearTimeout(textTimerRef.current)
    textTimerRef.current = window.setTimeout(flushText, 400)
  }

  const savePlacement = useCallback((next: AbsolutePlacement) => {
    const layout = anchorPlacement(next, placementBounds)
    const patch = {
      horizontalAnchor: layout.horizontalAnchor,
      verticalAnchor: layout.verticalAnchor,
      offsetX: layout.offsetX,
      offsetY: layout.offsetY,
      rotation: layout.rotation,
    }
    placementSaveChainRef.current = placementSaveChainRef.current.then(async () => {
      await onUpdate(note.id, patch)
    })
  }, [note.id, onUpdate, placementBounds.width, placementBounds.height])

  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    onBringForward()
    cleanupGestureRef.current?.()
    const pointerId = event.pointerId
    const captureTarget = event.currentTarget
    captureTarget.setPointerCapture(pointerId)
    interactingRef.current = true
    setPositioning(true)
    const start = placementRef.current
    const startX = event.clientX
    const startY = event.clientY
    let lastX = event.clientX
    const allowWiggle = !window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      const dx = pointerEvent.clientX - startX
      const dy = pointerEvent.clientY - startY
      const velocityX = pointerEvent.clientX - lastX
      lastX = pointerEvent.clientX
      const next = {
        ...start,
        left: clamp(start.left + dx, 0, placementBounds.width - start.width),
        top: Math.max(0, start.top + dy),
        rotation: allowWiggle
          ? clamp(placementRef.current.rotation + velocityX * 0.32, -5, 5)
          : start.rotation,
      }
      setCurrentPlacement(next)
      const viewport = window.visualViewport
      const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
      const below = isBelowViewport(next, bounds.top, viewportBottom)
      discardingRef.current = below
      setDiscarding(below)
    }

    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      cleanup()
      interactingRef.current = false
      setPositioning(false)
      if (discardingRef.current) {
        onDelete(note.id)
        return
      }
      savePlacement(placementRef.current)
      discardingRef.current = false
      setDiscarding(false)
    }
    const cancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      cleanup()
      interactingRef.current = false
      setPositioning(false)
      discardingRef.current = false
      setDiscarding(false)
      setCurrentPlacement(start)
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", cancel)
      if (captureTarget.hasPointerCapture(pointerId)) captureTarget.releasePointerCapture(pointerId)
      cleanupGestureRef.current = null
    }
    cleanupGestureRef.current = cleanup
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", cancel)
  }

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const amount = event.shiftKey ? 1 : 10
    const current = placementRef.current
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const next = { ...current, rotation: clamp(current.rotation + (event.key === "ArrowLeft" ? -1 : 1), -5, 5) }
      setCurrentPlacement(next)
      keyboardPlacementDirtyRef.current = true
      setKeyboardStatus(`Rotated to ${Math.round(next.rotation)} degrees`)
      return
    }
    const next = clampPlacement({
      ...current,
      left: current.left + (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0),
      top: current.top + (event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0),
    }, placementBounds)
    setCurrentPlacement(next)
    keyboardPlacementDirtyRef.current = true
    setKeyboardStatus(`Moved to ${Math.round(next.left)} from the left and ${Math.round(next.top)} from the top`)
  }

  const commitKeyboardPlacement = () => {
    if (!keyboardPlacementDirtyRef.current) return
    keyboardPlacementDirtyRef.current = false
    savePlacement(placementRef.current)
  }

  return (
    <section
      className="bb-sticky-note"
      data-discarding={discarding ? "true" : "false"}
      data-positioning={positioning ? "true" : "false"}
      style={{
        ...noteColorStyle(note.hueIndex),
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        transform: `rotate(${placement.rotation}deg)`,
        zIndex,
      }}
      onPointerDown={onBringForward}
    >
      <button
        type="button"
        className="bb-sticky-note-grab"
        aria-label="Move sticky note. Use arrow keys to move or Alt plus left or right to rotate. Hold Shift for fine adjustments."
        onPointerDown={beginMove}
        onKeyDown={moveWithKeyboard}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            commitKeyboardPlacement()
          }
        }}
        onBlur={commitKeyboardPlacement}
      >
        <span aria-hidden="true" />
      </button>
      <textarea
        ref={textareaRef}
        value={text}
        maxLength={20_000}
        aria-label="Sticky note text"
        placeholder="Leave a note…"
        spellCheck
        data-wrap-style={typography.wrapStyle}
        style={{ fontSize: typography.fontSize }}
        onChange={(event) => changeText(event.target.value)}
        onCompositionEnd={typography.refit}
        onBlur={() => {
          setTextFocused(false)
          flushText()
        }}
        onFocus={() => {
          setTextFocused(true)
          onBringForward()
        }}
      />
      {discarding ? <div className="bb-sticky-note-discard">Release to discard</div> : null}
      <span className="bb-sticky-note-sr-only" role="status" aria-live="polite">{keyboardStatus}</span>
    </section>
  )
}

function StickyNotesSurface() {
  const rpc = useRpc<typeof rpcContract>()
  const view = useComposerView()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const bounds = usePaneBounds(anchorRef)
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null
  const [notes, setNotes] = useState<StickyNote[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [topId, setTopId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [newNotePreview, setNewNotePreview] = useState<NewNotePreview | null>(null)
  const newNotePreviewRef = useRef<NewNotePreview | null>(null)
  const cleanupCreateDragRef = useRef<(() => void) | null>(null)
  const clickSuppressionRef = useRef(createClickSuppression())
  const controllerRef = useRef<SurfaceController | null>(null)
  const refreshGenerationRef = useRef(0)
  const threadIdRef = useRef(threadId)
  const pendingDeleteIdsRef = useRef(new Set<string>())
  threadIdRef.current = threadId

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current
    if (!threadId) return
    try {
      const result = await rpc.call("listNotes", { threadId })
      if (generation !== refreshGenerationRef.current) return
      const visibleNotes = result.notes.filter((note) => !pendingDeleteIdsRef.current.has(note.id))
      setNotes((current) => reconcileNoteSnapshot(current, visibleNotes))
      setFailure(null)
    } catch {
      if (generation !== refreshGenerationRef.current) return
      setFailure("Sticky notes couldn’t sync")
    }
  }, [rpc, threadId])

  useEffect(() => {
    pendingDeleteIdsRef.current.clear()
    setNotes([])
    setActiveId(null)
    void refresh()
  }, [refresh])

  useRealtime("notes", useCallback((payload: unknown) => {
    if (
      threadId &&
      typeof payload === "object" &&
      payload !== null &&
      "threadId" in payload &&
      payload.threadId === threadId
    ) void refresh()
  }, [refresh, threadId]))

  const updateNote = useCallback(async (id: string, patch: StickyNotePatch): Promise<boolean> => {
    if (!threadId) return false
    const requestedThreadId = threadId
    try {
      const result = await rpc.call("updateNote", { id, threadId, patch })
      if (threadIdRef.current !== requestedThreadId) return false
      setNotes((current) => result.note
        ? current.map((note) => note.id === id
          ? reconcileAcknowledgedPatch(note, result.note!, patch)
          : note)
        : current.filter((note) => note.id !== id))
      setFailure(null)
      return result.note !== null
    } catch {
      if (threadIdRef.current !== requestedThreadId) return false
      setFailure("Sticky notes couldn’t sync")
      return false
    }
  }, [rpc, threadId])

  const deleteNote = useCallback((id: string) => {
    if (!threadId) return
    const requestedThreadId = threadId
    pendingDeleteIdsRef.current.add(id)
    setNotes((current) => current.filter((note) => note.id !== id))
    void rpc.call("deleteNote", { id, threadId })
      .then(({ deleted }) => {
        pendingDeleteIdsRef.current.delete(id)
        if (threadIdRef.current !== requestedThreadId) return
        if (deleted) return
        setFailure("Sticky note couldn’t be discarded")
        void refresh()
      })
      .catch(() => {
        pendingDeleteIdsRef.current.delete(id)
        if (threadIdRef.current !== requestedThreadId) return
        setFailure("Sticky note couldn’t be discarded")
        void refresh()
      })
  }, [refresh, rpc, threadId])

  const createNoteAt = async (placement: AbsolutePlacement, hueIndex: number) => {
    if (!threadId || !bounds) return
    const requestedThreadId = threadId
    const layout = anchorPlacement(placement, bounds)
    try {
      const { note } = await rpc.call("createNote", { threadId, layout, hueIndex })
      if (threadIdRef.current !== requestedThreadId) return
      setNotes((current) => [...current.filter((item) => item.id !== note.id), note])
      setActiveId(note.id)
      setTopId(note.id)
      setFailure(null)
      void refresh()
    } catch {
      if (threadIdRef.current !== requestedThreadId) return
      setFailure("Sticky note couldn’t be created")
    }
  }

  const createNote = () => {
    if (!bounds) return
    const size = noteSizeForBounds(bounds)
    const placement = placementCenteredAt({
      x: bounds.width * 0.5 + (Math.random() - 0.5) * 90,
      y: bounds.height * 0.22 + (Math.random() - 0.5) * 70,
    }, bounds, size, (Math.random() - 0.5) * 3)
    void createNoteAt(placement, Math.floor(Math.random() * HUE_COUNT))
  }

  const setPreview = (preview: NewNotePreview | null) => {
    newNotePreviewRef.current = preview
    setNewNotePreview(preview)
  }

  const beginCreateDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !bounds || view.run.isSubmitting) return
    clickSuppressionRef.current.beginPointerGesture()
    cleanupCreateDragRef.current?.()
    const pointerId = event.pointerId
    const captureTarget = event.currentTarget
    captureTarget.setPointerCapture(pointerId)
    const startX = event.clientX
    const startY = event.clientY
    const hueIndex = Math.floor(Math.random() * HUE_COUNT)
    const size = noteSizeForBounds(bounds)
    let dragged = false
    let rotation = (Math.random() - 0.5) * 2
    let lastX = event.clientX

    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      const distance = Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY)
      if (!dragged && distance < 5) return
      dragged = true
      pointerEvent.preventDefault()
      rotation = clamp(rotation + (pointerEvent.clientX - lastX) * 0.2, -4, 4)
      lastX = pointerEvent.clientX
      const point = {
        x: pointerEvent.clientX - bounds.left,
        y: pointerEvent.clientY - bounds.top,
      }
      setPreview({
        placement: placementCenteredAt(point, bounds, size, rotation),
        hueIndex,
        valid: pointIsWithinBounds(point, bounds),
      })
    }

    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      cleanup()
      if (!dragged) return
      clickSuppressionRef.current.suppressNextButtonClick()
      const preview = newNotePreviewRef.current
      setPreview(null)
      if (preview?.valid) void createNoteAt(preview.placement, preview.hueIndex)
    }
    const cancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return
      cleanup()
      setPreview(null)
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", cancel)
      if (captureTarget.hasPointerCapture(pointerId)) captureTarget.releasePointerCapture(pointerId)
      cleanupCreateDragRef.current = null
    }
    cleanupCreateDragRef.current = cleanup
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", cancel)
  }

  useEffect(() => () => cleanupCreateDragRef.current?.(), [])
  useEffect(() => {
    cleanupCreateDragRef.current?.()
    setPreview(null)
  }, [bounds?.left, bounds?.top, bounds?.width, bounds?.height])

  const click = (source: CreateClickSource) => {
    if (source === "button" && clickSuppressionRef.current.consumeButtonClick()) {
      return
    }
    createNote()
  }

  controllerRef.current = { bounds, click, beginCreateDrag }

  useEffect(() => {
    if (!threadId) return
    return registerSurfaceController(threadId, controllerRef)
  }, [threadId])

  const overlay = bounds && threadId ? createPortal(
    <div
      className="bb-sticky-notes-overlay"
      data-thread-id={threadId}
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
    >
      {failure ? <div className="bb-sticky-notes-error" role="status">{failure}</div> : null}
      {newNotePreview ? (
        <section
          className="bb-sticky-note bb-sticky-note-drag-preview"
          data-positioning="true"
          data-valid={newNotePreview.valid ? "true" : "false"}
          aria-hidden="true"
          style={{
            ...noteColorStyle(newNotePreview.hueIndex),
            left: newNotePreview.placement.left,
            top: newNotePreview.placement.top,
            width: newNotePreview.placement.width,
            height: newNotePreview.placement.height,
            transform: `rotate(${newNotePreview.placement.rotation}deg)`,
            zIndex: notes.length + 4,
          }}
        >
          <textarea
            readOnly
            tabIndex={-1}
            placeholder="Leave a note…"
            data-wrap-style="pretty"
            style={{ fontSize: EMPTY_NOTE_FONT_SIZE }}
          />
        </section>
      ) : null}
      {notes.map((note, index) => (
        <Note
          key={note.id}
          note={note}
          bounds={bounds}
          autoFocus={activeId === note.id}
          zIndex={topId === note.id ? notes.length + 2 : index + 1}
          onBringForward={() => {
            setTopId(note.id)
            setActiveId(null)
          }}
          onDelete={deleteNote}
          onUpdate={updateNote}
        />
      ))}
    </div>,
    document.body,
  ) : null

  return (
    <>
      <span ref={anchorRef} className="bb-sticky-notes-controller-anchor" aria-hidden="true" />
      {overlay}
    </>
  )
}

function StickyNotesPromptAction() {
  const view = useComposerView()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null
  const resolveController = () => {
    if (!threadId) return null
    const rect = buttonRef.current?.getBoundingClientRect()
    return controllerFor(threadId, rect ? {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    } : undefined)
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="bb-sticky-notes-action"
      aria-label="Add sticky note. Drag to place it."
      title="Add sticky note · drag to place"
      disabled={view.run.isSubmitting}
      onPointerDown={(event) => resolveController()?.beginCreateDrag(event)}
      onClick={() => resolveController()?.click("button")}
    >
      <StickyNoteIcon />
    </button>
  )
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "sticky-notes",
    scopes: ["thread"],
    actions: [{ id: "add-sticky-note", component: StickyNotesPromptAction }],
    banners: [{ id: "sticky-notes-surface", chrome: "bare", component: StickyNotesSurface }],
    plusMenu: [{
      id: "add-sticky-note",
      label: "Add sticky note",
      icon: "Note",
      description: "Add a shared note to this thread",
      run({ view }) {
        if (view.scope.kind === "thread") controllerFor(view.scope.threadId)?.click("plus-menu")
      },
    }],
  })
})
