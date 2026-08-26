let opener: (() => void) | null = null;

export function setContentBackupRestoreOpener(fn: typeof opener) {
  opener = fn;
}

/** Kick off the backup restore flow (hidden file picker -> confirm dialog). */
export function openContentBackupRestore() {
  opener?.();
}
