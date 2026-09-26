/**
 * Production execution is fail-closed until a qualified snapshot-only,
 * pre-exec OS-isolated launcher is integrated. Offline runtime code is not
 * imported or exposed by this production entry.
 */
export async function createQueryRuntime() {
  const error = new Error("Analytics execution isolation is not available.");
  Object.assign(error, { code: "isolation-unavailable" });
  throw error;
}
