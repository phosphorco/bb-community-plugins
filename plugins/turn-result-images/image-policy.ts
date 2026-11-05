/** Shared fresh/store/cache bound: a source must not acknowledge a binding
 * that its own later cache reader cannot admit. Full observation rows are
 * separately bounded because they retain history plus the last resolution.
 */
export const MAX_MATERIALIZATION_BYTES = 8192;
