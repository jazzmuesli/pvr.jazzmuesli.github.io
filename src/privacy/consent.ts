// Consent management and usage statistics.
//
// Legal background (EU/DE): loading the VeritaMetrics tracker reads and writes
// information on the visitor's terminal equipment (sessionStorage/localStorage)
// and transmits it to a third party. Under §25(1) TDDDG in conjunction with
// Art. 6(1)(a) GDPR this needs prior, granular, documented consent. Nothing may
// be loaded before consent, and a refusal must be as easy as an acceptance.
//
// Two further design rules follow from data minimisation (Art. 5(1)(c) GDPR):
//   1. We load the official tracker.js only — no third-party script hosting.
//   2. We keep the scenario out of the query string (see src/ui/url.ts), because
//      tracker.js transmits `location.pathname + location.search`. The shareable
//      state therefore lives in the URL fragment, which is never transmitted.
//      Verified against tracker.js 2.1.0: the fragment is not part of the payload.

import { t } from "../i18n";

export const CONSENT_KEY = "pv-calc-consent";

export type CategoryId = "necessary" | "statistics";

export interface ConsentDecision {
  /** `null` = no decision recorded yet, so the banner must be shown. */
  statistics: boolean | null;
  /** ISO timestamp of the decision, evidence of consent (Art. 7(1) GDPR). */
  decidedAt: string;
  /** Version of the notice the user agreed to. */
  noticeVersion: number;
}

/** Bump when the banner text or the notice changes in a way that requires a fresh decision. */
export const NOTICE_VERSION = 1;

export const TRACKER_SITE_ID = "fe74050b-7640-43e5-93da-5346b819378b";
export const TRACKER_ORIGIN = "https://www.veritametrics.com";

/** Read the stored decision, or `null` when absent, unreadable or outdated. */
export function readConsent(store: Storage | undefined = storage()): ConsentDecision | null {
  if (!store) return null;
  try {
    const raw = store.getItem(CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConsentDecision>;
    if (typeof parsed.statistics !== "boolean" || typeof parsed.noticeVersion !== "number") return null;
    if (parsed.noticeVersion !== NOTICE_VERSION) return null;
    return {
      statistics: parsed.statistics,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : "",
      noticeVersion: parsed.noticeVersion,
    };
  } catch {
    return null;
  }
}

export function writeConsent(
  statistics: boolean,
  store: Storage | undefined = storage(),
  now: Date = new Date(),
): ConsentDecision {
  const decision: ConsentDecision = {
    statistics,
    decidedAt: now.toISOString(),
    noticeVersion: NOTICE_VERSION,
  };
  try {
    store?.setItem(CONSENT_KEY, JSON.stringify(decision));
  } catch { /* private mode / storage disabled */ }
  return decision;
}

export function clearConsent(store: Storage | undefined = storage()): void {
  try {
    store?.removeItem(CONSENT_KEY);
  } catch { /* ignore */ }
}

/** `navigator.globalPrivacyControl` and `doNotTrack` count as an objection, not as consent. */
export function gpcOptOut(nav: Partial<Navigator> = typeof navigator === "undefined" ? {} : navigator): boolean {
  const gpc = (nav as { globalPrivacyControl?: boolean }).globalPrivacyControl;
  if (gpc === true) return true;
  const dnt = nav.doNotTrack;
  return dnt === "1" || dnt === "yes" || dnt === "true";
}

/** Consent to load the tracker, honouring an outstanding decision and privacy signals. */
export function canMeasure(decision: ConsentDecision | null = readConsent()): boolean {
  return decision?.statistics === true && !gpcOptOut();
}

// ---- Usage statistics --------------------------------------------------------

/** Event name the tracker records for a page view. */
export const PAGEVIEW_EVENT = "pageview";

/**
 * The data we are willing to disclose, and what tracker.js 2.1.0 actually sends
 * for a page view: `{ n, u: pathname + search, d: hostname, r: referrer,
 * w: viewport width, pid, sid, eid, p: {}, ts }` plus the server-side IP.
 *
 * Used by the tests as the contract the footer and privacy policy promise.
 */
export interface TrackPayload {
  path: string;
  hostname: string;
  title: string;
  referrer: string;
  viewportWidth: number;
}

/** Assemble that payload. The scenario lives in `location.hash` and is never included. */
export function buildPageview(
  loc: Pick<Location, "pathname" | "hostname" | "search" | "hash"> = location,
  doc: Pick<Document, "title" | "referrer"> = document,
  width: number = typeof window === "undefined" ? 0 : window.innerWidth,
): TrackPayload {
  return {
    path: loc.pathname || "/",
    hostname: loc.hostname,
    title: doc.title,
    referrer: typeof doc.referrer === "string" ? doc.referrer : "",
    viewportWidth: width,
  };
}

interface VeritaApi {
  (command: string, payload?: Record<string, unknown>): void;
  q?: unknown[];
  l?: number;
}

function trackingApi(): VeritaApi | null {
  const w = typeof window === "undefined" ? undefined : (window as unknown as { verita?: VeritaApi });
  return w?.verita ?? null;
}

/**
 * Flag the page as carrying a scenario in the fragment. Not sent anywhere, but it
 * makes the invariant explicit for anyone reading the request in DevTools.
 */
function assertNoScenarioInSearch(loc: Location): void {
  if (loc.search) {
    console.warn("[privacy] Query string present: it would be transmitted by the tracker. Scenario params belong in the fragment.");
  }
}

/** Append tracker.js, which fires its own page view. Runs at most once per page. */
export function enableUsageStats(doc: Document = document, loc: Location = location): void {
  if (!canMeasure()) return;
  assertNoScenarioInSearch(loc);
  if (doc.getElementById("veritametrics-tracker")) return;
  const script = doc.createElement("script");
  script.id = "veritametrics-tracker";
  script.src = `${TRACKER_ORIGIN}/api/tracker.js?siteId=${TRACKER_SITE_ID}`;
  // tracker.js reads its configuration from document.currentScript and bails
  // out with "Missing siteId attribute" when the attributes are missing.
  script.dataset.siteId = TRACKER_SITE_ID;
  script.dataset.trackingDomain = new URL(TRACKER_ORIGIN).hostname;
  script.async = true;
  script.defer = true;
  doc.head.appendChild(script);
}

/** Withdraw consent: forget the decision and drop everything the tracker left behind. */
export function revokeUsageStats(store: Storage | undefined = storage()): void {
  clearConsent(store);
  dropTrackerArtifacts();
  for (const s of Array.from(document.querySelectorAll("script[src*='veritametrics']"))) s.remove();
}

function dropTrackerArtifacts(): void {
  try {
    // Ask the tracker to delete its identifiers, then remove them ourselves.
    trackingApi()?.("deleteUser");
    sessionStorage.removeItem("vm_sid");
    sessionStorage.removeItem("vm_sid_ts");
    sessionStorage.removeItem("vm_pv");
    localStorage.removeItem("vm_opt_out");
    localStorage.removeItem("vm_outbox");
  } catch { /* storage disabled */ }
}

// ---- User interface ----------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = document.createElement(tag);
  Object.assign(node, rest);
  for (const [k, v] of Object.entries(dataset ?? {})) node.dataset[k] = v;
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, variant: string, action: string): HTMLButtonElement {
  const b = el("button", { type: "button", className: `privacy-btn privacy-btn-${variant}`, textContent: label });
  b.dataset.privacyAction = action;
  return b;
}

