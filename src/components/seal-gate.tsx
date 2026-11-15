/**
 * Seal passphrase setup / unlock (ADR 0063). Shown when the sealed-outline
 * dogfood flag is on and the DEK is not in memory. Passphrase never leaves
 * the client.
 */

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import { hydrateSealedMediaUrls } from "../data/media";
import {
  createSeal,
  fetchSealState,
  forgetSealOnDevice,
  isSealUnlocked,
  putSealKeybag,
  rememberSealOnDevice,
  setSealDek,
  subscribeSealSession,
  tryUnlockFromDevice,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type SealKeybag,
} from "../data/seal";
import { useSession } from "../lib/auth-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Mode = "loading" | "setup" | "unlock" | "recovery" | "show-recovery";

export function SealGate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const unlocked = useSyncExternalStore(
    subscribeSealSession,
    isSealUnlocked,
    () => false,
  );
  const [mode, setMode] = useState<Mode>("loading");
  const [keybag, setKeybag] = useState<SealKeybag | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [recoveryShown, setRecoveryShown] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (unlocked || !userId) return;
    let cancelled = false;
    void (async () => {
      try {
        if (await tryUnlockFromDevice(userId)) return;
        const state = await fetchSealState();
        if (cancelled) return;
        if (state.keybag) {
          setKeybag(state.keybag as SealKeybag);
          setMode("unlock");
        } else {
          setMode("setup");
        }
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "Couldn't load seal state.",
        );
        setMode("setup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unlocked, userId]);

  if (unlocked && mode !== "show-recovery") {
    return <>{children}</>;
  }

  const afterUnlock = async () => {
    if (!userId) return;
    if (remember) {
      try {
        await rememberSealOnDevice(userId);
      } catch {
        // Non-fatal — unlock still succeeded.
      }
    } else {
      forgetSealOnDevice(userId);
    }
    hydrateSealedMediaUrls();
  };

  const onSetup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (passphrase !== confirm) {
      setError("Passphrases do not match.");
      return;
    }
    setBusy(true);
    try {
      const created = await createSeal(passphrase);
      await putSealKeybag(created.keybag);
      setSealDek(created.dek);
      await afterUnlock();
      setRecoveryShown(created.recoveryKey);
      setMode("show-recovery");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Couldn't create seal.",
      );
    } finally {
      setBusy(false);
    }
  };

  const onUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!keybag) return;
    setError(null);
    setBusy(true);
    try {
      setSealDek(await unlockWithPassphrase(keybag, passphrase));
      await afterUnlock();
    } catch {
      setError("Wrong passphrase.");
    } finally {
      setBusy(false);
    }
  };

  const onRecovery = async (e: FormEvent) => {
    e.preventDefault();
    if (!keybag) return;
    setError(null);
    setBusy(true);
    try {
      setSealDek(await unlockWithRecoveryKey(keybag, recoveryInput.trim()));
      await afterUnlock();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Recovery key did not work.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (mode === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading seal…
      </div>
    );
  }

  const rememberToggle = (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input
        type="checkbox"
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
      />
      Remember this device
    </label>
  );

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="w-full max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          {mode === "setup" || mode === "show-recovery"
            ? "Seal your outline"
            : "Unlock your outline"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {mode === "setup"
            ? "Choose a seal passphrase. It is not your login password and never leaves this device."
            : mode === "show-recovery"
              ? "Save this recovery key somewhere safe. You will not see it again."
              : "Enter your seal passphrase to decrypt your outline."}
        </p>
      </div>

      {mode === "show-recovery" && recoveryShown ? (
        <div className="w-full max-w-sm space-y-4">
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs break-all whitespace-pre-wrap">
            {recoveryShown}
          </pre>
          <Button
            className="w-full"
            onClick={() => {
              setRecoveryShown(null);
              setMode("unlock");
            }}
          >
            I saved it — continue
          </Button>
        </div>
      ) : null}

      {mode === "setup" ? (
        <form
          className="flex w-full max-w-sm flex-col gap-3"
          onSubmit={onSetup}
        >
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Seal passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
            minLength={8}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm passphrase"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
          />
          {rememberToggle}
          <Button type="submit" disabled={busy}>
            Create seal
          </Button>
        </form>
      ) : null}

      {mode === "unlock" ? (
        <form
          className="flex w-full max-w-sm flex-col gap-3"
          onSubmit={onUnlock}
        >
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Seal passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
          {rememberToggle}
          <Button type="submit" disabled={busy}>
            Unlock
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMode("recovery");
              setError(null);
            }}
          >
            Use recovery key
          </Button>
        </form>
      ) : null}

      {mode === "recovery" ? (
        <form
          className="flex w-full max-w-sm flex-col gap-3"
          onSubmit={onRecovery}
        >
          <Input
            type="text"
            autoComplete="off"
            placeholder="Recovery key"
            value={recoveryInput}
            onChange={(e) => setRecoveryInput(e.target.value)}
            required
          />
          {rememberToggle}
          <Button type="submit" disabled={busy}>
            Unlock with recovery key
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMode("unlock");
              setError(null);
            }}
          >
            Back
          </Button>
        </form>
      ) : null}

      {error ? (
        <p
          className="max-w-sm text-center text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
