export const AGENTATION_THEME_STORAGE_KEY = "feedback-toolbar-theme";

export type AgentationTheme = "dark" | "light";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function oppositeTheme(bbIsDark: boolean): AgentationTheme {
  return bbIsDark ? "light" : "dark";
}

/**
 * Seed Agentation's initial theme without taking ownership of later choices.
 *
 * Agentation persists its own toggle to this key. Once a value exists, it is a
 * user preference and bb theme changes must not replace it.
 */
export function seedAgentationThemeDefault(
  storage: ThemeStorage,
  bbIsDark: boolean,
): AgentationTheme | null {
  try {
    if (storage.getItem(AGENTATION_THEME_STORAGE_KEY) !== null) return null;

    const theme = oppositeTheme(bbIsDark);
    storage.setItem(AGENTATION_THEME_STORAGE_KEY, theme);
    return theme;
  } catch {
    // Agentation can still mount with its built-in default when storage is
    // unavailable or full.
    return null;
  }
}
