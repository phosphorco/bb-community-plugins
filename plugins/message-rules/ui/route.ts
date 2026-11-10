import { GLOBAL_CATALOG } from "../contracts/catalog.ts";
export function panelPath(projectId: string | null, path = "") {
  return (
    (projectId && projectId !== GLOBAL_CATALOG
      ? "project/" + encodeURIComponent(projectId) + (path ? "/" : "")
      : "") + path
  );
}
export function panelScope(path: string, fallback: string | null) {
  const parts = path.split("/");
  if (parts[0] !== "project" || !parts[1])
    return { projectId: GLOBAL_CATALOG, path, legacyProjectId: undefined };
  try {
    return {
      projectId: GLOBAL_CATALOG,
      legacyProjectId:
        decodeURIComponent(parts[1]) === GLOBAL_CATALOG
          ? undefined
          : decodeURIComponent(parts[1]),
      path: parts.slice(2).join("/"),
    };
  } catch {
    return { projectId: null, path: "" };
  }
}
