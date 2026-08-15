export type ThemeTokenKind = "fill" | "text" | "border" | "ring";

export interface ThemeToken {
  readonly role: string;
  readonly variable: string;
  readonly utility: string;
  readonly kind: ThemeTokenKind;
  readonly foreground?: string;
  readonly guidance: string;
}

export interface ThemeTokenGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tokens: readonly ThemeToken[];
}

/**
 * Complete snapshot of BB 0.37's public plugin color bridge. Runtime discovery
 * supplements this list so newly added host tokens appear without a plugin
 * release; this remains the fallback when browser stylesheet access is denied.
 */
export const PUBLIC_THEME_TOKEN_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--subtle-foreground",
  "--readback-foreground",
  "--timeline-accent",
  "--file-accent",
  "--accent",
  "--accent-foreground",
  "--state-hover",
  "--state-active",
  "--destructive",
  "--destructive-foreground",
  "--destructive-text",
  "--attention",
  "--warning",
  "--warning-text",
  "--success",
  "--success-foreground",
  "--diff-added",
  "--pr-merged",
  "--diff-removed",
  "--border",
  "--border-hairline",
  "--border-seam",
  "--border-seam-vertical",
  "--input",
  "--ring",
  "--surface-recessed",
  "--surface-recessed-solid",
  "--surface-recessed-soft-solid",
  "--surface-raised",
  "--surface-raised-solid",
  "--surface-scrim",
  "--surface-destructive",
  "--surface-destructive-border",
  "--surface-attention",
  "--surface-selected",
  "--surface-selected-border",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
] as const;

