export interface FrameRect { x: number; y: number; width: number; height: number }
export interface Viewport { x: number; y: number; width: number; height: number }
export const GEOMETRY_KEY = 'plugin-guide-for-nerds:geometry:v1';

export function readViewport(): Viewport {
  const viewport = window.visualViewport;
  return viewport ? {
    x: viewport.offsetLeft, y: viewport.offsetTop,
    width: viewport.width, height: viewport.height,
  } : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

export function clampFrame(rect: FrameRect, viewport: Viewport): FrameRect {
  const margin = Math.min(8, viewport.width / 2, viewport.height / 2);
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  // Minimum size never exceeds the actual available viewport.
  const width = Math.min(availableWidth, Math.max(280, rect.width));
  const height = Math.min(availableHeight, Math.max(180, rect.height));
  return {
    width, height,
    x: Math.max(viewport.x + margin, Math.min(rect.x, viewport.x + viewport.width - width - margin)),
    y: Math.max(viewport.y + margin, Math.min(rect.y, viewport.y + viewport.height - height - margin)),
  };
}

export function initialFrame(viewport: Viewport): FrameRect {
  let saved: FrameRect | null = null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(GEOMETRY_KEY) ?? 'null');
    if (value && typeof value === 'object') {
      const candidate = value as Record<string, unknown>;
      if (['x', 'y', 'width', 'height'].every(key =>
        typeof candidate[key] === 'number' && Number.isFinite(candidate[key]) && Math.abs(candidate[key] as number) <= 100_000,
      )) saved = candidate as unknown as FrameRect;
    }
  } catch { /* Geometry is optional when storage is denied or invalid. */ }
  return clampFrame(saved ?? {
    x: viewport.x + viewport.width - 980, y: viewport.y + 68,
    width: 960, height: 720,
  }, viewport);
}

export function saveFrame(rect: FrameRect): void {
  try { window.localStorage.setItem(GEOMETRY_KEY, JSON.stringify(rect)); }
  catch { /* A denied persistence write must not interrupt interaction. */ }
}
