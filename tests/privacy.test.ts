import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Minimal in-memory Storage double: the consent record must survive a reload,
// so the module is tested against something that behaves like localStorage.
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

// Stub globals: the vitest environment is "node" (see vite.config.ts), so the
// module under test gets explicit window/document/location doubles instead of a DOM.
function stubBrowser(opts: { dnt?: string; gpc?: boolean } = {}): { appended: unknown[] } {
  const appended: unknown[] = [];
  const win: Record<string, unknown> = { innerWidth: 1280 };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", {
    languages: ["de-DE", "de"],
    language: "de-DE",
    doNotTrack: opts.dnt ?? "0",
    globalPrivacyControl: opts.gpc,
  });
  vi.stubGlobal("location", {
    pathname: "/index.html",
    hostname: "example.org",
    search: "",
    hash: "#loc=boizenburg&hk=2400&inv=32000",
  });
  vi.stubGlobal("document", {
    title: "Energiewendeamortisationsrechner",
    referrer: "https://example.org/",
    getElementById: () => null,
    createElement: () => ({ id: "", src: "", async: true, defer: true, dataset: {} as Record<string, string> }),
    head: { appendChild: (node: unknown) => appended.push(node) },
  });
  return { appended };
}

const consent = await import("../src/privacy/consent");
const { DEFAULT_STATE } = await import("../src/ui/state");

describe("consent record", () => {
  it("returns null when nothing has been decided yet", () => {
    expect(consent.readConsent(fakeStorage())).toBeNull();
  });

  it("records acceptance with a timestamp for the Art. 7(1) proof duty", () => {
    const store = fakeStorage();
    const at = new Date("2026-10-04T12:00:00.000Z");
    const written = consent.writeConsent(true, store, at);
    expect(written.statistics).toBe(true);
    expect(written.decidedAt).toBe("2026-10-04T12:00:00.000Z");
    expect(consent.readConsent(store)).toEqual(written);
  });

  it("records a refusal as a decision, so the banner does not reappear", () => {
    const store = fakeStorage();
    consent.writeConsent(false, store);
    expect(consent.readConsent(store)?.statistics).toBe(false);
  });

  it("invalidates the record when the notice version changes", () => {
    const store = fakeStorage();
    store.setItem(
      consent.CONSENT_KEY,
      JSON.stringify({ statistics: true, decidedAt: "2020-01-01T00:00:00.000Z", noticeVersion: consent.NOTICE_VERSION + 1 }),
    );
    expect(consent.readConsent(store)).toBeNull();
  });

  it("ignores corrupted storage content", () => {
    const store = fakeStorage();
    store.setItem(consent.CONSENT_KEY, "{not json");
    expect(consent.readConsent(store)).toBeNull();
    store.setItem(consent.CONSENT_KEY, JSON.stringify({ statistics: "yes" }));
    expect(consent.readConsent(store)).toBeNull();
  });

  it("survives a storage that throws (private mode)", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(consent.readConsent(hostile)).toBeNull();
    expect(() => consent.writeConsent(true, hostile)).not.toThrow();
    expect(() => consent.clearConsent(hostile)).not.toThrow();
  });

  it("removes the record on withdrawal", () => {
    const store = fakeStorage();
    consent.writeConsent(true, store);
    consent.clearConsent(store);
    expect(consent.readConsent(store)).toBeNull();
  });
});

describe("privacy signals", () => {
  it("treats Global Privacy Control as an objection", () => {
    expect(consent.gpcOptOut({ globalPrivacyControl: true } as Partial<Navigator>)).toBe(true);
  });

  it("treats Do Not Track as an objection", () => {
    for (const value of ["1", "yes", "true"]) {
      expect(consent.gpcOptOut({ doNotTrack: value } as Partial<Navigator>)).toBe(true);
    }
  });

  it("does not mistake an unset or '0' signal for consent", () => {
    expect(consent.gpcOptOut({} as Partial<Navigator>)).toBe(false);
    expect(consent.gpcOptOut({ doNotTrack: "0" } as Partial<Navigator>)).toBe(false);
    expect(consent.gpcOptOut({ globalPrivacyControl: false } as Partial<Navigator>)).toBe(false);
  });
});

