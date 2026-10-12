/**
 * In-app keyboard shortcut catalog (the Keyboard shortcuts dialog +
 * `docs/keyboard.md`). Keep the two in sync when adding a chord.
 *
 * Chords use `"Mod"` for Cmd (macOS) / Ctrl (elsewhere); the dialog maps that
 * at render time.
 */

export type ShortcutItem = {
  /** Chord tokens left-to-right, e.g. `["Mod", "Shift", "K"]`. */
  keys: readonly string[];
  action: string;
};

export type ShortcutGroup = {
  title: string;
  items: readonly ShortcutItem[];
};

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Structure",
    items: [
      {
        keys: ["Enter"],
        action:
          "Split at the caret (or add a child at the top of an expanded bullet)",
      },
      { keys: ["Tab"], action: "Indent" },
      { keys: ["Shift", "Tab"], action: "Outdent" },
      {
        keys: ["Shift", "Alt", "↑"],
        action: "Move up among siblings (edge reparents)",
      },
      {
        keys: ["Shift", "Alt", "↓"],
        action: "Move down among siblings (edge reparents)",
      },
      { keys: ["Mod", "↑"], action: "Collapse" },
      { keys: ["Mod", "↓"], action: "Expand" },
      { keys: ["Alt", "↓"], action: "Zoom in" },
      { keys: ["Alt", "↑"], action: "Zoom out" },
      {
        keys: ["Backspace"],
        action: "Delete empty bullet, or join into the row above at the start",
      },
      {
        keys: ["Mod", "Shift", "Backspace"],
        action: "Delete bullet and its subtree",
      },
    ],
  },
  {
    title: "Selection",
    items: [
      {
        keys: ["Shift", "↑"],
        action: "Select whole nodes (extend with Shift+↑/↓)",
      },
      {
        keys: ["Shift", "↓"],
        action: "Select whole nodes (extend with Shift+↑/↓)",
      },
      {
        keys: ["Enter"],
        action: "Open the selection actions menu (while nodes are selected)",
      },
      {
        keys: ["Mod", "A"],
        action: "Select all text → this node → whole view",
      },
      { keys: ["Mod", "C"], action: "Copy selection as Markdown" },
      { keys: ["Mod", "X"], action: "Cut selection as Markdown" },
    ],
  },
  {
    title: "Formatting",
    items: [
      { keys: ["Mod", "B"], action: "Bold" },
      { keys: ["Mod", "I"], action: "Italic" },
      { keys: ["Mod", "U"], action: "Underline" },
      { keys: ["Mod", "Shift", "X"], action: "Strikethrough" },
      { keys: ["Mod", "Shift", "H"], action: "Highlight" },
      { keys: ["Mod", "Shift", "Y"], action: "Spoiler" },
      { keys: ["Mod", "Enter"], action: "Toggle complete" },
      { keys: ["Mod", "D"], action: "Toggle complete" },
      { keys: ["Mod", "K"], action: "Create / edit link" },
      {
        keys: ["Mod", "Shift", "V"],
        action: "Paste as plain lines (skip markdown import)",
      },
    ],
  },
  {
    title: "Global",
    items: [
      { keys: ["Mod", "Shift", "K"], action: "Open the command center" },
      { keys: ["Mod", "F"], action: "Filter this view" },
      {
        keys: ["Escape"],
        action: "Toggle / dismiss search (overlays own Escape first)",
      },
      {
        keys: ["q"],
        action: "Quick-add capture (when not typing in a field)",
      },
      { keys: ["Mod", "Z"], action: "Undo" },
      { keys: ["Mod", "Shift", "Z"], action: "Redo" },
      {
        keys: ["Mod", "Shift", "S"],
        action: "Keyboard shortcuts (this dialog)",
      },
    ],
  },
];

/** True when the platform prefers the ⌘ glyph over "Ctrl". */
export function prefersMetaKey(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

/** Map a chord token to the glyph/label shown in the dialog. */
export function displayKeyToken(token: string, meta: boolean): string {
  switch (token) {
    case "Mod":
      return meta ? "⌘" : "Ctrl";
    case "Shift":
      return "⇧";
    case "Alt":
      return meta ? "⌥" : "Alt";
    case "ArrowUp":
    case "↑":
      return "↑";
    case "ArrowDown":
    case "↓":
      return "↓";
    case "ArrowLeft":
    case "←":
      return "←";
    case "ArrowRight":
    case "→":
      return "→";
    case "Backspace":
      return "⌫";
    case "Enter":
      return "↵";
    case "Escape":
      return "Esc";
    default:
      return token.length === 1 ? token.toUpperCase() : token;
  }
}
