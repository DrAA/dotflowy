import { describe, expect, test } from "bun:test";

import { sniffImage } from "./media";

function pad(bytes: number[], min = 12): Uint8Array {
  const out = new Uint8Array(Math.max(bytes.length, min));
  out.set(bytes);
  return out;
}

describe("sniffImage", () => {
  test("accepts jpeg, png, gif, webp, and avif magic bytes", () => {
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 12)),
    ).toBe("image/png");
    expect(sniffImage(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(
      "image/gif",
    );
    expect(sniffImage(pad([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe(
      "image/gif",
    );
    const webp = pad([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniffImage(webp)).toBe("image/webp");
    const avif = new Uint8Array(16);
    avif.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(sniffImage(avif)).toBe("image/avif");
  });

  test("rejects SVG, HTML, and buffers shorter than 12 bytes", () => {
    const svg = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'>",
    );
    expect(sniffImage(svg)).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<!DOCTYPE html>"))).toBeNull();
    expect(sniffImage(pad([0xff, 0xd8, 0xff], 11))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});