describe("canMeasure", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", originalNavigator);
  });

  it("requires a recorded acceptance", () => {
    vi.stubGlobal("navigator", { doNotTrack: "0" });
    const store = fakeStorage();
    expect(consent.canMeasure(consent.readConsent(store))).toBe(false);
    consent.writeConsent(false, store);
    expect(consent.canMeasure(consent.readConsent(store))).toBe(false);
  });

  it("allows measurement after acceptance", () => {
    vi.stubGlobal("navigator", { doNotTrack: "0" });
    const store = fakeStorage();
    consent.writeConsent(true, store);
    expect(consent.canMeasure(consent.readConsent(store))).toBe(true);
  });

  it("overrides a stale acceptance when the browser sends GPC", () => {
    vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: true });
    const store = fakeStorage();
    consent.writeConsent(true, store);
    expect(consent.canMeasure(consent.readConsent(store))).toBe(false);
  });
});

describe("analytics payload", () => {
  it("reports only the path, never the scenario", () => {
    const payload = consent.buildPageview(
      {
        pathname: "/index.html",
        hostname: "pvrechner.openfun.org",
        // src/ui/url.ts keeps the scenario in the fragment. tracker.js sends
        // `location.pathname + location.search`, so the query stays empty.
        search: "",
        // src/ui/url.ts: loc=boizenburg, hk=2400, inv=32000 …
        hash: "#loc=boizenburg&hk=2400&inv=32000&kwp=9.8",
      } as Location,
      { title: "Energiewendeamortisationsrechner", referrer: "https://example.org/" } as Document,
      1440,
    );
    const serialised = JSON.stringify(payload);
    expect(payload.path).toBe("/index.html");
    expect(payload.hostname).toBe("pvrechner.openfun.org");
    expect(payload.viewportWidth).toBe(1440);
    expect(payload.title).toBe("Energiewendeamortisationsrechner");
    expect(payload.referrer).toBe("https://example.org/");
    for (const leak of ["loc=", "boizenburg", "hk=", "inv=", "kwp=", "#"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("falls back to '/' for a missing pathname and tolerates a missing referrer", () => {
    const payload = consent.buildPageview(
      { pathname: "", hostname: "", search: "", hash: "" } as Location,
      { title: "t", referrer: undefined } as unknown as Document,
      0,
    );
    expect(payload.path).toBe("/");
    expect(payload.referrer).toBe("");
  });
});

describe("scenario stays out of the query string", () => {
  it("prefers the fragment", async () => {
    const { readStateQuery } = await import("../src/ui/url");
    expect(readStateQuery({ search: "", hash: "#kwp=10&loc=boizenburg" })).toBe("kwp=10&loc=boizenburg");
  });

  it("still reads legacy links that carry the scenario in the query string", async () => {
    const { readStateQuery } = await import("../src/ui/url");
    expect(readStateQuery({ search: "?kwp=10&loc=boizenburg", hash: "" })).toBe("kwp=10&loc=boizenburg");
  });

  it("round-trips a state through the fragment", async () => {
    const { serializeState, deserializeState, readStateQuery } = await import("../src/ui/url");
    const qs = serializeState(DEFAULT_STATE);
    const restored = deserializeState(readStateQuery({ search: "", hash: `#${qs}` }));
    expect(restored.location).toBe(DEFAULT_STATE.location);
    expect(restored.peakKWp).toBe(DEFAULT_STATE.peakKWp);
  });
});

describe("tracker gating", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", originalNavigator);
  });

  it("does not load tracker.js and does not queue a page view without consent", async () => {
    const { appended } = stubBrowser();
    const mod = await import("../src/privacy/consent");
    mod.enableUsageStats(document as unknown as Document);
    expect(appended).toHaveLength(0);
  });

  it("loads tracker.js after consent", async () => {
    const store = fakeStorage();
    // The module reads the real global localStorage by default; stub it instead.
    vi.stubGlobal("localStorage", store);
    const { appended } = stubBrowser();
    const mod = await import("../src/privacy/consent");
    mod.writeConsent(true, store);
    mod.enableUsageStats(document as unknown as Document);

    expect(appended).toHaveLength(1);
    const script = appended[0] as { src: string; id: string; dataset: Record<string, string> };
    expect(script.src).toBe(`${mod.TRACKER_ORIGIN}/api/tracker.js?siteId=${mod.TRACKER_SITE_ID}`);
    expect(script.id).toBe("veritametrics-tracker");
    // tracker.js reads siteId/trackingDomain off document.currentScript and bails out without them.
    expect(script.dataset.siteId).toBe(mod.TRACKER_SITE_ID);
    expect(script.dataset.trackingDomain).toBe("www.veritametrics.com");
  });

  it("does not measure even with consent when the browser objects via DNT", async () => {
    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    const { appended } = stubBrowser({ dnt: "1" });
    const mod = await import("../src/privacy/consent");
    mod.writeConsent(true, store);
    mod.enableUsageStats(document as unknown as Document);
    expect(appended).toHaveLength(0);
  });
});
