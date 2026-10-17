import { afterEach, describe, expect, test } from "bun:test";

import {
  bindSyncWakeHandlers,
  shouldReconnectAfterHiddenMs,
  STALE_HIDDEN_MS,
} from "./sync-wake";

describe("shouldReconnectAfterHiddenMs", () => {
  test("ignores brief tab switches", () => {
    expect(shouldReconnectAfterHiddenMs(0)).toBe(false);
    expect(shouldReconnectAfterHiddenMs(STALE_HIDDEN_MS - 1)).toBe(false);
  });

  test("reconnects after a long hide (Edge sleep / overnight)", () => {
    expect(shouldReconnectAfterHiddenMs(STALE_HIDDEN_MS)).toBe(true);
    expect(shouldReconnectAfterHiddenMs(STALE_HIDDEN_MS * 120)).toBe(true);
  });
});

describe("bindSyncWakeHandlers", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const realNow = Date.now;

  afterEach(() => {
    Date.now = realNow;
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
    });
  });

  function installFakeDom(
    visibilityState: DocumentVisibilityState = "visible",
  ) {
    const listeners = new Map<string, Set<EventListener>>();
    const target = {
      visibilityState,
      addEventListener(type: string, fn: EventListener) {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        set.add(fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type: string, event: Event = new Event(type)) {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    };
    Object.assign(globalThis, { window: target, document: target });
    return target;
  }

  test("long hide then visible soft-reconnects; brief hide does not", () => {
    let now = 1_000_000;
    Date.now = () => now;
    const dom = installFakeDom("visible");
    let calls = 0;
    const unbind = bindSyncWakeHandlers(() => {
      calls++;
    });

    (dom as { visibilityState: DocumentVisibilityState }).visibilityState =
      "hidden";
    dom.dispatch("visibilitychange");
    now += 1_000;
    (dom as { visibilityState: DocumentVisibilityState }).visibilityState =
      "visible";
    dom.dispatch("visibilitychange");
    expect(calls).toBe(0);

    (dom as { visibilityState: DocumentVisibilityState }).visibilityState =
      "hidden";
    dom.dispatch("visibilitychange");
    now += STALE_HIDDEN_MS;
    (dom as { visibilityState: DocumentVisibilityState }).visibilityState =
      "visible";
    dom.dispatch("visibilitychange");
    expect(calls).toBe(1);

    unbind();
  });

  test("online and resume always soft-reconnect", () => {
    const dom = installFakeDom("visible");
    let calls = 0;
    const unbind = bindSyncWakeHandlers(() => {
      calls++;
    });
    dom.dispatch("online");
    dom.dispatch("resume");
    expect(calls).toBe(2);
    unbind();
  });

  test("pageshow only reconnects when persisted (bfcache)", () => {
    const dom = installFakeDom("visible");
    let calls = 0;
    const unbind = bindSyncWakeHandlers(() => {
      calls++;
    });
    dom.dispatch(
      "pageshow",
      Object.assign(new Event("pageshow"), { persisted: false }),
    );
    expect(calls).toBe(0);
    dom.dispatch(
      "pageshow",
      Object.assign(new Event("pageshow"), { persisted: true }),
    );
    expect(calls).toBe(1);
    unbind();
  });

  test("unbind removes listeners", () => {
    const dom = installFakeDom("visible");
    let calls = 0;
    const unbind = bindSyncWakeHandlers(() => {
      calls++;
    });
    unbind();
    dom.dispatch("online");
    expect(calls).toBe(0);
  });
});
