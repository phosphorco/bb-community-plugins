import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/ui/icon";
import { HugeiconsIcon } from "@hugeicons/react";
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/SmartPhone01Icon";

import { cn } from "@/lib/utils";
import { guideEditableTarget, guideInnerLayer } from "../lib/guide-interaction";
import { SurfaceCard, useSurfaceCard } from "./surface-card";
import { surfaceIcon } from "./plugin-icons";
import { surfaceLabel, surfaceLocation, surfacePrimaryApi, surfaceReferenceNote } from "./surface-labels";
import {
  fixtureResponsiveStrategy,
  GROUP_BY_SURFACE_ID,
  SURFACE_GROUPS,
  SURFACES_BY_ID,
  type PluginSurface,
  type SurfaceGroup,
} from "./surfaces";
import {
  annotationChipCounterScale,
  annotationChipClass,
  CHIP_COUNTER_SCALE_PROPERTY,
  ExperimentalBadge,
  FOCUS_RING_CLASS,
  renderSurfaceCopy,
} from "./annotation";
import {
  SCROLLBAR_HIDDEN_CLASS,
  scrollEdgeFadeStyle,
  useScrollEdges,
} from "./scroll-edges";
import {
  AppShellWireframe,
  CommandPaletteWireframe,
  ComposeScreenWireframe,
  ExtensionsPluginPageWireframe,
  RealComposerAnnotated,
  SettingsWireframe,
  SurfaceMapContext,
  useBrowserLayoutEffect,
  useSurfaceMap,
} from "./wireframes";

export const SURFACE_NUMBERS: ReadonlyMap<string, number> = new Map(
  SURFACE_GROUPS.filter((group) => group.id !== "headless").flatMap((group) =>
    group.surfaces.map((surface, index) => [surface.id, index + 1] as const),
  ),
);

type GuideSlide = Omit<SurfaceGroup, "id"> & {
  id: string;
  groupId: SurfaceGroup["id"];
  appShellScene?: "navigation" | "conversation" | "panel";
  homePanel?: boolean;
};

const DESKTOP_SLIDES: GuideSlide[] = SURFACE_GROUPS.map((group) => ({
  ...group,
  groupId: group.id,
}));
const MOBILE_SLIDES: GuideSlide[] = DESKTOP_SLIDES.flatMap((group) => {
  if (group.id === "composer") {
    return [{
      ...group,
      blurb: "Plugins can add banners, actions, providers, and rich text to the prompt box.",
    }];
  }
  if (group.id === "app-shell") {
    return [
      {
        ...group,
        title: "Sidebar",
        blurb: "Plugins can add navigation, thread status, and footer controls.",
        appShellScene: "navigation" as const,
        surfaces: group.surfaces.filter((surface) => [
          "sidebar-navigation", "nav-panel", "thread-row-status", "thread-list", "sidebar-footer",
        ].includes(surface.id)),
      },
      {
        ...group,
        id: "app-shell-thread",
        title: "Thread",
        blurb: "Plugins can extend the thread header, conversation, and composer.",
        appShellScene: "conversation" as const,
        surfaces: group.surfaces.filter((surface) => [
          "thread-header", "timeline-renderers", "message-directives", "message-actions",
          "pending-interaction", "app-overlay", "content-scripts",
        ].includes(surface.id)),
      },
      {
        ...group,
        id: "app-shell-panel",
        title: "Side panel",
        blurb: "Explore plugin controls and content in the side panel’s tabs.",
        appShellScene: "panel" as const,
        surfaces: group.surfaces.filter((surface) => [
          "code-renderers", "browser-toolbar", "thread-panel", "file-opener",
        ].includes(surface.id)),
      },
    ];
  }
  if (group.id === "home") {
    return [
      {
        ...group,
        surfaces: group.surfaces.filter((surface) => surface.id === "homepage-section"),
      },
      {
        ...group,
        id: "home-actions",
        title: "New thread actions",
        blurb: "Plugins can add an action to the new-thread panel launcher.",
        homePanel: true,
        surfaces: group.surfaces.filter((surface) => surface.id === "new-thread-panel"),
      },
    ];
  }
  return [group];
});

/** Includes authored mobile panes so a saved mobile selection can reopen. */
export function isGuidePageId(id: string): boolean {
  return MOBILE_SLIDES.some(slide => slide.id === id);
}

