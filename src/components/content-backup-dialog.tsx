import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import {
  gunzipJson,
  parseContentBackup,
  restoreContentBackup,
  type ContentBackup,
} from "../data/content-backup";
import { setContentBackupRestoreOpener } from "./content-backup-opener";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type Stage =
  | { kind: "closed" }
  | { kind: "summary"; backup: ContentBackup; fileName: string }
  | { kind: "restoring" }
  | { kind: "success"; nodeCount: number; imageCount: number }
  | { kind: "error"; title: string; detail: string | null };

function imageCount(backup: ContentBackup): number {
  return backup.kv.filter((row) => row.collection === "media").length;
}

/** Restore-from-backup dialog (Settings + Cmd+K). Export is a direct download. */
export function ContentBackupDialog() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "closed" });

  useEffect(() => {
    setContentBackupRestoreOpener(() => inputRef.current?.click());
    return () => setContentBackupRestoreOpener(null);
  }, []);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseContentBackup(await gunzipJson(bytes));
      if (parsed.nodes.length === 0) {
        setStage({
          kind: "error",
          title: "Backup is empty",
          detail: "Nothing to restore.",
        });
        return;
      }
      setStage({ kind: "summary", backup: parsed, fileName: file.name });
    } catch {
      setStage({
        kind: "error",
        title: "Couldn't read that backup",
        detail: "Choose a .aaflowy-backup.json.gz file from this app.",
      });
    }
  };

  const onConfirmRestore = async () => {
    if (stage.kind !== "summary") return;
    const { backup } = stage;
    setStage({ kind: "restoring" });
    await new Promise((r) => setTimeout(r, 0));
    try {
      await restoreContentBackup(backup);
      setStage({
        kind: "success",
        nodeCount: backup.nodes.length,
        imageCount: imageCount(backup),
      });
    } catch {
      setStage({
        kind: "error",
        title: "Restore failed",
        detail: "Nothing was changed. Try again when sync is ready.",
      });
    }
  };

  const open = stage.kind !== "closed";

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".aaflowy-backup.json.gz,application/gzip"
        className="hidden"
        onChange={(e) => void onFile(e)}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setStage({ kind: "closed" });
        }}
      >
        <DialogContent data-testid="content-backup-dialog">
          {stage.kind === "summary" && (
            <>
              <DialogHeader>
                <DialogTitle>Restore backup?</DialogTitle>
                <DialogDescription>
                  This replaces your whole outline with the backup from{" "}
                  <span className="font-medium text-foreground">
                    {stage.fileName}
                  </span>
                  . Side settings (tag colors, saved queries, images) are
                  replaced too. One Cmd+Z can undo the outline change.
                </DialogDescription>
              </DialogHeader>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                  {stage.backup.nodes.length.toLocaleString()} bullet
                  {stage.backup.nodes.length === 1 ? "" : "s"}
                </li>
                <li>
                  {imageCount(stage.backup).toLocaleString()} attached image
                  {imageCount(stage.backup) === 1 ? "" : "s"}
                </li>
              </ul>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setStage({ kind: "closed" })}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void onConfirmRestore()}
                >
                  Restore
                </Button>
              </DialogFooter>
            </>
          )}
          {stage.kind === "restoring" && (
            <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" />
              Restoring your outline…
            </div>
          )}
          {stage.kind === "success" && (
            <>
              <DialogHeader>
                <DialogTitle>Backup restored</DialogTitle>
                <DialogDescription>
                  {stage.nodeCount.toLocaleString()} bullets and{" "}
                  {stage.imageCount.toLocaleString()} images are back.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={() => setStage({ kind: "closed" })}>
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
          {stage.kind === "error" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <TriangleAlertIcon className="size-5 text-destructive" />
                  {stage.title}
                </DialogTitle>
                {stage.detail && (
                  <DialogDescription>{stage.detail}</DialogDescription>
                )}
              </DialogHeader>
              <DialogFooter>
                <Button onClick={() => setStage({ kind: "closed" })}>
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