const TOKEN_BRIDGE_PATTERN = /--color-([a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/giu;

const TOKEN_GUIDANCE: Readonly<Record<string, string>> = {
  "--background": "The app canvas behind primary content.",
  "--foreground": "Default high-emphasis text and icons.",
  "--card": "Contained content that sits on the app canvas.",
  "--card-foreground": "Text and icons placed on cards.",
  "--popover": "Floating menus, dialogs, and inspectors.",
  "--popover-foreground": "Text and icons inside floating surfaces.",
  "--primary": "The strongest action or current emphasis.",
  "--primary-foreground": "Content placed directly on primary.",
  "--secondary": "A quieter action or supporting control.",
  "--secondary-foreground": "Content placed directly on secondary.",
  "--muted": "Low-emphasis controls and quiet regions.",
  "--muted-foreground": "Supporting labels and secondary copy.",
  "--subtle-foreground": "De-emphasized chrome that stays readable.",
  "--readback-foreground": "Read-only values and transcript-like content.",
  "--timeline-accent": "Identity and emphasis within thread timelines.",
  "--file-accent": "Identity and emphasis for file experiences.",
  "--accent": "Hoverable or highlighted control surfaces.",
  "--accent-foreground": "Content placed directly on accent.",
  "--state-hover": "Generic hovered-state surface treatment.",
  "--state-active": "Generic pressed or active-state treatment.",
  "--destructive": "Strong destructive actions and danger emphasis.",
  "--destructive-foreground": "Content placed on destructive fills.",
  "--destructive-text": "Danger text shown without a filled surface.",
  "--attention": "Information that needs immediate notice.",
  "--warning": "Caution states and warning emphasis.",
  "--warning-text": "Warning copy shown without a filled surface.",
  "--success": "Successful outcomes and positive state.",
  "--success-foreground": "Content placed on success fills.",
  "--diff-added": "Added lines or positive code changes.",
  "--pr-merged": "Merged pull-request state only.",
  "--diff-removed": "Removed lines or negative code changes.",
  "--border": "Default boundaries between controls and regions.",
  "--border-hairline": "The quietest visible outline or divider.",
  "--border-seam": "A stronger seam between adjacent regions.",
  "--border-seam-vertical": "Vertical seams tuned for side-by-side regions.",
  "--input": "Input outlines and editable-field boundaries.",
  "--ring": "Keyboard focus and active-control rings.",
  "--surface-recessed": "A nested area visually below its parent.",
  "--surface-recessed-solid": "An opaque recessed area over complex content.",
  "--surface-recessed-soft-solid": "A gentler opaque recessed area.",
  "--surface-raised": "Content visually lifted above its parent.",
  "--surface-raised-solid": "An opaque raised layer over complex content.",
  "--surface-scrim": "A backdrop that separates an overlay from content.",
  "--surface-destructive": "A quiet background for destructive messaging.",
  "--surface-destructive-border": "The boundary around destructive messaging.",
  "--surface-attention": "A quiet background for attention messaging.",
  "--surface-selected": "The background of a selected row or region.",
  "--surface-selected-border": "The boundary reinforcing selected state.",
  "--sidebar": "The app sidebar's dedicated canvas.",
  "--sidebar-foreground": "Primary text and icons in the sidebar.",
  "--sidebar-accent": "Hovered or selected sidebar rows.",
  "--sidebar-accent-foreground": "Content placed on sidebar accent.",
  "--sidebar-border": "Dividers and boundaries within the sidebar.",
  "--sidebar-ring": "Keyboard focus rings in the sidebar.",
};

const TOKEN_GROUPS = [
  {
    id: "color-emphasis",
    title: "Color & emphasis",
    description: "Start here for primary actions and BB domain accents.",
    variables: ["--primary", "--primary-foreground", "--timeline-accent", "--file-accent", "--accent", "--accent-foreground"],
  },
  {
    id: "status-change",
    title: "Status & change",
    description: "Use these only when the matching outcome or code state is true.",
    variables: ["--success", "--success-foreground", "--attention", "--warning", "--warning-text", "--destructive", "--destructive-foreground", "--destructive-text", "--diff-added", "--pr-merged", "--diff-removed", "--surface-attention", "--surface-destructive", "--surface-destructive-border"],
  },
  {
    id: "interaction-selection",
    title: "Interaction & selection",
    description: "Communicate hover, press, focus, and persistent selection.",
    variables: ["--secondary", "--secondary-foreground", "--state-hover", "--state-active", "--surface-selected", "--surface-selected-border", "--ring"],
  },
  {
    id: "content-layers",
    title: "Content & layers",
    description: "Build the canvas, containers, overlays, and depth hierarchy.",
    variables: ["--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground", "--muted", "--muted-foreground", "--surface-recessed", "--surface-recessed-solid", "--surface-recessed-soft-solid", "--surface-raised", "--surface-raised-solid", "--surface-scrim"],
  },
  {
    id: "text-hierarchy",
    title: "Text hierarchy",
    description: "Choose how strongly supporting and read-only content speaks.",
    variables: ["--subtle-foreground", "--readback-foreground"],
  },
  {
    id: "structure",
    title: "Structure & fields",
    description: "Separate regions and identify editable boundaries.",
    variables: ["--border", "--border-hairline", "--border-seam", "--border-seam-vertical", "--input"],
  },
  {
    id: "sidebar",
    title: "Sidebar chrome",
    description: "Use the sidebar-specific family inside the app sidebar only.",
    variables: ["--sidebar", "--sidebar-foreground", "--sidebar-accent", "--sidebar-accent-foreground", "--sidebar-border", "--sidebar-ring"],
  },
] as const;

export function discoverThemeTokenVariables(cssTexts: readonly string[]): string[] {
  const discovered = new Set<string>();
  for (const cssText of cssTexts) {
    for (const match of cssText.matchAll(TOKEN_BRIDGE_PATTERN)) {
      const utilityName = match[1];
      const variable = match[2];
      if (utilityName != null && variable != null && `--color-${utilityName}` !== variable) {
        discovered.add(variable);
      } else if (variable != null) {
        discovered.add(variable);
      }
    }
  }
  return [...discovered];
}

function labelFor(variable: string): string {
  return variable
    .slice(2)
    .split("-")
    .map((part) => part.length === 0 ? part : `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function kindFor(variable: string): ThemeTokenKind {
  if (variable === "--ring" || variable.endsWith("-ring")) return "ring";
  if (variable === "--input" || variable.includes("border")) return "border";
  if (variable === "--foreground" || variable.endsWith("-foreground") || variable.endsWith("-text")) return "text";
  return "fill";
}

function foregroundFor(variable: string, variables: ReadonlySet<string>): string | undefined {
  const candidate = `${variable}-foreground`;
  return variables.has(candidate) ? candidate : undefined;
}

export function buildThemeTokens(discovered: readonly string[] = []): ThemeToken[] {
  const variables = new Set<string>([...PUBLIC_THEME_TOKEN_VARIABLES, ...discovered]);
  return [...variables].map((variable) => ({
    role: labelFor(variable),
    variable,
    utility: `--color-${variable.slice(2)}`,
    kind: kindFor(variable),
    foreground: foregroundFor(variable, variables),
    guidance: TOKEN_GUIDANCE[variable] ?? "A semantic color exposed by the current BB theme.",
  }));
}

export function groupThemeTokens(tokens: readonly ThemeToken[]): ThemeTokenGroup[] {
  const remaining = new Map(tokens.map((token) => [token.variable, token]));
  const groups: ThemeTokenGroup[] = TOKEN_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    tokens: group.variables.flatMap((variable) => {
      const token = remaining.get(variable);
      if (token == null) return [];
      remaining.delete(variable);
      return [token];
    }),
  })).filter((group) => group.tokens.length > 0);
  if (remaining.size > 0) {
    groups.push({
      id: "newly-exposed",
      title: "Newly exposed",
      description: "Additional semantic colors discovered from this BB version.",
      tokens: [...remaining.values()],
    });
  }
  return groups;
}

export const SURFACE_MAP_SECTIONS = [
  { id: 1, title: "1 · App shell", tabLabel: "App Shell", viewBox: "24 4 772 462" },
  { id: 2, title: "2 · Thread workspace", tabLabel: "Thread Workspace", viewBox: "804 4 772 462" },
  { id: 3, title: "3 · Composer", tabLabel: "Composer", viewBox: "24 462 772 542" },
  { id: 4, title: "4 · Plugin-owned layouts", tabLabel: "Plugin-owned layouts", viewBox: "804 462 772 542" },
] as const;

export function frameSurfaceMap(svg: string, viewBox: string): string {
  return svg.replace(
    /<svg\b[^>]*>/u,
    (root) => root
      .replace(/\swidth="[^"]*"/u, "")
      .replace(/\sheight="[^"]*"/u, "")
      .replace(/\sviewBox="[^"]*"/u, "")
      .replace(/>$/u, ` viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">`),
  );
}
