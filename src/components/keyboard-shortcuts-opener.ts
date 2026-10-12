let opener: (() => void) | null = null;

export function setKeyboardShortcutsOpener(fn: typeof opener) {
  opener = fn;
}

/**
 * Open the Keyboard shortcuts dialog from anywhere — the More menu, Cmd+K,
 * and Mod+Shift+S all call this. The dialog is mounted once in `__root.tsx`.
 */
export function openKeyboardShortcuts() {
  opener?.();
}
