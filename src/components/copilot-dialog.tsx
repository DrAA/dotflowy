import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { setCopilotDialogOpener, type CopilotOpenArgs } from "./copilot-opener";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

type Status = {
  configured: boolean;
  connected: boolean;
  mock: boolean;
};

/**
 * `/copilot` prompt dialog. Mounted once in `__root.tsx`. Slash args can't
 * carry a prompt (Seam C closes on whitespace), so the command opens this
 * dialog; on submit the Worker proxies Graph Chat and we replace the bullet
 * text via the opener's `onTextChange` (ADR 0062).
 */
export function CopilotDialog() {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState<CopilotOpenArgs | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setCopilotDialogOpener((next) => {
      setArgs(next);
      setPrompt("");
      setBusy(false);
      setStatus(null);
      setOpen(true);
    });
    return () => setCopilotDialogOpener(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/copilot/status", { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error("status failed");
        return (await res.json()) as Status;
      })
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) {
          setStatus({ configured: false, connected: false, mock: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, status?.connected]);

  async function onSubmit() {
    if (!args || busy) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast.error("Enter a prompt");
      return;
    }
    if (status && !status.configured) {
      toast.error("Microsoft Copilot is not configured on this server");
      return;
    }
    if (status && !status.connected) {
      toast.error("Connect Microsoft in Settings first");
      return;
    }
    setBusy(true);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/copilot/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmed, timeZone }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
      };
      if (res.status === 401 && body.error === "not_connected") {
        toast.error("Connect Microsoft in Settings first");
        setStatus((s) =>
          s
            ? { ...s, connected: false }
            : { configured: true, connected: false, mock: false },
        );
        return;
      }
      if (!res.ok || typeof body.text !== "string") {
        toast.error(body.error || "Copilot request failed");
        return;
      }
      args.onTextChange(args.nodeId, body.text);
      setOpen(false);
      toast.success("Replaced bullet with Copilot reply");
    } catch {
      toast.error("Copilot request failed");
    } finally {
      setBusy(false);
    }
  }

  const needsConnect =
    status !== null && status.configured && !status.connected && !status.mock;
  const unavailable = status !== null && !status.configured;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ask Copilot</DialogTitle>
          <DialogDescription>
            Microsoft 365 Copilot answers using your work data. The reply
            replaces this bullet&apos;s text.
          </DialogDescription>
        </DialogHeader>
        {unavailable ? (
          <p className="text-sm text-muted-foreground">
            Copilot is not configured on this server. An admin must set the
            Microsoft Entra app credentials.
          </p>
        ) : needsConnect ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Connect your Microsoft work account once, then run{" "}
              <span className="font-medium text-foreground">/copilot</span>{" "}
              again.
            </p>
            <Button
              onClick={() => {
                window.location.href = "/api/copilot/connect";
              }}
            >
              Connect Microsoft
            </Button>
          </div>
        ) : (
          <>
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should Copilot look up or summarize?"
              rows={4}
              disabled={busy || status === null}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void onSubmit();
                }
              }}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void onSubmit()}
                disabled={busy || status === null || !prompt.trim()}
              >
                {busy ? "Asking…" : "Ask Copilot"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