function link(label: string, action: string): HTMLButtonElement {
  const b = el("button", { type: "button", className: "privacy-link", textContent: label });
  b.dataset.privacyAction = action;
  return b;
}

function mountBanner(host: HTMLElement, decide: (statistics: boolean) => void, showNotice: () => void): void {
  const banner = el("aside", { className: "privacy-banner" }, [
    el("p", { className: "privacy-banner-title", textContent: t("privacy.banner.title") }),
    el("p", { className: "privacy-banner-text", textContent: t("privacy.banner.text") }),
    el("div", { className: "privacy-banner-actions" }, [
      button(t("privacy.accept_all"), "primary", "accept"),
      button(t("privacy.accept_necessary"), "secondary", "necessary"),
      link(t("privacy.more"), "notice"),
    ]),
    el("p", { className: "privacy-banner-text", textContent: t("privacy.banner.legal") }),
  ]);
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-modal", "false");
  banner.setAttribute("aria-label", t("privacy.banner.title"));
  host.append(banner);
  banner.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement | null)?.dataset?.privacyAction;
    if (action === "accept") decide(true);
    else if (action === "necessary") decide(false);
    else if (action === "notice") showNotice();
  });
  banner.querySelector<HTMLButtonElement>(".privacy-btn-primary")?.focus();
}

/** Short, honest summary shown in the footer. Replaces "no cookies, no tracking". */
export function buildFooterNotice(): HTMLElement {
  const container = el("div", { className: "footer-privacy" });
  container.dataset.privacyFooter = "";
  const p1 = el("p");
  p1.append(el("strong", { textContent: t("privacy.footer.strong") }), document.createTextNode(" " + t("privacy.footer.local")));
  const p2 = el("p");
  p2.append(el("strong", { textContent: t("privacy.footer.stats_strong") }), document.createTextNode(" " + t("privacy.footer.stats")));
  const p3 = el("p");
  p3.append(
    document.createTextNode(t("privacy.footer.withdraw")),
    link(t("privacy.footer.settings"), "settings"),
    document.createTextNode(" " + t("privacy.footer.and")),
    link(t("privacy.footer.notice_link"), "notice"),
    document.createTextNode("."),
  );
  container.append(p1, p2, p3);
  return container;
}