export function annotationNeighbors(
  surfaces: readonly PluginSurface[],
  currentId: string,
): { previous: PluginSurface | null; next: PluginSurface | null } {
  const currentIndex = surfaces.findIndex(
    (surface) => surface.id === currentId,
  );
  if (currentIndex === -1) {
    return { previous: null, next: null };
  }
  return {
    previous: surfaces[currentIndex - 1] ?? null,
    next: surfaces[currentIndex + 1] ?? null,
  };
}

function PlatformCard({ surface }: { surface: PluginSurface }) {
  const { activeId, focusedId, setActiveId, setFocusedId, expandedId, onSelect } = useSurfaceMap();
  const selected = activeId === surface.id || focusedId === surface.id || expandedId === surface.id;
  const icon = surfaceIcon(surface.id);
  return (
    <a
      href={`#surface-${surface.id}`}
      aria-label={`${surface.title} — jump to details`}
      onClick={
        onSelect
          ? (event) => {
              event.preventDefault();
              onSelect(surface.id);
            }
          : undefined
      }
      onMouseEnter={() => setActiveId(surface.id)}
      onMouseLeave={() => setActiveId(null)}
      onFocus={() => setFocusedId?.(surface.id)} onBlur={() => setFocusedId?.(null)}
      className={cn(
        "flex h-full items-center gap-3 rounded-lg border px-4 py-4 ",
        FOCUS_RING_CLASS,
        selected
          ? "border-border bg-surface-selected"
          : "border-border-hairline bg-surface-raised-solid hover:border-border hover:bg-state-hover",
      )}
    >
      {icon ? (
        <HugeiconsIcon
          icon={icon}
          className={cn(
            "size-4 shrink-0",
            selected ? "text-file-accent" : "text-foreground",
          )}
        />
      ) : null}
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {surface.title}
          </span>
          {surface.experimental ? <ExperimentalBadge /> : null}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground @3xl:line-clamp-1">
          {renderSurfaceCopy(surface.tagline ?? surface.summary)}
        </span>
      </span>
    </a>
  );
}

