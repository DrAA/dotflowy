import { describe, expect, test } from "bun:test";

import {
  ENC_PREFIX,
  generateDek,
  isSealed,
  parseMasterKey,
  sealString,
  unsealString,
  wrapDek,
  unwrapDek,
  deriveKek,
} from "./at-rest-crypto";

describe("at-rest-crypto", () => {
  test("parseMasterKey accepts 32-byte base64", () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...raw));
    const parsed = parseMasterKey(b64);
    expect(parsed).not.toBeNull();
    expect(new Uint8Array(parsed!).byteLength).toBe(32);
    expect(parseMasterKey("")).toBeNull();
    expect(parseMasterKey("short")).toBeNull();
  });

  test("seal/unseal round-trips and is idempotent on sealed", async () => {
    const dek = await generateDek();
    const sealed = await sealString("hello bullets", dek);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.startsWith(ENC_PREFIX)).toBe(true);
    expect(await unsealString(sealed, dek)).toBe("hello bullets");
    expect(await sealString(sealed, dek)).toBe(sealed);
    expect(await unsealString("legacy plaintext", dek)).toBe(
      "legacy plaintext",
    );
  });

  test("different DEKs cannot decrypt each other", async () => {
    const a = await generateDek();
    const b = await generateDek();
    const sealed = await sealString("secret", a);
    await expect(unsealString(sealed, b)).rejects.toBeDefined();
  });

  test("per-do KEK wrap isolates users", async () => {
    const master = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const kekA = await deriveKek(master, "user-a");
    const kekB = await deriveKek(master, "user-b");
    const dek = await generateDek();
    const wrapped = await wrapDek(dek, kekA);
    const round = await unwrapDek(wrapped, kekA);
    const pt = await sealString("x", dek);
    expect(await unsealString(pt, round)).toBe("x");
    await expect(unwrapDek(wrapped, kekB)).rejects.toBeDefined();
  });
});
