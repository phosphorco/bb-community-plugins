/** Host-owned, bounded geometry. Rendering/content and occurrence framing stay
 * outside this module; a custom canvas cannot reserve its own page/viewport.
 */
export const INLINE_RESULT_CEILING = 64;
export const GALLERY_GAP_PX = 12;
export const MIN_COLUMN_PX = 152;
export interface PackingItem { key: string; width: number; height: number }
export interface PackedResult { key: string; order: number; column: number; row: number; width: number; height: number }
export interface ResultPacking { columns: number; rows: number; placements: PackedResult[] }
function integer(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid gallery ${field}.`);
  return value;
}
export function paneColumns(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx < 0) throw new RangeError('Invalid gallery pane width.');
  return Math.max(1, Math.min(4, Math.floor((widthPx + GALLERY_GAP_PX) / (MIN_COLUMN_PX + GALLERY_GAP_PX))));
}
/** A ceiling is not a target: narrow panes start with fewer cards, and large
 * turns need an explicit continuation. Caller admits the chosen prefix first.
 */
export function initialResultLimit(columns: number): number {
  integer(columns, 1, 4, 'columns');
  return columns === 1 ? 2 : columns === 2 ? 4 : 8;
}
/** Stable first-fit rectangles with explicit grid positions. DOM/tab order is
 * exactly input order, never CSS dense/order or provider load completion order.
 * Spans are already host-admitted; width is clamped to the local pane columns.
 * Callers keep admitted spans stable during late content/media resolution and
 * preserve the native reading anchor when resize/continuation changes geometry.
 */
export function packResults(items: readonly PackingItem[], columns: number): ResultPacking {
  integer(columns, 1, 4, 'columns');
  if (items.length > INLINE_RESULT_CEILING) throw new RangeError('Gallery prefix needs continuation.');
  const seen = new Set<string>(), occupied: number[] = [], placements: PackedResult[] = [];
  const maxRows = INLINE_RESULT_CEILING * 4;
  for (const [order, item] of items.entries()) {
    if (!item.key || new TextEncoder().encode(item.key).length > 1024 || seen.has(item.key)) throw new TypeError('Gallery keys must be unique bounded identities.');
    seen.add(item.key);
    const width = Math.min(columns, integer(item.width, 1, 4, 'span width'));
    const height = integer(item.height, 1, 4, 'span height');
    let placed = false;
    for (let row = 0; row <= maxRows - height && !placed; row++) {
      for (let column = 0; column <= columns - width; column++) {
        const mask = ((1 << width) - 1) << column;
        let free = true;
        for (let offset = 0; offset < height; offset++) if ((occupied[row + offset] ?? 0) & mask) { free = false; break; }
        if (!free) continue;
        for (let offset = 0; offset < height; offset++) occupied[row + offset] = (occupied[row + offset] ?? 0) | mask;
        placements.push({ key: item.key, order, column, row, width, height });
        placed = true; break;
      }
    }
    if (!placed) throw new RangeError('Gallery packing capacity exceeded.');
  }
  return { columns, rows: occupied.length, placements };
}
