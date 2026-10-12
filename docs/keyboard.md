# Keyboard shortcuts

In-app: **⋯ → Keyboard shortcuts**, or `Cmd/Ctrl+/`. The live list lives in
`src/data/keyboard-shortcuts.ts` (keep this table in sync when adding a chord).

| Key                               | Action                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Enter`                           | Split at the caret (or add a child at the top of an expanded bullet); while nodes are selected, open the actions menu         |
| `Tab` / `Shift+Tab`               | Indent / outdent                                                                                                              |
| `Shift+Alt/Option+↑` / `↓`        | Move the bullet among siblings; at the edge reparent into the parent's adjacent sibling                                       |
| `Cmd/Ctrl+↑` / `↓`                | Collapse / expand                                                                                                             |
| `Cmd/Ctrl+Enter` or `Cmd/Ctrl+D`  | Toggle complete                                                                                                               |
| `Alt/Option+↓` / `Alt/Option+↑`   | Zoom in / out (current bullet becomes the root; out goes to the parent)                                                       |
| `Backspace` on an empty bullet    | Delete it and focus the previous one                                                                                          |
| `Arrow ↑` / `↓` at line edges     | Move between bullets (preserves the caret column)                                                                             |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo                                                                                                                   |
| `Shift+↑` / `↓`                   | Select whole nodes (then `Tab` indents the run, `Backspace` deletes it, `Enter` opens actions, …)                             |
| `Cmd/Ctrl+B` / `I` / `U`          | Bold / italic / underline                                                                                                     |
| `Cmd/Ctrl+Shift+X` / `H` / `S`    | Strikethrough / highlight / spoiler                                                                                           |
| `Cmd/Ctrl+K`                      | Link selected text (opens the create-link popover)                                                                            |
| `Cmd/Ctrl+Shift+K`                | Open the command center                                                                                                       |
| `Cmd/Ctrl+/`                      | Keyboard shortcuts dialog                                                                                                     |
| `Cmd/Ctrl+F`                      | Filter the current view (`?q=` — tags, operators, free text)                                                                  |
| `Escape`                          | Toggle search: open the filter from a bullet when idle; when open, clear `?q=` and collapse (overlays/menus own Escape first) |
| `q`                               | Quick-add capture (files to Today without leaving where you are)                                                              |

The `/` menu on any bullet lists every command (to-do, paragraph, move,
mirror, formatting, …), and `Cmd/Ctrl+Shift+K` runs node + global actions from
anywhere.
