import { describe, expect, test } from "bun:test";

import { sealJson, unsealJson } from "./envelope";
import {
  createSeal,
  rewrapPassphrase,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from "./keybag";
import { sealMediaFile, unsealMediaBytes } from "./media";
import { clearSealSession, setSealDek } from "./session";

describe("sealed outline crypto", () => {
  test("passphrase unlock round-trips a snapshot", async () => {
    const { keybag, dek, recoveryKey } = await createSeal(
      "correct horse battery",
    );
    expect(recoveryKey.startsWith("dfseal1_")).toBe(true);

    const envelope = await sealJson(dek, "snapshot", 1, {
      nodes: [{ id: "a", text: "hello" }],
    });
    const unlocked = await unlockWithPassphrase(
      keybag,
      "correct horse battery",
    );
    const data = await unsealJson<{ nodes: { id: string; text: string }[] }>(
      unlocked,
      envelope,
    );
    expect(data.nodes[0]?.text).toBe("hello");
  });

  test("wrong passphrase fails", async () => {
    const { keybag } = await createSeal("correct horse battery");
    await expect(
      unlockWithPassphrase(keybag, "wrong passphrase!!"),
    ).rejects.toBeDefined();
  });

  test("recovery key unlock + rewrap passphrase", async () => {
    const { keybag, recoveryKey } = await createSeal("old passphrase here");
    const dek = await unlockWithRecoveryKey(keybag, recoveryKey);
    const nextBag = await rewrapPassphrase(keybag, dek, "new passphrase here");
    const again = await unlockWithPassphrase(nextBag, "new passphrase here");
    const envelope = await sealJson(again, "revision", 2, { ok: true });
    const out = await unsealJson<{ ok: boolean }>(again, envelope);
    expect(out.ok).toBe(true);
  });

  test("sealed media bytes round-trip", async () => {
    const { dek } = await createSeal("media seal passphrase!");
    setSealDek(dek);
    try {
      const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
      const file = new File([plain], "t.jpg", { type: "image/jpeg" });
      const packed = await sealMediaFile(file);
      expect(packed.byteLength).toBeGreaterThan(plain.byteLength);
      const out = await unsealMediaBytes(packed);
      expect([...out]).toEqual([...plain]);
    } finally {
      clearSealSession();
    }
  });
});
