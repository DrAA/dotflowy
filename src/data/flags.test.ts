import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isLocalDataEnabled,
  isLunoraSyncEnabled,
  isMirrorsEnabled,
  LOCAL_DATA_FLAG_KEY,
  LUNORA_SYNC_FLAG_KEY,
} from "./flags";

// bun test has no DOM — stub the surfaces flags.ts reads (see realtime.test.ts).
const store = new Map<string, string>();
const location = { href: "http://localhost/", search: "" };

beforeEach(() => {
  store.clear();
  location.href = "http://localhost/";
  location.search = "";
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    location,
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("isLocalDataEnabled", () => {
  test("defaults OFF (backend on this machine)", () => {
    expect(isLocalDataEnabled()).toBe(false);
  });

  test("localStorage off disables", () => {
    store.set(LOCAL_DATA_FLAG_KEY, "off");
    expect(isLocalDataEnabled()).toBe(false);
  });

  test("localStorage on enables", () => {
    store.set(LOCAL_DATA_FLAG_KEY, "on");
    expect(isLocalDataEnabled()).toBe(true);
  });

  test("URL ?local-data=on wins over default", () => {
    location.search = "?local-data=on";
    expect(isLocalDataEnabled()).toBe(true);
  });

  test("URL ?local-data=off wins over localStorage on", () => {
    store.set(LOCAL_DATA_FLAG_KEY, "on");
    location.search = "?local-data=off";
    expect(isLocalDataEnabled()).toBe(false);
  });
});

describe("isLunoraSyncEnabled", () => {
  beforeEach(() => {
    // Browser-only mode forces Lunora off; keep these tests on backend path.
    store.set(LOCAL_DATA_FLAG_KEY, "off");
  });

  test("defaults OFF", () => {
    expect(isLunoraSyncEnabled()).toBe(false);
  });

  test("localStorage on enables", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "on");
    expect(isLunoraSyncEnabled()).toBe(true);
  });

  test("localStorage off disables", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "off");
    expect(isLunoraSyncEnabled()).toBe(false);
  });

  test("URL ?lunora-sync=on wins over localStorage off", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "off");
    location.search = "?lunora-sync=on";
    expect(isLunoraSyncEnabled()).toBe(true);
  });

  test("URL ?lunora-sync=off wins over localStorage on", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "on");
    location.search = "?lunora-sync=off";
    expect(isLunoraSyncEnabled()).toBe(false);
  });

  test("stays off while local-data is on", () => {
    store.set(LOCAL_DATA_FLAG_KEY, "on");
    store.set(LUNORA_SYNC_FLAG_KEY, "on");
    expect(isLunoraSyncEnabled()).toBe(false);
  });
});

describe("isMirrorsEnabled (smoke)", () => {
  test("still defaults ON", () => {
    expect(isMirrorsEnabled()).toBe(true);
  });
});