function PlatformSlide({ group }: { group: GuideSlide }) {
  return (
    <div className="space-y-3">
      {(group.sections ?? []).map((section) => {
        const surfaces = section.surfaceIds
          .map((id) => SURFACES_BY_ID.get(id))
          .filter((surface): surface is PluginSurface => Boolean(surface));
        return (
          <section key={section.title} aria-label={section.title}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-subtle-foreground">
              {section.title}
            </h3>
            <ul className="mt-1 grid gap-1.5 sm:grid-cols-2">
              {surfaces.map((surface) => (
                <li key={surface.id} className="min-w-0">
                  <PlatformCard surface={surface} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export const MAX_FIXTURE_SCALE = 1.2;

export function spatialFixtureScale(
  availableWidth: number,
  authoredWidth: number,
  availableHeight?: number,
  authoredHeight?: number,
): number {
  if (availableWidth <= 0 || authoredWidth <= 0) return 1;
  const heightScale =
    availableHeight !== undefined &&
    authoredHeight !== undefined &&
    availableHeight > 0 &&
    authoredHeight > 0
      ? availableHeight / authoredHeight
      : Number.POSITIVE_INFINITY;
  return Math.min(
    MAX_FIXTURE_SCALE,
    availableWidth / authoredWidth,
    heightScale,
  );
}

const FIXTURE_WIDTH_BANDS: Record<
  string,
  { min: number; max: number } | undefined
> = {
  "app-shell": { min: 1260, max: 1440 },
  "command-palette": { min: 860, max: 1200 },
  composer: { min: 720, max: 768 },
  home: { min: 560, max: 1080 },
  settings: { min: 640, max: 900 },
  extensions: { min: 640, max: 900 },
};

function SpatialFixture({
  band,
  maxScale = MAX_FIXTURE_SCALE,
  children,
}: {
  band?: { min: number; max: number };
  maxScale?: number;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const fixtureRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({
    scale: 1,
    height: null as number | null,
    width: null as number | null,
    offsetX: 0,
  });

  useBrowserLayoutEffect(() => {
    const frame = frameRef.current;
    const fixture = fixtureRef.current;
    if (!frame || !fixture) return;
    const viewport = frame.closest<HTMLElement>("[data-guide-stage-viewport]");

    const measure = () => {
      const authoredWidth = fixture.scrollWidth;
      const authoredHeight = fixture.scrollHeight;
      const availableHeight =
        viewport && frame.clientWidth >= 640
          ? viewport.clientHeight -
            (frame.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top +
              viewport.scrollTop) -
            8
          : undefined;
      const scale = Math.min(
        maxScale,
        spatialFixtureScale(
          frame.clientWidth,
          authoredWidth,
          availableHeight,
          authoredHeight,
        ),
      );
      const scaled = Math.abs(scale - 1) >= 0.0001;
      const height = authoredHeight * scale;
      const width = scaled ? authoredWidth : null;
      const offsetX = scaled ? (frame.clientWidth - authoredWidth) / 2 : 0;
      setGeometry((current) =>
        Math.abs(current.scale - scale) < 0.0001 &&
        current.height === height &&
        current.width === width &&
        Math.abs(current.offsetX - offsetX) < 0.5
          ? current
          : { scale, height, width, offsetX },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(fixture);
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  }, [maxScale]);

  const scaled = geometry.width !== null;
  return (
    <div
      ref={frameRef}
      data-guide-responsive-strategy="scale-together"
      data-guide-scale={geometry.scale.toFixed(4)}
      className="w-full"
      style={{ height: geometry.height ?? undefined }}
    >
      <div
        ref={fixtureRef}
        className="mx-auto w-full origin-top "
        style={
          {
            minWidth: band?.min,
            maxWidth: band?.max,
            [CHIP_COUNTER_SCALE_PROPERTY]: annotationChipCounterScale(
              geometry.scale,
            ),
            ...(scaled
              ? {
                  transform: `scale(${geometry.scale})`,
                  width: geometry.width ?? undefined,
                  marginLeft: geometry.offsetX,
                  marginRight: 0,
                }
              : undefined),
          } as CSSProperties
        }
      >
        {children}
      </div>
    </div>
  );
}

function SlideContent({
  group,
  mobile = false,
}: {
  group: GuideSlide;
  mobile?: boolean;
}) {
  switch (group.groupId) {
    case "app-shell":
      return <AppShellWireframe mobile={mobile} mobileScene={group.appShellScene} />;
    case "command-palette":
      return <CommandPaletteWireframe mobile={mobile} />;
    case "composer":
      return <RealComposerAnnotated mobile={mobile} />;
    case "home":
      return <ComposeScreenWireframe mobile={mobile} panel={group.homePanel} />;
    case "settings":
      return <SettingsWireframe mobile={mobile} />;
    case "extensions":
      return <ExtensionsPluginPageWireframe mobile={mobile} />;
    case "headless":
      return <PlatformSlide group={group} />;
  }
}

function Slide({
  group,
  mobile,
  viewportMobile,
}: {
  group: GuideSlide;
  mobile: boolean;
  viewportMobile: boolean;
}) {
  if (mobile && viewportMobile && group.id !== "headless") {
    return (
      <div
        data-guide-responsive-strategy="mobile"
        className="mx-auto w-full max-w-[430px]"
      >
        <SlideContent group={group} mobile />
      </div>
    );
  }
  if (fixtureResponsiveStrategy(group) === "reflow") {
    return (
      <div data-guide-responsive-strategy="reflow" className="w-full">
        <SlideContent group={group} />
      </div>
    );
  }
  return (
    <>
      <SpatialFixture
        band={mobile ? { min: 430, max: 430 } : FIXTURE_WIDTH_BANDS[group.groupId]}
        maxScale={mobile ? 1 : MAX_FIXTURE_SCALE}
      >
        <SlideContent group={group} mobile={mobile} />
      </SpatialFixture>
    </>
  );
}

function SlideTitle({ title }: { title: string }) {
  const parts = title.split(/\bbb\b/);
  if (parts.length === 1) {
    return <>{title}</>;
  }
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="font-bold italic">bb</span> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export function panCarets(
  index: number,
  slideCount: number,
): { previous: boolean; next: boolean } {
  return { previous: index > 0, next: index < slideCount - 1 };
}

function PanButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${direction === "previous" ? "Previous" : "Next"} surface`}
      className={cn(
        "inline-flex size-10 @2xl/guide:size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        FOCUS_RING_CLASS,
      )}
    >
      <Icon
        name={direction === "previous" ? "ChevronLeft" : "ChevronRight"}
        className="size-4"
      />
    </button>
  );
}

export function ProductMap({
  pluginPageHref,
  renderPluginIcon,
  initialSlideId,
  onSlideChange,
  onCopyForAgent,
  sessionSignal,
}: {
  pluginPageHref?: (displayName: string) => string | null;
  renderPluginIcon?: (displayName: string) => ReactNode;
  initialSlideId?: string;
  onSlideChange?: (slideId: string) => void;
  onCopyForAgent?: (surface: PluginSurface) => Promise<boolean>;
  sessionSignal?: AbortSignal;
}) {
  const descriptionPrefix = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const pageListRef = useRef<HTMLDivElement>(null);
  const pageButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const card = useSurfaceCard(() => pageListRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? null);
  const pendingPageFocus = useRef<HTMLElement | null>(null);
  const referenceOpener = useRef<string | null>(null);
  const referenceColumnRef = useRef<HTMLElement | null>(null);
  const referenceScroll = useRef(0);
  const guideScroll = useRef<{ element: HTMLElement; top: number; left: number } | null>(null);
  const pendingScrollReturn = useRef(false);
  const pendingReferenceFocus = useRef<string | null>(null);
  const pendingInspectorFocus = useRef(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [viewportMobile, setViewportMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 767px)").matches === true,
  );
  const [displayMode, setDisplayMode] = useState<"mobile" | "desktop" | null>(
    null,
  );
  const mobile =
    displayMode === null ? viewportMobile : displayMode === "mobile";
  const slides = mobile ? MOBILE_SLIDES : DESKTOP_SLIDES;
  const numbers = useMemo(() => new Map(
    slides.filter((slide) => slide.groupId !== "headless").flatMap((slide) =>
      slide.surfaces.map((surface, index) => [surface.id, index + 1] as const),
    ),
  ), [slides]);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 767px)");
    if (!query) return;
    const update = () => setViewportMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const selectSurface = (id: string) => {
    setFocusId(null);
    const active = document.activeElement;
    const outsideInspector = !(active instanceof Element && active.closest('[data-guide-card]'));
    if (!card.openId) referenceScroll.current = referenceColumnRef.current?.scrollTop ?? 0;
    if (!card.openId || outsideInspector) {
      const viewport = containerRef.current?.closest<HTMLElement>('[data-guide-stage-viewport]');
      guideScroll.current = viewport ? { element: viewport, top: viewport.scrollTop, left: viewport.scrollLeft } : null;
      pendingInspectorFocus.current = true;
    }
    card.open(id);
  };
  const closeSurface = () => {
    const active = document.activeElement;
    const owned = active instanceof Element && !!active.closest('[data-guide-card]');
    pendingScrollReturn.current = owned;
    if (referenceOpener.current && owned) pendingReferenceFocus.current = referenceOpener.current;
    referenceOpener.current = null;
    card.close();
    setHoverId(null);
  };
  useBrowserLayoutEffect(() => {
    if (referenceColumnRef.current) referenceColumnRef.current.scrollTop = card.openId ? 0 : referenceScroll.current;
    if (!card.openId && pendingScrollReturn.current) {
      pendingScrollReturn.current = false;
      const saved = guideScroll.current;
      if (saved?.element.isConnected) {
        saved.element.scrollTop = saved.top;
        saved.element.scrollLeft = saved.left;
      }
      guideScroll.current = null;
    }
    if (card.openId && pendingInspectorFocus.current) {
      pendingInspectorFocus.current = false;
      containerRef.current?.querySelector<HTMLButtonElement>('[data-guide-card] button[aria-label="Close"]')?.focus({ preventScroll: true });
    } else if (!card.openId && pendingReferenceFocus.current) {
      const id = pendingReferenceFocus.current;
      pendingReferenceFocus.current = null;
      const active = document.activeElement;
      if (active === document.body || active === pageListRef.current?.querySelector('[aria-current="true"]')) {
        containerRef.current?.querySelector<HTMLButtonElement>(`[data-guide-reference="${id}"]`)?.focus({ preventScroll: true });
      }
    }
  }, [card.openId]);
  useEffect(() => {
    const engagedId = hoverId ?? focusId;
    if (!engagedId || card.openId) return;
    const column = referenceColumnRef.current;
    const row = column?.querySelector<HTMLElement>(`[data-guide-reference="${engagedId}"]`);
    if (!column || !row) return;
    const bounds = column.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) column.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) column.scrollTop += item.bottom - bounds.bottom;
  }, [hoverId, focusId, card.openId]);
  const pageListEdges = useScrollEdges(pageListRef);
  const [slideId, setSlideId] = useState(initialSlideId ?? "app-shell");
  const previousMobile = useRef(mobile);
  useBrowserLayoutEffect(() => {
    if (previousMobile.current === mobile) return;
    previousMobile.current = mobile;
    if (!mobile || !card.openId) return;
    const destination = slides.find((slide) =>
      slide.surfaces.some((surface) => surface.id === card.openId),
    );
    if (destination && destination.id !== slideId) {
      setSlideId(destination.id);
      onSlideChange?.(destination.id);
    }
  }, [mobile, card.openId, slides, slideId, onSlideChange]);
  const selectedSlide = MOBILE_SLIDES.find((slide) => slide.id === slideId);
  const index = Math.max(0, slides.findIndex((slide) =>
    slide.id === slideId || (!mobile && slide.id === selectedSlide?.groupId),
  ));

  useBrowserLayoutEffect(() => {
    const previous = pendingPageFocus.current;
    pendingPageFocus.current = null;
    if (previous && (document.activeElement === previous || document.activeElement === document.body) &&
        (previous.closest('[hidden], [inert]') || !previous.isConnected)) {
      pageButtonRefs.current[index]?.focus({ preventScroll: true });
    }
  }, [index]);

  useEffect(() => {
    if (viewportMobile) return;
    const list = pageListRef.current;
    const button = pageButtonRefs.current[index];
    if (!list || !button) return;
    const listRect = list.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const leftDelta = buttonRect.left - listRect.left;
    const rightDelta = buttonRect.right - listRect.right;
    if (leftDelta < 0) list.scrollLeft += leftDelta;
    else if (rightDelta > 0) list.scrollLeft += rightDelta;
  }, [index, viewportMobile]);

  const openSurface = card.openId ? SURFACES_BY_ID.get(card.openId) : undefined;
  const carets = panCarets(index, slides.length);

  const show = (next: number) => {
    if (next === index || next < 0 || next >= slides.length) {
      return;
    }
    referenceOpener.current = null;
    referenceScroll.current = 0;
    guideScroll.current = null;
    pendingScrollReturn.current = false;
    pendingReferenceFocus.current = null;
    card.close();
    setHoverId(null);
    setFocusId(null);
    setSlideId(slides[next].id);
    onSlideChange?.(slides[next].id);
  };

  const goToSurface = (id: string) => {
    const group = GROUP_BY_SURFACE_ID.get(id);
    if (!group) return;
    const target = slides.findIndex((slide) =>
      slide.surfaces.some((surface) => surface.id === id),
    );
    if (target === -1) return;
    if (target !== index) show(target);
    selectSurface(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || sessionSignal?.aborted ||
        guideEditableTarget(event.target) || guideInnerLayer(event.target)) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      pendingPageFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      show(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      pendingPageFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      show(index - 1);
    }
  };

  const mapState = useMemo(
    () => ({
      activeId: hoverId,
      setActiveId: setHoverId,
      focusedId: focusId,
      setFocusedId: setFocusId,
      expandedId: card.openId,
      numberOf: (id: string) => numbers.get(id) ?? null,
      onSelect: (id: string) => {
        referenceOpener.current = null;
        selectSurface(id);
      },
      pluginPageHref,
      renderPluginIcon,
      currentGroupId: slides[index].groupId,
      onGoToSurface: goToSurface,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      hoverId,
      focusId,
      card.openId,
      pluginPageHref,
      renderPluginIcon,
      index,
      mobile,
      slides,
      numbers,
    ],
  );

  const cardNode = openSurface ? (
    <div
      className="w-full"
    >
      <SurfaceCard
        surface={openSurface}
        referenceNote={surfaceReferenceNote(openSurface.id)}
        mobile={viewportMobile}
        number={numbers.get(openSurface.id) ?? null}
        onDismiss={closeSurface}
        onCopyForAgent={onCopyForAgent}
        sessionSignal={sessionSignal}
        navigation={{
          ...annotationNeighbors(slides[index].surfaces, openSurface.id),
          onOpen: selectSurface,
        }}
      />
    </div>
  ) : null;
  useEffect(() => {
    if (card.openId === null) return;
    const container = containerRef.current;
    if (container === null) return;
    const scope =
      container.closest<HTMLElement>("[data-guide-frame]") ??
      container.closest<HTMLElement>("[data-bb-plugin]") ?? container;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (sessionSignal?.aborted || event.defaultPrevented || guideInnerLayer(target)) return;
      if (
        target.closest(
          'a[href^="#surface-"], [data-guide-display-mode]',
        )
      )
        return;
      closeSurface();
    };
    scope.addEventListener("pointerdown", onPointerDown);
    return () => scope.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.openId, sessionSignal]);

  const onContentKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !card.openId || sessionSignal?.aborted) return;
    const layer = guideInnerLayer(event.target);
    if (layer && !layer.hasAttribute("data-guide-card")) return;
    event.preventDefault();
    event.stopPropagation();
    closeSurface();
  };

  return (
    <SurfaceMapContext.Provider value={mapState}>
      <div ref={containerRef} onKeyDown={onContentKeyDown} className="@container/guide relative">
        <div data-map-column className="mx-auto w-full max-w-[100rem]">
          <section
            aria-roledescription="carousel"
            aria-label="bb surfaces a plugin can extend"
            onKeyDown={onKeyDown}
            className="mt-1"
          >
            <div
              data-guide-navigation-toolbar
              className="flex w-full items-center gap-2"
            >
              <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
                <PanButton
                  direction="previous"
                  disabled={!carets.previous}
                  onClick={() => show(index - 1)}
                />
                <div
                  ref={pageListRef}
                  data-guide-page-list-scroll
                  data-no-secondary-panel-swipe
                  className={cn(
                    viewportMobile
                      ? "min-w-0 flex-1 touch-pan-y overflow-hidden"
                      : "min-w-0 overflow-x-auto",
                    SCROLLBAR_HIDDEN_CLASS,
                  )}
                  style={
                    viewportMobile
                      ? undefined
                      : scrollEdgeFadeStyle(
                          pageListEdges.canScrollLeft,
                          pageListEdges.canScrollRight,
                        )
                  }
                  onTouchStartCapture={(event) => {
                    suppressClickUntil.current = 0;
                    const touch = event.touches[0];
                    touchStart.current =
                      viewportMobile && event.touches.length === 1 && touch
                        ? { x: touch.clientX, y: touch.clientY }
                        : null;
                  }}
                  onTouchCancelCapture={() => {
                    touchStart.current = null;
                  }}
                  onTouchEndCapture={(event) => {
                    const start = touchStart.current;
                    touchStart.current = null;
                    const touch = event.changedTouches[0];
                    if (!start || !touch) return;
                    const dx = touch.clientX - start.x;
                    const dy = touch.clientY - start.y;
                    if (Math.abs(dx) < 30 || Math.abs(dx) <= Math.abs(dy))
                      return;
                    suppressClickUntil.current = Date.now() + 500;
                    show(index + (dx < 0 ? 1 : -1));
                  }}
                  onClickCapture={(event) => {
                    if (Date.now() >= suppressClickUntil.current) return;
                    suppressClickUntil.current = 0;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <ul
                    className={
                      viewportMobile
                        ? "flex w-full flex-nowrap items-center"
                        : "flex w-max flex-nowrap items-center gap-1"
                    }
                  >
                    {slides.map((entry, slideIndex) => (
                      <li
                        key={entry.id}
                        hidden={viewportMobile && slideIndex !== index}
                        className={cn("shrink-0", viewportMobile && "w-full")}
                      >
                        <button
                          ref={(element) => {
                            pageButtonRefs.current[slideIndex] = element;
                          }}
                          type="button"
                          onClick={() => show(slideIndex)}
                          aria-current={
                            slideIndex === index ? "true" : undefined
                          }
                          className={cn(
                            "cursor-pointer whitespace-nowrap rounded-md px-2 py-2 text-xs @2xl/guide:py-1 @2xl/guide:text-xs ",
                            viewportMobile && "block w-full truncate",
                            FOCUS_RING_CLASS,
                            slideIndex === index
                              ? "bg-surface-selected text-foreground"
                              : "text-subtle-foreground hover:bg-state-hover hover:text-foreground",
                          )}
                        >
                          {entry.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <PanButton
                  direction="next"
                  disabled={!carets.next}
                  onClick={() => show(index + 1)}
                />
              </div>
              <div
                data-guide-display-mode
                role="group"
                aria-label="Preview layout"
                className="flex shrink-0 items-center gap-0.5 border-l border-border-hairline pl-2"
              >
                <span data-guide-current-page aria-hidden="true" className="text-xs font-medium">{slides[index].title}</span>
                {(["mobile", "desktop"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-label={
                      mode === "mobile" ? "Mobile layout" : "Desktop layout"
                    }
                    title={
                      mode === "mobile" ? "Mobile layout" : "Desktop layout"
                    }
                    aria-pressed={(mobile ? "mobile" : "desktop") === mode}
                    onClick={() => setDisplayMode(mode)}
                    className={cn(
                      "inline-flex size-10 @2xl/guide:size-8 cursor-pointer items-center justify-center rounded-md",
                      FOCUS_RING_CLASS,
                      (mobile ? "mobile" : "desktop") === mode
                        ? "bg-surface-selected text-foreground"
                        : "text-muted-foreground hover:bg-state-hover",
                    )}
                  >
                    <HugeiconsIcon
                      icon={mode === "mobile" ? SmartPhone01Icon : ComputerIcon}
                      className="size-4"
                      aria-hidden
                    />
                  </button>
                ))}
              </div>
            </div>
            <div className="nerd-guide-reference-layout">
            <div data-guide-map-canvas className="min-w-0 overflow-x-clip">
              {slides.map((entry, slideIndex) => (
                <div key={entry.id} data-map-section={entry.id}
                  hidden={slideIndex !== index} inert={slideIndex !== index}
                  className="min-w-0 w-full shrink-0 self-start px-4 pt-2">
                  {slideIndex === index ? <Slide group={entry} mobile={mobile} viewportMobile={viewportMobile} /> : null}
                </div>
              ))}
            </div>

            <aside ref={referenceColumnRef} data-guide-reference-column aria-label="Surface reference" tabIndex={0} className="nerd-guide-reference-column">
              {cardNode ?? (
                <>
                  <div data-guide-screen-info className="mb-3 border-b border-border-hairline pb-3">
                    <h2 className="text-sm font-semibold"><SlideTitle title={slides[index].title} /></h2>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{slides[index].blurb}</p>
                  </div>
                  <ol data-guide-reference-list className="space-y-1">
                    {slides[index].surfaces.map(surface => {
                      const number = numbers.get(surface.id) ?? null;
                      const active = hoverId === surface.id || focusId === surface.id;
                      return <li key={surface.id}>
                        <button type="button" data-guide-reference={surface.id} data-active={active || undefined}
                          aria-label={`${number === null ? '' : `${number}. `}${surfaceLabel(surface.id)}`}
                          aria-describedby={`${descriptionPrefix}-${surface.id}-description`}
                          onMouseEnter={() => setHoverId(surface.id)} onMouseLeave={() => setHoverId(null)}
                          onFocus={() => setFocusId(surface.id)} onBlur={() => setFocusId(null)}
                          onClick={() => {
                            referenceOpener.current = surface.id;
                            pendingInspectorFocus.current = true;
                            selectSurface(surface.id);
                          }}
                          className={`nerd-guide-reference-row w-full text-left ${FOCUS_RING_CLASS}`}>
                          {number !== null ? <span aria-hidden data-guide-reference-number className={annotationChipClass(active, undefined, number)}>{number}</span> : null}
                          <span className="min-w-0">
                            <span className="block text-xs font-medium">{surfaceLabel(surface.id)}</span>
                            <span id={`${descriptionPrefix}-${surface.id}-description`} className="block">
                              {surface.experimental ? <ExperimentalBadge /> : null}
                              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{surfaceLocation(surface.id)}</span>
                              <code className="mt-1 block break-all text-[10px] text-muted-foreground">{surfacePrimaryApi(surface.id)}</code>
                            </span>
                          </span>
                        </button>
                      </li>;
                    })}
                  </ol>
                </>
              )}
            </aside>
            </div>
          </section>
        </div>
      </div>
    </SurfaceMapContext.Provider>
  );
}
