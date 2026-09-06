import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import {
  backupImageCountForNodes,
  backupSubtreeIds,
  gunzipJson,
  parseContentBackup,
  restoreContentBackup,
  restoreContentBackupSubtree,
  searchBackupNodes,
  type ContentBackup,
} from "../data/content-backup";
import { flattenInline } from "../data/inline-text";
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
import { Input } from "./ui/input";

type Stage =
  | { kind: "closed" }
  | { kind: "choose"; backup: ContentBackup; fileName: string }
  | {
      kind: "pick-node";
      backup: ContentBackup;
      fileName: string;
      query: string;
    }
  | {
      kind: "confirm-node";
      backup: ContentBackup;
      fileName: string;
      rootId: string;
    }
  | { kind: "confirm-whole"; backup: ContentBackup; fileName: string }
  | { kind: "restoring" }
  | {
      kind: "success";
      nodeCount: number;
      imageCount: number;
      scope: "whole" | "node";
    }
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
      setStage({ kind: "choose", backup: parsed, fileName: file.name });
    } catch {
      setStage({
        kind: "error",
        title: "Couldn't read that backup",
        detail: "Choose a .aaflowy-backup.json.gz file from this app.",
      });
    }
  };

  const onConfirmWhole = async (backup: ContentBackup) => {
    setStage({ kind: "restoring" });
    await new Promise((r) => setTimeout(r, 0));
    try {
      await restoreContentBackup(backup);
      setStage({
        kind: "success",
        nodeCount: backup.nodes.length,
        imageCount: imageCount(backup),
        scope: "whole",
      });
    } catch {
      setStage({
        kind: "error",
        title: "Restore failed",
        detail: "Nothing was changed. Try again when sync is ready.",
      });
    }
  };

  const onConfirmNode = async (backup: ContentBackup, rootId: string) => {
    setStage({ kind: "restoring" });
    await new Promise((r) => setTimeout(r, 0));
    try {
      const result = await restoreContentBackupSubtree(backup, rootId);
      setStage({
        kind: "success",
        nodeCount: result.nodeCount,
        imageCount: result.imageCount,
        scope: "node",
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
  const pickHits =
    stage.kind === "pick-node"
      ? searchBackupNodes(stage.backup, stage.query)
      : [];

  const confirmNodeMeta = useMemo(() => {
    if (stage.kind !== "confirm-node") return null;
    const ids = backupSubtreeIds(stage.backup.nodes, stage.rootId);
    const root = stage.backup.nodes.find((n) => n.id === stage.rootId);
    return {
      label: root ? flattenInline(root.text) || "(blank)" : stage.rootId,
      nodeCount: ids.size,
      imageCount: backupImageCountForNodes(stage.backup, ids),
    };
  }, [stage]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".aaflowy-backup.json.gz,application/gzip"
        className="hidden"
        data-testid="content-backup-file"
        onChange={(e) => void onFile(e)}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setStage({ kind: "closed" });
        }}
      >
        <DialogContent data-testid="content-backup-dialog">
          {stage.kind === "choose" && (
            <>
              <DialogHeader>
                <DialogTitle>Restore from backup</DialogTitle>
                <DialogDescription>
                  File{" "}
                  <span className="font-medium text-foreground">
                    {stage.fileName}
                  </span>
                  : {stage.backup.nodes.length.toLocaleString()} bullets,{" "}
                  {imageCount(stage.backup).toLocaleString()} images. Choose how
                  much to bring back.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="h-auto justify-start px-3 py-3 text-left"
                  data-testid="content-backup-restore-node"
                  onClick={() =>
                    setStage({
                      kind: "pick-node",
                      backup: stage.backup,
                      fileName: stage.fileName,
                      query: "",
                    })
                  }
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">One bullet…</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Restore a single bullet and its children. Everything else
                      stays as it is.
                    </span>
                  </span>
                </Button>
                <Button
                  variant="outline"
                  className="h-auto justify-start px-3 py-3 text-left"
                  data-testid="content-backup-restore-whole"
                  onClick={() =>
                    setStage({
                      kind: "confirm-whole",
                      backup: stage.backup,
                      fileName: stage.fileName,
                    })
                  }
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">Whole outline</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Replace your outline and side settings with this backup.
                    </span>
                  </span>
                </Button>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setStage({ kind: "closed" })}
                >
                  Cancel
                </Button>
              </DialogFooter>
            </>
          )}

          {stage.kind === "pick-node" && (
            <>
              <DialogHeader>
                <DialogTitle>Pick a bullet to restore</DialogTitle>
                <DialogDescription>
                  Search the backup, then restore that bullet and its children
                  into your current outline.
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                placeholder="Search backup…"
                value={stage.query}
                data-testid="content-backup-node-search"
                onChange={(e) => setStage({ ...stage, query: e.target.value })}
              />
              <ul
                className="max-h-64 overflow-y-auto rounded-md border border-border"
                data-testid="content-backup-node-list"
              >
                {pickHits.length === 0 ? (
                  <li className="px-3 py-4 text-sm text-muted-foreground">
                    No matching bullets.
                  </li>
                ) : (
                  pickHits.map((node) => (
                    <li key={node.id}>
                      <button
                        type="button"
                        className="flex w-full px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() =>
                          setStage({
                            kind: "confirm-node",
                            backup: stage.backup,
                            fileName: stage.fileName,
                            rootId: node.id,
                          })
                        }
                      >
                        <span className="truncate">
                          {flattenInline(node.text) || "(blank)"}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() =>
                    setStage({
                      kind: "choose",
                      backup: stage.backup,
                      fileName: stage.fileName,
                    })
                  }
                >
                  Back
                </Button>
              </DialogFooter>
            </>
          )}

          {stage.kind === "confirm-node" && confirmNodeMeta && (
            <>
              <DialogHeader>
                <DialogTitle>Restore this bullet?</DialogTitle>
                <DialogDescription>
                  Brings back{" "}
                  <span className="font-medium text-foreground">
                    {confirmNodeMeta.label}
                  </span>{" "}
                  and its children from the backup. Other bullets stay. One
                  Cmd+Z can undo.
                </DialogDescription>
              </DialogHeader>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                  {confirmNodeMeta.nodeCount.toLocaleString()} bullet
                  {confirmNodeMeta.nodeCount === 1 ? "" : "s"}
                </li>
                <li>
                  {confirmNodeMeta.imageCount.toLocaleString()} attached image
                  {confirmNodeMeta.imageCount === 1 ? "" : "s"}
                </li>
              </ul>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() =>
                    setStage({
                      kind: "pick-node",
                      backup: stage.backup,
                      fileName: stage.fileName,
                      query: "",
                    })
                  }
                >
                  Back
                </Button>
                <Button
                  onClick={() => void onConfirmNode(stage.backup, stage.rootId)}
                >
                  Restore bullet
                </Button>
              </DialogFooter>
            </>
          )}

          {stage.kind === "confirm-whole" && (
            <>
              <DialogHeader>
                <DialogTitle>Replace whole outline?</DialogTitle>
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
                  onClick={() =>
                    setStage({
                      kind: "choose",
                      backup: stage.backup,
                      fileName: stage.fileName,
                    })
                  }
                >
                  Back
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void onConfirmWhole(stage.backup)}
                >
                  Replace outline
                </Button>
              </DialogFooter>
            </>
          )}

          {stage.kind === "restoring" && (
            <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
              <Loader2Icon className="size-5 animate-spin" />
              Restoring…
            </div>
          )}

          {stage.kind === "success" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {stage.scope === "whole"
                    ? "Backup restored"
                    : "Bullet restored"}
                </DialogTitle>
                <DialogDescription>
                  {stage.nodeCount.toLocaleString()} bullets and{" "}
                  {stage.imageCount.toLocaleString()} images are back
                  {stage.scope === "node" ? " in that branch" : ""}.
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
