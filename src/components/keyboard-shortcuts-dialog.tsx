import { useEffect, useRef, useState } from "react";

import {
  displayKeyToken,
  prefersMetaKey,
  SHORTCUT_GROUPS,
} from "../data/keyboard-shortcuts";
import { setKeyboardShortcutsOpener } from "./keyboard-shortcuts-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Kbd, KbdGroup } from "./ui/kbd";

/**
 * Keyboard shortcuts cheat sheet. Mounted once in `__root.tsx`; opened from
 * the More menu, Cmd+K, and Mod+/ (capture-phase, toggles). Spoiler keeps
 * Mod+Shift+S (ADR 0043); Edge steals Ctrl+Shift+S for Save as.
 */
export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    setKeyboardShortcutsOpener(() => setOpen(true));
    return () => setKeyboardShortcutsOpener(null);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Mod+/ — Notion/Slack-shaped help. Bare `/` stays the slash menu.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "/" || e.code === "Slash")
      ) {
        e.preventDefault();
        setOpen(!openRef.current);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const meta = prefersMetaKey();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[min(85vh,40rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press{" "}
            <KbdGroup className="mx-0.5 align-middle">
              <Kbd>{displayKeyToken("Mod", meta)}</Kbd>
              <Kbd>/</Kbd>
            </KbdGroup>{" "}
            anytime to open or close this list.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-6">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.title}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {group.items.map((item) => (
                    <li
                      key={`${group.title}:${item.keys.join("+")}:${item.action}`}
                      className="flex items-start justify-between gap-4 text-sm"
                    >
                      <span className="min-w-0 flex-1 text-foreground">
                        {item.action}
                      </span>
                      <KbdGroup className="mt-0.5 shrink-0">
                        {item.keys.map((k) => (
                          <Kbd key={k}>{displayKeyToken(k, meta)}</Kbd>
                        ))}
                      </KbdGroup>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Type <Kbd className="mx-0.5">/</Kbd> on a bullet for more commands
            (to-do, paragraph, move, mirror, …).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
