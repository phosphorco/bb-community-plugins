export function panelPath(projectId: string | null, path = "") {
  return (
    (projectId
      ? "project/" + encodeURIComponent(projectId) + (path ? "/" : "")
      : "") + path
  );
}
export function panelScope(path: string, fallback: string | null) {
  const parts = path.split("/");
  if (parts[0] !== "project" || !parts[1]) return { projectId: fallback, path };
  try {
    return {
      projectId: decodeURIComponent(parts[1]),
      path: parts.slice(2).join("/"),
    };
  } catch {
    return { projectId: null, path: "" };
  }
}
