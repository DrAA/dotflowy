import { describe, expect, it } from "bun:test";

import {
  extractReplyText,
  mockCopilotReply,
  signOAuthState,
  verifyOAuthState,
} from "./copilot";

describe("extractReplyText", () => {
  it("returns the last message that differs from the prompt", () => {
    expect(
      extractReplyText(
        [{ text: "What is on my calendar?" }, { text: "You have 1 meeting." }],
        "What is on my calendar?",
      ),
    ).toBe("You have 1 meeting.");
  });

  it("falls back to the last non-empty text", () => {
    expect(extractReplyText([{ text: "same" }, { text: "same" }], "same")).toBe(
      "same",
    );
  });

  it("returns null for empty messages", () => {
    expect(extractReplyText([], "hi")).toBeNull();
    expect(extractReplyText(undefined, "hi")).toBeNull();
  });
});

describe("mockCopilotReply", () => {
  it("prefixes the trimmed prompt", () => {
    expect(mockCopilotReply("  hello  ")).toBe("Copilot (mock): hello");
  });
});

describe("OAuth state", () => {
  it("round-trips a user id", async () => {
    const state = await signOAuthState("user-1", "secret", 1_000_000);
    expect(await verifyOAuthState(state, "secret", 1_000_000)).toBe("user-1");
  });

  it("rejects a wrong secret", async () => {
    const state = await signOAuthState("user-1", "secret", 1_000_000);
    expect(await verifyOAuthState(state, "other", 1_000_000)).toBeNull();
  });

  it("rejects an expired state", async () => {
    const state = await signOAuthState("user-1", "secret", 1_000_000);
    expect(
      await verifyOAuthState(state, "secret", 1_000_000 + 11 * 60 * 1000),
    ).toBeNull();
  });
});