interface NoticeSection {
  heading: string;
  body: string[];
}

function noticeSections(): NoticeSection[] {
  return [
    { heading: t("privacy.notice.controller"), body: [t("privacy.notice.controller_body")] },
    { heading: t("privacy.notice.local"), body: [t("privacy.notice.local_body")] },
    { heading: t("privacy.notice.stats"), body: [t("privacy.notice.stats_body"), t("privacy.notice.stats_data")] },
    { heading: t("privacy.notice.chat"), body: [t("privacy.notice.chat_body")] },
    { heading: t("privacy.notice.retention"), body: [t("privacy.notice.retention_body")] },
    { heading: t("privacy.notice.rights"), body: [t("privacy.notice.rights_body")] },
  ];
}

function buildNotice(): HTMLElement {
  const dialog = el("aside", { className: "privacy-notice" });
  const close = button(t("privacy.close"), "secondary", "close");
  close.classList.add("privacy-notice-close");
  dialog.append(
    el("h2", { className: "privacy-notice-title", textContent: t("privacy.notice.title") }),
    el("p", { className: "privacy-notice-intro", textContent: t("privacy.notice.intro") }),
  );
  for (const section of noticeSections()) {
    dialog.append(el("h3", { className: "privacy-notice-heading", textContent: section.heading }));
    for (const para of section.body) dialog.append(el("p", { className: "privacy-notice-text", textContent: para }));
  }
  dialog.append(
    el("div", { className: "privacy-notice-actions" }, [
      button(t("privacy.accept_necessary"), "secondary", "necessary"),
      button(t("privacy.accept_all"), "primary", "accept"),
    ]),
    close,
  );
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", t("privacy.notice.title"));
  return dialog;
}

interface Mounted {
  /** Rebuild banner, footer block and dialog in the current language. */
  render(): void;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Wire up the consent UI: banner on first visit, footer notice with a re-open
 * link (Art. 7(3) GDPR — withdrawing must be as easy as granting), and the full
 * privacy notice. Call once at start-up, and again after a language switch.
 */
export function initPrivacy(): Mounted {
  const host = document.body;
  let banner: HTMLElement | null = null;
  let footerHost: HTMLElement | null = document.querySelector("[data-privacy-footer]");
  let notice: HTMLElement | null = null;
  let backdrop: HTMLElement | null = null;

  function decide(statistics: boolean): void {
    writeConsent(statistics);
    if (!statistics) revokeUsageStats();
    render();
    if (statistics) enableUsageStats();
  }

  function showNotice(): void {
    if (!notice) {
      backdrop = el("div", { className: "privacy-backdrop" });
      backdrop.addEventListener("click", closeNotice);
      notice = buildNotice();
      notice.addEventListener("click", onNoticeClick);
      host.append(backdrop, notice);
      host.classList.add("privacy-notice-open");
      document.addEventListener("keydown", onKeydown);
      notice.querySelector<HTMLElement>(".privacy-notice-close")?.focus();
    }
  }

  function closeNotice(): void {
    notice?.remove();
    backdrop?.remove();
    host.classList.remove("privacy-notice-open");
    notice = null;
    backdrop = null;
    document.removeEventListener("keydown", onKeydown);
  }

  function onNoticeClick(e: Event): void {
    const action = (e.target as HTMLElement | null)?.dataset?.privacyAction;
    if (action === "accept" || action === "necessary") {
      const granted = action === "accept";
      closeNotice();
      decide(granted);
    } else if (action === "close") {
      closeNotice();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") closeNotice();
  }

  function render(): void {
    banner?.remove();
    banner = null;
    footerHost?.replaceWith(buildFooterNotice());
    footerHost = document.querySelector("[data-privacy-footer]");
    footerHost?.addEventListener("click", onFooterClick);

    if (!readConsent() && !gpcOptOut()) {
      mountBanner(host, decide, showNotice);
      banner = document.querySelector(".privacy-banner");
    }
  }

  function onFooterClick(e: Event): void {
    const action = (e.target as HTMLElement | null)?.dataset?.privacyAction;
    if (action === "settings") {
      revokeUsageStats();
      render();
      showNotice();
    } else if (action === "notice") {
      showNotice();
    }
  }

  render();
  if (canMeasure()) enableUsageStats();

  return { render };
}
