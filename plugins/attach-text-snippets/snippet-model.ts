export const MAX_SNIPPET_BYTES = 1_048_576;

export interface StoredSnippet {
  id: string;
  threadId: string;
  title: string;
  relativePath: string;
  sizeBytes: number;
  createdAt: number;
}

export function defaultSnippetTitle(now: number): string {
  return `Snippet ${new Date(now).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function normalizeSnippetTitle(title: string, now: number): string {
  return title.trim().replace(/\s+/gu, " ").slice(0, 120) || defaultSnippetTitle(now);
}

export function snippetRelativePath(title: string, id: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56) || "snippet";
  const suffix = id.replace(/[^a-z0-9]/giu, "").slice(0, 12).toLowerCase();
  return `attach-text-snippets/${slug}-${suffix}.txt`;
}

export function absoluteSnippetPath(storageRootPath: string, relativePath: string): string {
  return `${storageRootPath.replace(/\/+$/u, "")}/${relativePath}`;
}

function markdownLinkTarget(path: string): string {
  return path.includes(" ") || path.includes("(") || path.includes(")") ? `<${path}>` : path;
}

function markdownLinkLabel(label: string): string {
  return label.replace(/[\\\[\]]/gu, (character) => `\\${character}`);
}

export function snippetMentionContext(snippet: StoredSnippet, absolutePath: string): string {
  const target = markdownLinkTarget(absolutePath);
  return [
    "The user attached a pasted-text snippet as a durable file reference.",
    `Read the file at ${absolutePath} before responding when its contents are relevant.`,
    "The pasted body is intentionally not duplicated into this prompt context.",
    `To pass the same reference onward, use this native file link: [${markdownLinkLabel(snippet.title)}](${target}).`,
  ].join("\n");
}

export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
