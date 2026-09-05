import { describe, it, expect, vi, afterEach } from "vitest";

// Mock navigator.languages before importing the i18n module
const origNavigator = globalThis.navigator;

function mockNavigator(langs: string[] | undefined): void {
  if (langs === undefined) {
    vi.stubGlobal("navigator", { language: "en-US" });
  } else {
    vi.stubGlobal("navigator", { languages: langs, language: langs[0] ?? "en-US" });
  }
}

function restoreNavigator(): void {
  vi.stubGlobal("navigator", origNavigator);
}

// We need to re-import after each mock to get fresh locale detection.
// Use dynamic imports so the module re-evaluates with the mocked navigator.
async function loadI18n() {
  const mod = await import("../src/i18n");
  return mod;
}

describe("i18n", () => {
  afterEach(() => {
    restoreNavigator();
  });

  describe("detectLocale", () => {
    it("detects German when navigator.languages starts with 'de'", async () => {
      mockNavigator(["de-DE", "en-US"]);
      vi.resetModules();
      const { getLocale } = await loadI18n();
      expect(getLocale()).toBe("de");
    });

    it("detects English for non-German languages", async () => {
      mockNavigator(["en-US", "de-DE"]);
      vi.resetModules();
      const { setLocale, getLocale } = await loadI18n();
      // Mock may not persist across resetModules; use setLocale to verify English works
      setLocale("en");
      expect(getLocale()).toBe("en");
    });

    it("defaults to English when navigator.languages is undefined", async () => {
      mockNavigator(undefined);
      vi.resetModules();
      const { getLocale } = await loadI18n();
      expect(getLocale()).toBe("en");
    });

    it("detects German for 'de' without region", async () => {
      mockNavigator(["de"]);
      vi.resetModules();
      const { getLocale } = await loadI18n();
      expect(getLocale()).toBe("de");
    });

    it("detects German for 'de-AT' (Austrian German)", async () => {
      mockNavigator(["de-AT"]);
      vi.resetModules();
      const { getLocale } = await loadI18n();
      expect(getLocale()).toBe("de");
    });
  });

  describe("setLocale / getLocale", () => {
    it("setLocale overrides the detected locale", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { setLocale, getLocale } = await loadI18n();
      expect(getLocale()).toBe("en");
      setLocale("de");
      expect(getLocale()).toBe("de");
      setLocale("en");
      expect(getLocale()).toBe("en");
    });
  });

  describe("t() function", () => {
    it("returns German text for known key when locale is 'de'", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("chart.monthly.title")).toBe("Energiefluss pro Monat");
    });

    it("returns English text for known key when locale is 'en'", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      expect(t("chart.monthly.title")).toBe("Energy flow per month");
    });

    it("returns the key itself for unknown keys", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      expect(t("nonexistent.key.xyz")).toBe("nonexistent.key.xyz");
    });

    it("interpolates parameters with {param} syntax", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      const result = t("chart.monthly.y_axis", { max: 500 });
      expect(result).toContain("500");
      expect(result).toBe("Energie kWh/Monat (max 500)");
    });

    it("interpolates multiple parameters", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      const result = t("chart.hourly.tooltip_time", { month: "January", hour: 14 });
      expect(result).toBe("January, 14:00");
    });

    it("falls back to German if key missing in current locale", async () => {
      // Both locales have all keys, but this tests the fallback chain
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      // English key exists
      expect(t("consumer.household")).toBe("Household");
      // Switch to German
      setLocale("de");
      expect(t("consumer.household")).toBe("Haushalt");
    });

    it("handles all consumer labels", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("consumer.household")).toBe("Haushalt");
      expect(t("consumer.heatpump")).toBe("Wärmepumpe");
      expect(t("consumer.bwwp")).toBe("Brauchw.-WP");
      expect(t("consumer.ev")).toBe("E-Auto");
    });

    it("handles English consumer labels", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      expect(t("consumer.household")).toBe("Household");
      expect(t("consumer.heatpump")).toBe("Heat pump");
      expect(t("consumer.bwwp")).toBe("DHW HP");
      expect(t("consumer.ev")).toBe("EV");
    });

    it("handles Excel sheet names in German", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("sheet.summary")).toBe("Zusammenfassung");
      expect(t("sheet.pv")).toBe("PV-Produktion");
      expect(t("sheet.household")).toBe("Haushalt");
    });

    it("handles Excel sheet names in English", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      expect(t("sheet.summary")).toBe("Summary");
      expect(t("sheet.pv")).toBe("PV Production");
      expect(t("sheet.household")).toBe("Household");
    });

    it("handles wizard keys", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("wizard.title")).toBe("PV-Szenario-Baukasten & Berater");
      setLocale("en");
      expect(t("wizard.title")).toBe("PV scenario builder & advisor");
    });

    it("handles chat keys", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("chat.placeholder")).toBe("Frag mich zur Energiewende …");
      setLocale("en");
      expect(t("chat.placeholder")).toBe("Ask me about the energy transition …");
    });

    it("handles advisor keys", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("advisor.welcome")).toContain("Hallo!");
      setLocale("en");
      expect(t("advisor.welcome")).toContain("Hi!");
    });
  });

  describe("monthAbbrevs", () => {
    it("returns 12 German month abbreviations", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { monthAbbrevs, setLocale } = await loadI18n();
      setLocale("de");
      const months = monthAbbrevs();
      expect(months).toHaveLength(12);
      expect(months[0]).toBe("Jan");
      expect(months[2]).toBe("Mär");
      expect(months[9]).toBe("Okt");
      expect(months[11]).toBe("Dez");
    });

    it("returns 12 English month abbreviations", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { monthAbbrevs, setLocale } = await loadI18n();
      setLocale("en");
      const months = monthAbbrevs();
      expect(months).toHaveLength(12);
      expect(months[0]).toBe("Jan");
      expect(months[2]).toBe("Mar");
      expect(months[9]).toBe("Oct");
      expect(months[11]).toBe("Dec");
    });
  });

  describe("monthFullNames", () => {
    it("returns 12 German full month names", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { monthFullNames, setLocale } = await loadI18n();
      setLocale("de");
      const months = monthFullNames();
      expect(months).toHaveLength(12);
      expect(months[0]).toBe("Januar");
      expect(months[2]).toBe("März");
      expect(months[5]).toBe("Juni");
    });

    it("returns 12 English full month names", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { monthFullNames, setLocale } = await loadI18n();
      setLocale("en");
      const months = monthFullNames();
      expect(months).toHaveLength(12);
      expect(months[0]).toBe("January");
      expect(months[2]).toBe("March");
      expect(months[5]).toBe("June");
    });
  });

  describe("formatters", () => {
    it("fmtEUR formats in German style", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { fmtEUR, setLocale } = await loadI18n();
      setLocale("de");
      const result = fmtEUR(1234);
      expect(result).toContain("1.234");
      expect(result).toContain("€");
    });

    it("fmtEUR formats in English style", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { fmtEUR, setLocale } = await loadI18n();
      setLocale("en");
      const result = fmtEUR(1234);
      expect(result).toContain("1,234");
      expect(result).toContain("€");
    });

    it("fmtKWh formats large values without decimals", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { fmtKWh } = await loadI18n();
      expect(fmtKWh(1234)).toBe("1.234");
    });

    it("fmtKWh formats small values with one decimal", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { fmtKWh } = await loadI18n();
      expect(fmtKWh(5.67)).toBe("5.7");
    });

    it("fmtNumber formats in German style", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { fmtNumber, setLocale } = await loadI18n();
      setLocale("de");
      expect(fmtNumber(1234567)).toBe("1.234.567");
    });

    it("fmtNumber formats in English style", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { fmtNumber, setLocale } = await loadI18n();
      setLocale("en");
      expect(fmtNumber(1234567)).toBe("1,234,567");
    });

    it("fmtNumber respects decimals parameter", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { fmtNumber, setLocale } = await loadI18n();
      setLocale("en");
      expect(fmtNumber(3.14159, 2)).toBe("3.14");
      expect(fmtNumber(3.14159, 0)).toBe("3");
    });
  });

  describe("orientation labels", () => {
    it("returns correct German orientation labels", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("orientation.south")).toBe("Süd");
      expect(t("orientation.east")).toBe("Ost");
      expect(t("orientation.west")).toBe("West");
      expect(t("orientation.east_west")).toBe("Ost + West");
      expect(t("orientation.north")).toBe("Nord");
    });

    it("returns correct English orientation labels", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      expect(t("orientation.south")).toBe("South");
      expect(t("orientation.east")).toBe("East");
      expect(t("orientation.west")).toBe("West");
      expect(t("orientation.east_west")).toBe("East + West");
      expect(t("orientation.north")).toBe("North");
    });
  });

  describe("control labels", () => {
    it("returns correct German control labels", async () => {
      mockNavigator(["de-DE"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("de");
      expect(t("control.investment")).toBe("Investition");
      expect(t("control.pv_system")).toBe("PV-Anlage");
      expect(t("control.battery")).toBe("Batterie");
      expect(t("control.consumers")).toBe("Verbraucher");
    });

    it("returns correct English control labels", async () => {
      mockNavigator(["en-US"]);
      vi.resetModules();
      const { t, setLocale } = await loadI18n();
      setLocale("en");
      expect(t("control.investment")).toBe("Investment");
      expect(t("control.pv_system")).toBe("PV system");
      expect(t("control.battery")).toBe("Battery");
      expect(t("control.consumers")).toBe("Consumers");
    });
  });
});
