// Internationalization (i18n) — lightweight, zero-dependency.
//
// Usage:
//   import { t, setLocale, getLocale } from "../i18n";
//   const label = t("chart.pv_yield");  // "PV-Ertrag" or "PV yield"
//
// The locale is auto-detected from navigator.languages on first access.
// Call `setLocale("en")` or `setLocale("de")` to override.

export type Locale = "de" | "en";

const STORAGE_KEY = "pv-calc-locale";

let currentLocale: Locale = loadLocale();

function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "de" || stored === "en") return stored;
  } catch { /* localStorage unavailable (SSR / test) */ }
  return detectLocale();
}

function detectLocale(): Locale {
  const langs = navigator.languages || [navigator.language];
  for (const lang of langs) {
    if (lang.startsWith("de")) return "de";
  }
  return "en";
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
}

// ---- Message catalogs ------------------------------------------------------

type Messages = Record<string, string>;

const de: Messages = {
  // Consumer labels
  "consumer.household": "Haushalt",
  "consumer.heatpump": "Wärmepumpe",
  "consumer.bwwp": "Brauchw.-WP",
  "consumer.bwwp.full": "Brauchwasser-WP",
  "consumer.ev": "E-Auto",

  // Monthly chart
  "chart.monthly.title": "Energiefluss pro Monat",
  "chart.monthly.y_axis": "Energie kWh/Monat (max {max})",
  "chart.monthly.y_axis_net": "Netto €/Monat (0 = gestrichelt)",
  "chart.monthly.hint": "Klick auf einen Monat → Stundendetail. Gestapelte Balken = Verbrauch pro Verbraucher; Linien: PV-Ertrag (gold) und Netto-€ (türkis).",
  "chart.monthly.legend_pv": "PV-Ertrag",
  "chart.monthly.legend_net": "Netto €",
  "chart.monthly.tooltip_sum": "Summe Verbrauch",

  // Hourly chart
  "chart.hourly.title": "{month} — kWh/h · gestapelte Fläche = Verbrauch pro Verbraucher{soc}",
  "chart.hourly.y_axis": "kWh/h",
  "chart.hourly.y_axis_price": "Preis €/MWh (max {max})",
  "chart.hourly.y_axis_price_none": "kein Preisverlauf",
  "chart.hourly.legend_pv": "PV-Ertrag",
  "chart.hourly.legend_import": "Netz-Import",
  "chart.hourly.legend_soc": "Batterie-SoC",
  "chart.hourly.legend_price": "Preis",
  "chart.hourly.tooltip_time": "{month}, {hour}:00 Uhr",
  "chart.hourly.tooltip_sum": "Summe Verbrauch",
  "chart.hourly.tooltip_pv": "PV produziert",
  "chart.hourly.tooltip_import": "Netz-Import",
  "chart.hourly.tooltip_self": "Eigenverbrauch",
  "chart.hourly.tooltip_export": "Export",
  "chart.hourly.tooltip_soc": "Batterie-SoC",
  "chart.hourly.tooltip_price": "Ø Strompreis",

  // Scenario chart
  "chart.scenario.title": "Jahresbilanz je Tarifkombination (€)",
  "chart.scenario.hint": "Blau = Export-Erlös (nach oben), Rot = Import-Kosten (nach unten). Netto = Erlös − Kosten.",
  "chart.scenario.legend_export": "Export-Erlös",
  "chart.scenario.legend_import": "Import-Kosten",
  "chart.scenario.legend_net": "Netto (Erlös−Kosten)",
  "chart.scenario.tooltip_export": "Export-Erlös",
  "chart.scenario.tooltip_import": "Import-Kosten",
  "chart.scenario.netto": "Netto",

  // Comparison chart
  "chart.comparison.title": "Jahreserlös (€)",
  "chart.comparison.hint": "Balken: Direktvermarktung (türkis) vs. feste Einspeisung (grau). Export-Vergleich über die Preisjahre.",
  "chart.comparison.legend_direct": "Direktvermarktung",
  "chart.comparison.legend_fixed": "Feste Einspeisung",
  "chart.comparison.tooltip_direct": "Direktvermarktung (netto)",
  "chart.comparison.tooltip_avg_price": "Ø Preis",
  "chart.comparison.tooltip_export": "Export",
  "chart.comparison.tooltip_premium": "Marktprämie",
  "chart.comparison.tooltip_fixed": "Feste Einspeisung",

  // Tariff combination chart
  "chart.tariff.title": "{combo} — Jahresbilanz (€)",
  "chart.tariff.y_axis": "Jahresbilanz (€)",

  // Tooltip shared
  "tooltip.pv_yield": "PV-Ertrag",
  "tooltip.consumption": "Verbrauch",
  "tooltip.self_use": "Eigenverbrauch",
  "tooltip.export": "Export",
  "tooltip.import": "Netz-Import",
  "tooltip.netto": "Netto",

  // Units
  "unit.kwh": "kWh",
  "unit.kwh_h": "kWh/h",
  "unit.kwp": "kWp",
  "unit.kw": "kW",
  "unit.eur": "€",
  "unit.ct_kwh": "ct/kWh",
  "unit.eur_mwh": "€/MWh",
  "unit.percent": "%",
  "unit.wh": "Wh",
  "unit.hours": "Uhr",

  // Month abbreviations
  "month.jan": "Jan",
  "month.feb": "Feb",
  "month.mar": "Mär",
  "month.apr": "Apr",
  "month.may": "Mai",
  "month.jun": "Jun",
  "month.jul": "Jul",
  "month.aug": "Aug",
  "month.sep": "Sep",
  "month.oct": "Okt",
  "month.nov": "Nov",
  "month.dec": "Dez",

  // Month full names
  "month.january": "Januar",
  "month.february": "Februar",
  "month.march": "März",
  "month.april": "April",
  "month.may_full": "Mai",
  "month.june": "Juni",
  "month.july": "Juli",
  "month.august": "August",
  "month.september": "September",
  "month.october": "Oktober",
  "month.november": "November",
  "month.december": "Dezember",

  // Orientation
  "orientation.south": "Süd",
  "orientation.east": "Ost",
  "orientation.west": "West",
  "orientation.east_west": "Ost + West",
  "orientation.north": "Nord",

  // Controls
  "control.expert": "Experte",
  "control.investment": "Investition",
  "control.pv_system": "PV-Anlage",
  "control.battery": "Batterie",
  "control.consumers": "Verbraucher",
  "control.feed_in": "Vergütung",
  "control.export_model": "Einspeisung",
  "control.import_scheme": "Stromtarif",
  "control.total_investment": "Gesamtinvestition",
  "control.peak_power": "Peak-Leistung",
  "control.tilt": "Neigung",
  "control.capacity": "Kapazität",
  "control.max_power": "Max. Leistung",
  "control.min_soc": "Min. SOC",
  "control.max_soc": "Max. SOC",
  "control.orientation": "Ausrichtung",
  "control.location": "Standort",
  "control.charge_strategy": "Ladestrategie",
  "control.consumption": "Verbrauch",
  "control.jaz": "JAZ",
  "control.pv_share": "PV-Anteil",
  "control.feed_in_rate": "Einspeisevergütung",
  "control.import_rate": "Arbeitspreis",
  "control.commissioning_year": "Inbetriebnahme-Jahr",
  "control.model": "Modell",
  "control.tariff_model": "Tarifmodell",
  "control.price_year": "Spotmarkt-Jahr",
  "control.discharge_evening": "Entladung abends",
  "control.discharge_morning": "Entladung morgens",
  "control.evening_from": "Abend-Fenster von",
  "control.evening_to": "Abend-Fenster bis",
  "control.morning_from": "Morgen-Fenster von",
  "control.morning_to": "Morgen-Fenster bis",
  "control.household": "Haushalt",
  "control.heatpump": "Wärmepumpe",
  "control.bwwp": "Brauchwasser-WP",
  "control.ev": "E-Auto",

  // Charge strategies
  "strategy.morning": "Morgens (PV-Überschuss)",
  "strategy.midday": "Mittags (nur PV)",
  "strategy.cheap": "Billiger Strom (PV + Netz bei Negativpreis)",

  // Export models
  "export.direct": "Direktvermarktung (Spot + Marktprämie)",
  "export.fixed": "Feste Einspeisevergütung",

  // Import schemes
  "import.fixed": "Fester Arbeitspreis",
  "import.dynamic": "Dynamisch (Spot)",
  "import.dynamic14a": "Dynamisch + §14a/3",

  // Summary cards
  "summary.pv_yield": "PV-Ertrag",
  "summary.consumption": "Verbrauch",
  "summary.self_consumption": "Eigenverbrauch",
  "summary.grid_import": "Netz-Import",
  "summary.export": "Export",
  "summary.net_balance": "Netto-Bilanz",
  "summary.eff_price": "Eff. Strompreis",
  "summary.amortisation": "Amortisation",
  "summary.per_year": "pro Jahr",
  "summary.of_consumption": "des Verbrauchs",
  "summary.to_grid": "ins Netz",
  "summary.export_import": "Export − Import",
  "summary.netto": "netto",
  "summary.annual_savings": "Jahresersparnis ",
  "summary.export_revenue": "Export-Erlös",
  "summary.direct_marketing": "Direktvermarktung",
  "summary.fixed_feed_in": "Feste Vergütung",
  "summary.grid_cost": "Stromkosten",
  "summary.market_premium": "Marktprämie",
  "summary.eeg_reference": "EEG Referenz",
  "summary.eeg_value": "anzulegender Wert",
  "summary.eff_price_household": "Eff. Preis Haushalt",
  "summary.eff_price_heatpump": "Eff. Preis Wärmepumpe",
  "summary.eff_price_ev": "Eff. Preis E-Auto",
  "summary.investment": "Investition",

  // Heating section
  "heating.title": "Heizkosten im Vergleich",
  "heating.hint": "Was dieselbe Wärmemenge (Wärmepumpe) mit Heizöl oder Erdgas kosten würde — inkl. Wirkungsgrad, Schornsteinfeger und (Gas) Netzentgelt + Nebenkosten.",
  "heating.heatpump": "Wärmepumpe",
  "heating.oil": "Heizöl",
  "heating.gas": "Erdgas",
  "heating.wood": "Holz",

  // BWWP section
  "bwwp.title": "Brauchwasser-Wärmepumpe",
  "bwwp.hint": "Warmwasser-Strombedarf und wie viel davon aus eigener PV+Speicher gedeckt wird (der Mittags-Block lädt bevorzugt aus der Sonne).",

  // Car section
  "car.title": "Auto im Vergleich — E-Auto vs. Diesel",
  "car.hint": "Was dieselbe jährliche Fahrleistung (E-Auto) mit einem Diesel kosten würde — inkl. Wartung/Verschleiß, Kfz-Steuer und Versicherung + TÜV.",
  "car.ev": "E-Auto",
  "car.diesel": "Diesel",

  // Hourly distribution
  "hourly.title": "Stundenverteilung",

  // Scenario comparison
  "scenario.title": "Szenarienvergleich — Netto-Bilanz",
  "scenario.hint": "Netto = Export-Erlös − Import-Kosten für Kombinationen aus Einspeisung (fest vs. Direktvermarktung) und Stromtarif (fest vs. dynamisch vs. dynamisch + §14a/3).",

  // Tariff combinations
  "tariff.title": "Tarifkombinationen — historische Preisjahre 2023–2026",
  "tariff.hint": "Je Kombination aus Einspeisung (fest vs. Direktvermarktung) und Bezug (fest vs. dynamisch/Tibber vs. dynamisch + §14a/3): Export-Erlös, Import-Kosten und Netto-Bilanz, berechnet über die vier Spot-Preisjahre.",

  // Scenario labels
  "scenario.fixed_feed": "Feste Einspeisung (§ 14a/2)",
  "scenario.direct_market": "Direktvermarktung (Marktprämie)",
  "scenario.dynamic_import": "Dynamischer Bezug (spotbasiert)",
  "scenario.dynamic14a": "Dynamisch + § 14a/3",
  "scenario.combo_fixed_fixed": "Feste Einspeisung & fester Bezug",
  "scenario.combo_direct_fixed": "Direktvermarktung & fester Bezug",
  "scenario.combo_direct_dynamic": "Direktvermarktung & dynamischer Bezug (Tibber)",
  "scenario.combo_direct_dynamic14a": "Direktvermarktung & dynamisch + §14a/3",

  // Scenario presets
  "scenario.none": "Kein PV (Basis)",
  "scenario.balkon": "Balkonkraftwerk",
  "scenario.ew": "Ost/West",
  "scenario.south": "Süd",

  // Coverage line
  "coverage.grid_price_dynamic": "Ø dynamischer Netzpreis",
  "coverage.grid_price_fixed": "fester Netzpreis",
  "coverage.pv_battery": "PV+Speicher:",
  "coverage.grid": "Netz:",
  "coverage.effective": "Effektiv:",

  // Opportunity
  "opportunity.vs_hp": "ggü. Wärmepumpe",
  "opportunity.vs_ev": "ggü. E-Auto",
  "opportunity.energy": "Energie",
  "opportunity.grid": "Netz",
  "opportunity.maintenance": "Wartung",
  "opportunity.tax": "Steuer",
  "opportunity.chimney": "Schornsteinfeger",
  "opportunity.other_costs": "Nebenk.",
  "opportunity.savings": "Ersparnis ggü.",
  "opportunity.per_year_finance": "/Jahr · finanzierbar in",
  "opportunity.years_pv": "J. (PV-Amortisation):",

  // Car comparison
  "car.comparison": "E-Auto vs. Diesel:",
  "car.per_year": "pro Jahr",

  // BWWP
  "bwwp.electricity": "Brauchwasser:",
  "bwwp.pv_block": "kWh Strom/Jahr (Mittags-PV-Block 11–15 Uhr)",

  // Import scheme labels
  "import.label_fixed": "fester Tarif",
  "import.label_dynamic": "dynamisch (Spot)",
  "import.label_dynamic14a": "dynamisch + §14a/3",

  // Excel workbook
  "workbook.creator": "PV-Erlösrechner",
  "workbook.legend": "Legende:",
  "workbook.input": "Eingabe",
  "workbook.calibration": "Kalibr.",
  "workbook.legend_note": "gelb = Ihre Eingabe · orange = aus 15-Min-Simulation (anpassbar) · grau = Formel · grün = Ergebnis",

  // Sheet names
  "sheet.summary": "Zusammenfassung",
  "sheet.pv": "PV-Produktion",
  "sheet.household": "Haushalt",
  "sheet.heatpump": "Waermepumpe",
  "sheet.ev": "E-Auto",
  "sheet.bwwp": "Brauchwasser",
  "sheet.heating": "Heizung",
  "sheet.car": "Auto",
  "sheet.aggregate": "Aggregat",
  "sheet.overview": "Gesamtkalkulation",
  "sheet.example_days": "Beispieltage",
  "sheet.monthly_overview": "Monatsuebersicht",

  // Sheet titles
  "sheet.summary_title": "Zusammenfassung",
  "sheet.summary_subtitle": "Ihre Investition ist die Eingabe; Bilanz und Amortisation ergeben sich per Formel.",
  "sheet.pv_title": "PV-Produktion",
  "sheet.pv_subtitle": "Ihre Anlagengröße bestimmt den Ertrag; der spezifische Ertrag kommt aus der Simulation.",
  "sheet.heating_title": "Heizkostenvergleich — Wärmepumpe vs. Heizöl vs. Erdgas",
  "sheet.heating_subtitle": "Gleiche Nutzwärme für alle drei Optionen; alle Kosten als nachvollziehbare Formeln.",
  "sheet.car_title": "Fahrkostenvergleich — E-Auto vs. Diesel",
  "sheet.car_subtitle": "Gleiche Jahresfahrleistung; alle Kosten als nachvollziehbare Formeln.",
  "sheet.aggregate_title": "Aggregierte Energie- und Kostenbilanz",
  "sheet.aggregate_subtitle": "Verbrauch ist Ihre Eingabe; Energieflüsse & Erlöse stammen aus der Simulation.",
  "sheet.overview_title": "Gesamtkalkulation",
  "sheet.overview_subtitle": "Produktion, Import, Export und alle Verbraucher (Haushalt, WP, BWWP, E-Auto) in einer Übersicht.",
  "sheet.example_days_subtitle": "Durchschnittlicher Tagesverlauf (24 h) je Monat aus der 15-Min-Simulation. Netzbezug = Last − Eigenverbrauch; Ø-Preis & Ø-Netzentgelt = Mittel dieser Tages-/Jahreszeit.",
  "sheet.monthly_overview_title": "Monatsübersicht — ganzes Jahr (eine Zeile = ein Monat)",
  "sheet.monthly_overview_subtitle": "Produktion, Verbrauch je Verbraucher, Eigenverbrauch, Netzbezug/Einspeisung sowie Ø-Strompreis & Ø-Netzentgelt pro Monat. Netzbezug = Verbrauch − Eigenverbrauch.",

  // Excel section headers
  "excel.inputs": "Eingaben (wie auf der Webseite)",
  "excel.calibration_section": "Kalibrierung (aus 15-Minuten-Simulation)",
  "excel.calculation": "Berechnung",
  "excel.monthly_distribution": "Monatliche Verteilung (Anteil in % — editierbar)",
  "excel.summary_controls": "Kennzahlen",
  "excel.sheets_included": "Enthaltene Blätter",

  // Excel labels
  "excel.pv_peak": "PV-Spitzenleistung",
  "excel.tilt": "Neigung",
  "excel.specific_yield": "Spezifischer Ertrag",
  "excel.specific_yield_note": "aus Solarmodell (Standort, Neigung, Ausrichtung); hier anpassbar",
  "excel.pv_annual": "PV-Ertrag pro Jahr",
  "excel.pv_formula": "Leistung × spezifischer Ertrag",
  "excel.month": "Monat",
  "excel.share_percent": "Anteil %",
  "excel.kwh_arrow": "→ kWh",
  "excel.sum_check": "Summe (Kontrolle)",
  "excel.annual_consumption": "Jahresverbrauch",
  "excel.annual_consumption_note": "eingestellter Verbrauch dieses Verbrauchers",
  "excel.grid_price": "Netzpreis (Grid)",
  "excel.grid_price_fixed_note": "Ihr fester Tarif",
  "excel.grid_price_dynamic_note": "Ø dynamischer Preis der Bezugsstunden",
  "excel.pv_coverage": "PV+Speicher-Deckung",
  "excel.pv_coverage_note": "Anteil des Verbrauchs aus eigener Sonne (Batterie-Dispatch)",
  "excel.pv_covered": "davon aus PV+Speicher gedeckt",
  "excel.pv_covered_formula": "Verbrauch × PV-Deckung%",
  "excel.grid_import": "Netzbezug",
  "excel.grid_import_formula": "Verbrauch − PV-gedeckt",
  "excel.grid_cost": "Netzkosten",
  "excel.grid_cost_formula": "Netzbezug × Netzpreis (PV = 0 ct/kWh)",
  "excel.eff_price": "Effektiver Strompreis",
  "excel.eff_price_formula": "Netzkosten / Verbrauch (Eigenverbrauch gratis)",

  // Heating sheet
  "excel.hp_electricity": "Wärmepumpe: Strombedarf",
  "excel.hp_electricity_note": "= Verbrauch des WP-Verbrauchers",
  "excel.jaz": "Jahresarbeitszahl (JAZ)",
  "excel.jaz_note": "Nutzwärme je kWh Strom",
  "excel.oil_price": "Heizöl-Preis",
  "excel.oil_price_note": "Standardannahme",
  "excel.oil_heating_value": "Heizöl Heizwert",
  "excel.oil_efficiency": "Ölkessel-Wirkungsgrad",
  "excel.oil_chimney": "Schornsteinfeger (Öl)",
  "excel.gas_price": "Gaspreis",
  "excel.gas_efficiency": "Gaskessel-Wirkungsgrad",
  "excel.gas_grid_fee": "Gas-Netzentgelt",
  "excel.gas_fixed_costs": "Gas-Nebenkosten (Grundgebühr)",
  "excel.gas_chimney": "Schornsteinfeger (Gas)",
  "excel.hp_effective_price": "WP-Strompreis (effektiv)",
  "excel.hp_effective_price_note": "PV-bewusster Effektivpreis der WP-Importe (Netz + gratis PV)",
  "excel.useful_heat": "Nutzwärme",
  "excel.useful_heat_formula": "Strombedarf × JAZ",
  "excel.hp_total_cost": "Wärmepumpe: Gesamtkosten",
  "excel.hp_total_cost_formula": "Strombedarf × Strompreis",
  "excel.oil_energy_need": "Öl-Energiebedarf",
  "excel.oil_energy_need_formula": "Nutzwärme / Wirkungsgrad",
  "excel.oil_amount": "Öl-Menge",
  "excel.oil_amount_formula": "Energiebedarf / Heizwert",
  "excel.oil_energy_cost": "Öl-Energiekosten",
  "excel.oil_energy_cost_formula": "Menge × Preis/100L",
  "excel.oil_total_cost": "Heizöl: Gesamtkosten",
  "excel.oil_total_cost_formula": "Energie + Schornsteinfeger",
  "excel.oil_extra_cost": "Mehrkosten ggü. Wärmepumpe",
  "excel.gas_energy_need": "Gas-Energiebedarf",
  "excel.gas_energy_need_formula": "Nutzwärme / Wirkungsgrad",
  "excel.gas_energy_cost": "Gas-Energiekosten",
  "excel.gas_energy_cost_formula": "Energiebedarf × Preis",
  "excel.gas_grid_cost": "Gas-Netzentgelt",
  "excel.gas_grid_cost_formula": "Energiebedarf × Netzentgelt",
  "excel.gas_total_cost": "Erdgas: Gesamtkosten",
  "excel.gas_total_cost_formula": "Energie + Netz + Nebenk. + Schornsteinfeger",
  "excel.gas_extra_cost": "Mehrkosten ggü. Wärmepumpe",

  // Car sheet
  "excel.ev_annual_km": "Jahresfahrleistung",
  "excel.ev_consumption": "E-Auto Verbrauch",
  "excel.ev_maintenance": "E-Auto Wartung",
  "excel.ev_tax": "E-Auto Kfz-Steuer",
  "excel.ev_insurance": "E-Auto Versicherung + TÜV",
  "excel.diesel_consumption": "Diesel Verbrauch",
  "excel.diesel_price": "Diesel-Preis",
  "excel.diesel_maintenance": "Diesel Wartung",
  "excel.diesel_tax": "Diesel Kfz-Steuer",
  "excel.diesel_insurance": "Diesel Versicherung + TÜV",
  "excel.ev_effective_price": "E-Auto Strompreis (effektiv)",
  "excel.ev_effective_price_note": "PV-bewusster Effektivpreis des Ladestroms (Nachtladen + PV)",
  "excel.ev_energy_need": "E-Auto: Energiebedarf",
  "excel.ev_energy_need_formula": "km/100 × Verbrauch",
  "excel.ev_energy_cost": "E-Auto: Energiekosten",
  "excel.ev_maintenance_cost": "E-Auto: Wartung",
  "excel.ev_total_cost": "E-Auto: Gesamtkosten",
  "excel.ev_total_cost_formula": "Energie + Wartung + Steuer + Nebenk.",
  "excel.diesel_fuel_amount": "Diesel: Kraftstoffmenge",
  "excel.diesel_fuel_amount_formula": "km/100 × Verbrauch",
  "excel.diesel_fuel_cost": "Diesel: Kraftstoffkosten",
  "excel.diesel_maintenance_cost": "Diesel: Wartung",
  "excel.diesel_total_cost": "Diesel: Gesamtkosten",
  "excel.diesel_total_cost_formula": "Kraftstoff + Wartung + Steuer + Nebenk.",
  "excel.diesel_extra_cost": "Mehrkosten ggü. E-Auto",

  // Aggregate sheet
  "excel.total_consumption": "Gesamtverbrauch",
  "excel.pv_yield": "PV-Ertrag",
  "excel.self_consumption": "Eigenverbrauch",
  "excel.self_consumption_note": "PV+Speicher, der die Last deckt",
  "excel.grid_export": "Netz-Einspeisung",
  "excel.export_revenue": "Export-Erlös",
  "excel.import_cost": "Import-Kosten",
  "excel.net_import": "Netz-Import",
  "excel.net_import_formula": "Verbrauch − Eigenverbrauch",
  "excel.self_consumption_rate": "Eigenverbrauchsquote",
  "excel.self_consumption_rate_formula": "Eigenverbrauch / PV-Ertrag",
  "excel.autarky": "Autarkiegrad",
  "excel.autarky_formula": "Eigenverbrauch / Verbrauch",
  "excel.net_balance": "Netto-Bilanz",
  "excel.net_balance_formula": "Export-Erlös − Import-Kosten",

  // Overview sheet
  "excel.consumer_table": "Verbraucher (Verbrauch = Eingabe · PV-Anteil = aus Simulation)",
  "excel.consumer": "Verbraucher",
  "excel.consumption_kwh": "Verbrauch kWh",
  "excel.pv_share_percent": "PV-Anteil %",
  "excel.pv_covered_kwh": "PV-gedeckt kWh",
  "excel.grid_import_kwh": "Netzbezug kWh",
  "excel.eff_ct_kwh": "Eff. ct/kWh",
  "excel.total_consumers": "Summe Verbraucher",
  "excel.energy_balance": "Energiebilanz (Produktion · Import · Export)",
  "excel.pv_production": "PV-Produktion",
  "excel.pv_production_note": "Jahresertrag der Anlage (aus Simulation)",
  "excel.grid_export_label": "Netz-Einspeisung (Export)",
  "excel.self_consumption_total": "Eigenverbrauch (PV+Speicher)",
  "excel.self_consumption_total_note": "Summe PV-gedeckt aller Verbraucher",
  "excel.grid_import_total": "Netz-Import",
  "excel.grid_import_total_note": "Summe Netzbezug aller Verbraucher",
  "excel.total_consumption_label": "Gesamtverbrauch",
  "excel.total_consumption_note": "Summe Verbrauch aller Verbraucher",
  "excel.self_consumption_rate_label": "Eigenverbrauchsquote",
  "excel.self_consumption_rate_note": "Eigenverbrauch / PV-Produktion",
  "excel.autarky_label": "Autarkiegrad",
  "excel.autarky_note": "Eigenverbrauch / Verbrauch",
  "excel.net_balance_label": "Netto-Bilanz",
  "excel.net_balance_note": "Export-Erlös − Import-Kosten",

  // Example days sheet
  "excel.hour": "Stunde",
  "excel.pv_kwh": "PV kWh",
  "excel.load_kwh": "Last kWh",
  "excel.self_use_kwh": "Eigenverbr. kWh",
  "excel.grid_import_kwh2": "Netzbezug kWh",
  "excel.grid_export_kwh": "Einspeisung kWh",
  "excel.avg_price": "Ø Strompreis ct/kWh",
  "excel.avg_grid_fee": "Ø Netzentgelt ct/kWh",
  "excel.soc_kwh": "SoC kWh",
  "excel.day_total": "Tagessumme",
  "excel.day_example": "Beispieltag — {label}",

  // Monthly overview sheet
  "excel.year": "Jahr",
  "excel.monthly_values": "Monatswerte",

  // Summary sheet
  "excel.investment_total": "Investition (gesamt)",
  "excel.baseline_cost": "Baseline-Stromkosten (ohne PV)",
  "excel.baseline_cost_note": "Kosten, wenn der ganze Verbrauch aus dem Netz käme",
  "excel.net_balance_short": "Netto-Bilanz",
  "excel.net_balance_short_note": "Export − Import",
  "excel.annual_savings": "Jahresersparnis",
  "excel.annual_savings_note": "Baseline-Kosten + Netto-Bilanz",
  "excel.payback": "Amortisationszeit",
  "excel.payback_formula": "Investition / Jahresersparnis",
  "excel.eff_price_total": "Effektiver Strompreis (gesamt)",
  "excel.npv": "Kapitalwert (NPV)",
  "excel.irr": "Interne Rendite (IRR)",
  "excel.lcoe": "Stromgestehungskosten (LCOE)",

  // Overview sheet descriptions
  "excel.desc_pv": "Leistung × spezifischer Ertrag, monatliche Verteilung",
  "excel.desc_consumers": "Verbrauch, PV-Deckung, effektiver Preis",
  "excel.desc_heating": "Wärmepumpe vs. Heizöl vs. Erdgas",
  "excel.desc_car": "E-Auto vs. Diesel",
  "excel.desc_aggregate": "Energie- und Kostenbilanz",
  "excel.desc_overview": "Produktion, Import, Export & alle Verbraucher in einer Übersicht",
  "excel.desc_example_days": "Stündliche Tagesprofile (Jan, März, Juli) mit Verbrauchern, Ø-Preis & Netzentgelt",
  "excel.desc_monthly": "Ganzes Jahr, eine Zeile je Monat: Verbrauch, Eigenverbrauch, Preise, Netto",

  // Consumer sheet titles
  "excel.household_title": "Haushalt (H0-Lastprofil)",
  "excel.heatpump_title": "Wärmepumpe (Heizung)",
  "excel.ev_title": "E-Auto (Laden)",
  "excel.bwwp_title": "Brauchwasser-Wärmepumpe",

  // Wizard
  "wizard.title": "PV-Szenario-Baukasten & Berater",
  "wizard.subtitle": "Was-wäre-wenn? — Schieberegler links, intelligenter Energiewende-Berater rechts. Beides steuert dasselbe Szenario.",
  "wizard.monthly_title": "Energiefluss pro Monat",
  "wizard.monthly_hint": "Klicke auf einen Monat, um die Stundendetail-Ansicht (inkl. Batterie-SoC) zu sehen.",
  "wizard.hourly_title": "Stundendetail",
  "wizard.scenario_title": "Szenarienvergleich — Netto-Bilanz",
  "wizard.scenario_hint": "Netto = Export-Erlös − Import-Kosten für verschiedene Einspeise- & Bezugstarife.",
  "wizard.alternatives_title": "Alternativen im Vergleich",
  "wizard.alternatives_hint": "Was dieselbe Wärmemenge (Wärmepumpe) mit Heizöl/Erdgas und dasselbe Auto (E-Auto) mit Diesel kosten würde.",
  "wizard.open_full": "🔗 Im vollen Rechner öffnen",
  "wizard.copy_link": "📋 Permalink kopieren",
  "wizard.copied": "kopiert!",
  "wizard.advisor_title": "Energiewende-Berater",

  // Wizard presets
  "wizard.pv_none": "Kein PV",
  "wizard.pv_none_sub": "Basis",
  "wizard.pv_balkon": "Balkonkraftwerk",
  "wizard.pv_balkon_sub": "800 Wp · Süd",
  "wizard.pv_10kw": "10 kWp",
  "wizard.pv_10kw_sub": "Süd · 35°",
  "wizard.pv_20kw": "20 kWp",
  "wizard.pv_20kw_sub": "Ost/West · 35°",
  "wizard.battery_none": "Ohne Speicher",
  "wizard.battery_none_sub": "einfach",
  "wizard.battery_with": "Mit Speicher",
  "wizard.battery_with_sub": "mehr Eigenverbrauch",

  // Wizard steps
  "wizard.step_household": "Haushalt & Strompreis",
  "wizard.step_household_desc": "Personenanzahl setzt das Standard-Lastprofil (1 → 1.500 … 2 → 2.500 kWh).",
  "wizard.step_persons": "Personen im Haushalt",
  "wizard.step_consumption": "Jahresverbrauch Haushalt",
  "wizard.step_price": "Strompreis",
  "wizard.step_location": "Ort",
  "wizard.step_consumers": "Weitere Verbraucher",
  "wizard.step_consumers_desc": "Optional — erhöht den Eigenverbrauch.",
  "wizard.step_pv": "PV-Anlage wählen",
  "wizard.step_pv_desc": "Vom Balkonkraftwerk bis Volldach.",
  "wizard.step_battery": "Speicher",
  "wizard.step_battery_desc": "Hebt den Eigenverbrauch.",

  // Wizard toggles
  "wizard.heatpump_label": "Wärmepumpe",
  "wizard.heatpump_sub": "~5.000 kWh/Jahr",
  "wizard.ev_label": "E-Auto",
  "wizard.ev_sub": "~2.000 kWh/Jahr (80% PV)",
  "wizard.bwwp_label": "Brauchwasser-WP",
  "wizard.bwwp_sub": "~400 kWh/Jahr",

  // Wizard summary
  "wizard.sum_pv_yield": "PV-Ertrag",
  "wizard.sum_self_use": "Eigenverbrauch",
  "wizard.sum_grid_import": "Netz-Import",
  "wizard.sum_netto": "Netto (Export−Import)",
  "wizard.sum_savings": "Ersparnis ggü. Basis",
  "wizard.sum_amortisation": "Amortisation",
  "wizard.sum_eff_price": "Eff. Strompreis",
  "wizard.sum_per_year": "pro Jahr",
  "wizard.sum_self_pv": "des PV",
  "wizard.sum_weighted": "gewichteter Ø",

  // Wizard recommendation
  "wizard.rec_baseline": "Ausgangspunkt: deine reinen Bezugskosten.",
  "wizard.rec_with": "mit",
  "wizard.rec_without": "ohne",
  "wizard.rec_battery": "Speicher.",

  // Wizard hourly
  "wizard.hourly_detail": "Stundendetail —",

  // Chat UI
  "chat.placeholder": "Frag mich zur Energiewende …",
  "chat.send": "Senden",
  "chat.error": "Entschuldigung, etwas ist schiefgelaufen.",

  // Chat advisor
  "advisor.years": "Jahre",
  "advisor.summary": "Zusammenfassung –",
  "advisor.consumer_at": "Verbraucher @",
  "advisor.location": "Ort ",
  "advisor.pv_yield": "PV-Ertrag",
  "advisor.self_consumption": "Eigenverbrauch",
  "advisor.netto": "Netto",
  "advisor.savings": "Ersparnis",
  "advisor.amortisation": "Amortisation",
  "advisor.eff_price": "eff. Strompreis",
  "advisor.full_details": "Volle Details & Charts im Rechner:",
  "advisor.accepted": "Übernommen:",
  "advisor.result": "Ergebnis",
  "advisor.with_battery": "mit Speicher",
  "advisor.without_battery": "ohne Speicher",
  "advisor.netto_label": "Netto (Export − Import):",
  "advisor.savings_label": "Ersparnis ggü. Basis:",
  "advisor.price_change": "Strompreis →",
  "advisor.location_change": "Ort →",
  "advisor.pv_none": "PV → Kein PV (Basis)",
  "advisor.battery_off": "Speicher → aus",
  "advisor.battery_on": "Speicher →",
  "advisor.investment_change": "Investment →",
  "advisor.heatpump_on": "Wärmepumpe → ein",
  "advisor.ev_on": "E-Auto → ein",
  "advisor.bwwp_on": "Brauchwasser-WP → ein",
  "advisor.consumption_change": "Jahresverbrauch →",

  // Chat welcome
  "advisor.welcome": "Hallo! Ich passe dein PV-Szenario direkt an, sobald du mir etwas sagst - ganz ohne Rueckfrage. Beispiele: 'Strompreis 24 ct', 'Waermepumpe 3000', '10 kWp mit Speicher', 'anderer Ort Hamburg'.",
  "advisor.current": "Aktuell:",

  // Chat clarify
  "advisor.clarify": "Ich habe keine Änderung erkannt. Sag mir z. B., was ich anpassen soll:",
  "advisor.clarify_price": "Strompreis ('24 ct')",
  "advisor.clarify_location": "Ort ('Hamburg')",
  "advisor.clarify_pv": "PV ('Balkonkraftwerk', '10 kWp', '20 kWp')",
  "advisor.clarify_battery": "Speicher ('mit/ohne Speicher')",
  "advisor.clarify_consumers": "Verbraucher ('Wärmepumpe 3000', 'E-Auto', 'Brauchwasser').",

  // UI
  "ui.sidebar_toggle": "⚙️ Eingaben",
  "ui.sidebar_toggle_title": "Eingaben ein-/ausblenden",
  "ui.title": "PV-Erlösrechner",
  "ui.subtitle": "Direktvermarktung mit Batterie — Simulation von PV-Produktion, Speicher-Verschiebung und Spotmarkt-Erlösen.",
  "ui.excel_button": "📊 Excel-Export (.xlsx)",
  "ui.excel_button_title": "Excel-Datei mit allen Berechnungen und Formeln herunterladen",
  "ui.excel_loading": "⏳ Erzeuge…",
  "ui.excel_error": "Excel-Export fehlgeschlagen. Details in der Konsole.",
};

const en: Messages = {
  // Consumer labels
  "consumer.household": "Household",
  "consumer.heatpump": "Heat pump",
  "consumer.bwwp": "DHW HP",
  "consumer.bwwp.full": "Domestic hot water HP",
  "consumer.ev": "EV",

  // Monthly chart
  "chart.monthly.title": "Energy flow per month",
  "chart.monthly.y_axis": "Energy kWh/month (max {max})",
  "chart.monthly.y_axis_net": "Net €/month (0 = dashed)",
  "chart.monthly.hint": "Click a month → hourly detail. Stacked bars = consumption per appliance; lines: PV yield (gold) and net € (teal).",
  "chart.monthly.legend_pv": "PV yield",
  "chart.monthly.legend_net": "Net €",
  "chart.monthly.tooltip_sum": "Total consumption",

  // Hourly chart
  "chart.hourly.title": "{month} — kWh/h · stacked area = consumption per appliance{soc}",
  "chart.hourly.y_axis": "kWh/h",
  "chart.hourly.y_axis_price": "Price €/MWh (max {max})",
  "chart.hourly.y_axis_price_none": "no price data",
  "chart.hourly.legend_pv": "PV yield",
  "chart.hourly.legend_import": "Grid import",
  "chart.hourly.legend_soc": "Battery SoC",
  "chart.hourly.legend_price": "Price",
  "chart.hourly.tooltip_time": "{month}, {hour}:00",
  "chart.hourly.tooltip_sum": "Total consumption",
  "chart.hourly.tooltip_pv": "PV produced",
  "chart.hourly.tooltip_import": "Grid import",
  "chart.hourly.tooltip_self": "Self-consumption",
  "chart.hourly.tooltip_export": "Export",
  "chart.hourly.tooltip_soc": "Battery SoC",
  "chart.hourly.tooltip_price": "Avg. price",

  // Scenario chart
  "chart.scenario.title": "Annual balance per tariff combination (€)",
  "chart.scenario.hint": "Blue = export revenue (up), Red = import cost (down). Net = revenue − cost.",
  "chart.scenario.legend_export": "Export revenue",
  "chart.scenario.legend_import": "Import cost",
  "chart.scenario.legend_net": "Net (revenue−cost)",
  "chart.scenario.tooltip_export": "Export revenue",
  "chart.scenario.tooltip_import": "Import cost",
  "chart.scenario.netto": "Net",

  // Comparison chart
  "chart.comparison.title": "Annual revenue (€)",
  "chart.comparison.hint": "Bars: direct marketing (teal) vs. fixed feed-in (grey). Export comparison across price years.",
  "chart.comparison.legend_direct": "Direct marketing",
  "chart.comparison.legend_fixed": "Fixed feed-in",
  "chart.comparison.tooltip_direct": "Direct marketing (net)",
  "chart.comparison.tooltip_avg_price": "Avg. price",
  "chart.comparison.tooltip_export": "Export",
  "chart.comparison.tooltip_premium": "Market premium",
  "chart.comparison.tooltip_fixed": "Fixed feed-in",

  // Tariff combination chart
  "chart.tariff.title": "{combo} — Annual balance (€)",
  "chart.tariff.y_axis": "Annual balance (€)",

  // Tooltip shared
  "tooltip.pv_yield": "PV yield",
  "tooltip.consumption": "Consumption",
  "tooltip.self_use": "Self-consumption",
  "tooltip.export": "Export",
  "tooltip.import": "Grid import",
  "tooltip.netto": "Net",

  // Units
  "unit.kwh": "kWh",
  "unit.kwh_h": "kWh/h",
  "unit.kwp": "kWp",
  "unit.kw": "kW",
  "unit.eur": "€",
  "unit.ct_kwh": "ct/kWh",
  "unit.eur_mwh": "€/MWh",
  "unit.percent": "%",
  "unit.wh": "Wh",
  "unit.hours": "",

  // Month abbreviations
  "month.jan": "Jan",
  "month.feb": "Feb",
  "month.mar": "Mar",
  "month.apr": "Apr",
  "month.may": "May",
  "month.jun": "Jun",
  "month.jul": "Jul",
  "month.aug": "Aug",
  "month.sep": "Sep",
  "month.oct": "Oct",
  "month.nov": "Nov",
  "month.dec": "Dec",

  // Month full names
  "month.january": "January",
  "month.february": "February",
  "month.march": "March",
  "month.april": "April",
  "month.may_full": "May",
  "month.june": "June",
  "month.july": "July",
  "month.august": "August",
  "month.september": "September",
  "month.october": "October",
  "month.november": "November",
  "month.december": "December",

  // Orientation
  "orientation.south": "South",
  "orientation.east": "East",
  "orientation.west": "West",
  "orientation.east_west": "East + West",
  "orientation.north": "North",

  // Controls
  "control.expert": "Expert",
  "control.investment": "Investment",
  "control.pv_system": "PV system",
  "control.battery": "Battery",
  "control.consumers": "Consumers",
  "control.feed_in": "Feed-in",
  "control.export_model": "Export model",
  "control.import_scheme": "Tariff",
  "control.total_investment": "Total investment",
  "control.peak_power": "Peak power",
  "control.tilt": "Tilt",
  "control.capacity": "Capacity",
  "control.max_power": "Max. power",
  "control.min_soc": "Min. SOC",
  "control.max_soc": "Max. SOC",
  "control.orientation": "Orientation",
  "control.location": "Location",
  "control.charge_strategy": "Charge strategy",
  "control.consumption": "Consumption",
  "control.jaz": "COP",
  "control.pv_share": "PV share",
  "control.feed_in_rate": "Feed-in rate",
  "control.import_rate": "Electricity rate",
  "control.commissioning_year": "Commissioning year",
  "control.model": "Model",
  "control.tariff_model": "Tariff model",
  "control.price_year": "Spot price year",
  "control.discharge_evening": "Discharge evening",
  "control.discharge_morning": "Discharge morning",
  "control.evening_from": "Evening window from",
  "control.evening_to": "Evening window to",
  "control.morning_from": "Morning window from",
  "control.morning_to": "Morning window to",
  "control.household": "Household",
  "control.heatpump": "Heat pump",
  "control.bwwp": "DHW HP",
  "control.ev": "EV",

  // Charge strategies
  "strategy.morning": "Morning (PV surplus)",
  "strategy.midday": "Midday (PV only)",
  "strategy.cheap": "Cheap power (PV + grid at negative price)",

  // Export models
  "export.direct": "Direct marketing (spot + market premium)",
  "export.fixed": "Fixed feed-in tariff",

  // Import schemes
  "import.fixed": "Fixed rate",
  "import.dynamic": "Dynamic (spot)",
  "import.dynamic14a": "Dynamic + §14a/3",

  // Summary cards
  "summary.pv_yield": "PV yield",
  "summary.consumption": "Consumption",
  "summary.self_consumption": "Self-consumption",
  "summary.grid_import": "Grid import",
  "summary.export": "Export",
  "summary.net_balance": "Net balance",
  "summary.eff_price": "Eff. price",
  "summary.amortisation": "Payback",
  "summary.per_year": "per year",
  "summary.of_consumption": "of consumption",
  "summary.to_grid": "to grid",
  "summary.export_import": "Export − Import",
  "summary.netto": "net",
  "summary.annual_savings": "Annual savings ",
  "summary.export_revenue": "Export revenue",
  "summary.direct_marketing": "Direct marketing",
  "summary.fixed_feed_in": "Fixed feed-in",
  "summary.grid_cost": "Grid cost",
  "summary.market_premium": "Market premium",
  "summary.eeg_reference": "EEG reference",
  "summary.eeg_value": "reference value",
  "summary.eff_price_household": "Eff. price household",
  "summary.eff_price_heatpump": "Eff. price heat pump",
  "summary.eff_price_ev": "Eff. price EV",
  "summary.investment": "Investment",

  // Heating section
  "heating.title": "Heating cost comparison",
  "heating.hint": "What the same heat output (heat pump) would cost with heating oil or natural gas — including efficiency, chimney sweep and (gas) grid fees + ancillary costs.",
  "heating.heatpump": "Heat pump",
  "heating.oil": "Heating oil",
  "heating.gas": "Natural gas",
  "heating.wood": "Wood",

  // BWWP section
  "bwwp.title": "Domestic hot water heat pump",
  "bwwp.hint": "Hot water electricity demand and how much is covered by own PV+battery (the midday block charges preferably from solar).",

  // Car section
  "car.title": "Car comparison — EV vs. diesel",
  "car.hint": "What the same annual mileage (EV) would cost with a diesel — including maintenance/wear, vehicle tax and insurance + TÜV.",
  "car.ev": "EV",
  "car.diesel": "Diesel",

  // Hourly distribution
  "hourly.title": "Hourly distribution",

  // Scenario comparison
  "scenario.title": "Scenario comparison — Net balance",
  "scenario.hint": "Net = export revenue − import cost for combinations of feed-in (fixed vs. direct marketing) and tariff (fixed vs. dynamic vs. dynamic + §14a/3).",

  // Tariff combinations
  "tariff.title": "Tariff combinations — historical price years 2023–2026",
  "tariff.hint": "Per combination of feed-in (fixed vs. direct marketing) and import (fixed vs. dynamic/Tibber vs. dynamic + §14a/3): export revenue, import cost and net balance, calculated over the four spot price years.",

  // Scenario labels
  "scenario.fixed_feed": "Fixed feed-in (§ 14a/2)",
  "scenario.direct_market": "Direct marketing (market premium)",
  "scenario.dynamic_import": "Dynamic import (spot-based)",
  "scenario.dynamic14a": "Dynamic + § 14a/3",
  "scenario.combo_fixed_fixed": "Fixed feed-in & fixed import",
  "scenario.combo_direct_fixed": "Direct marketing & fixed import",
  "scenario.combo_direct_dynamic": "Direct marketing & dynamic import (Tibber)",
  "scenario.combo_direct_dynamic14a": "Direct marketing & dynamic + §14a/3",

  // Scenario presets
  "scenario.none": "No PV (baseline)",
  "scenario.balkon": "Balcony PV",
  "scenario.ew": "East/West",
  "scenario.south": "South",

  // Coverage line
  "coverage.grid_price_dynamic": "Avg. dynamic grid price",
  "coverage.grid_price_fixed": "Fixed grid price",
  "coverage.pv_battery": "PV+battery:",
  "coverage.grid": "Grid:",
  "coverage.effective": "Effective:",

  // Opportunity
  "optionppunity.vs_hp": "vs. heat pump",
  "opportunity.vs_ev": "vs. EV",
  "opportunity.energy": "Energy",
  "opportunity.grid": "Grid",
  "opportunity.maintenance": "Maintenance",
  "opportunity.tax": "Tax",
  "opportunity.chimney": "Chimney sweep",
  "opportunity.other_costs": "Ancillary",
  "opportunity.savings": "Savings vs.",
  "opportunity.per_year_finance": "/yr · financeable in",
  "opportunity.years_pv": "yr (PV payback):",

  // Car comparison
  "car.comparison": "EV vs. diesel:",
  "car.per_year": "per year",

  // BWWP
  "bwwp.electricity": "Hot water:",
  "bwwp.pv_block": "kWh electricity/yr (midday PV block 11–15h)",

  // Import scheme labels
  "import.label_fixed": "fixed tariff",
  "import.label_dynamic": "dynamic (spot)",
  "import.label_dynamic14a": "dynamic + §14a/3",

  // Excel workbook
  "workbook.creator": "PV-Erlösrechner",
  "workbook.legend": "Legend:",
  "workbook.input": "Input",
  "workbook.calibration": "Calibr.",
  "workbook.legend_note": "yellow = your input · orange = from 15-min simulation (adjustable) · grey = formula · green = result",

  // Sheet names
  "sheet.summary": "Summary",
  "sheet.pv": "PV Production",
  "sheet.household": "Household",
  "sheet.heatpump": "Heatpump",
  "sheet.ev": "EV",
  "sheet.bwwp": "Hot water",
  "sheet.heating": "Heating",
  "sheet.car": "Car",
  "sheet.aggregate": "Aggregate",
  "sheet.overview": "Overall calculation",
  "sheet.example_days": "Example days",
  "sheet.monthly_overview": "Monthly overview",

  // Sheet titles
  "sheet.summary_title": "Summary",
  "sheet.summary_subtitle": "Your investment is the input; balance and payback are derived by formula.",
  "sheet.pv_title": "PV Production",
  "sheet.pv_subtitle": "Your system size determines yield; specific yield comes from the simulation.",
  "sheet.heating_title": "Heating cost comparison — Heat pump vs. heating oil vs. natural gas",
  "sheet.heating_subtitle": "Same useful heat for all three options; all costs as traceable formulas.",
  "sheet.car_title": "Driving cost comparison — EV vs. diesel",
  "sheet.car_subtitle": "Same annual mileage; all costs as traceable formulas.",
  "sheet.aggregate_title": "Aggregated energy and cost balance",
  "sheet.aggregate_subtitle": "Consumption is your input; energy flows & revenue come from the simulation.",
  "sheet.overview_title": "Overall calculation",
  "sheet.overview_subtitle": "Production, import, export and all consumers (household, HP, DHW HP, EV) in one overview.",
  "sheet.example_days_subtitle": "Average daily profile (24 h) per month from the 15-min simulation. Grid import = load − self-consumption; avg. price & avg. grid fee = mean of that time of day/year.",
  "sheet.monthly_overview_title": "Monthly overview — full year (one row = one month)",
  "sheet.monthly_overview_subtitle": "Production, consumption per consumer, self-consumption, grid import/export and avg. electricity price & avg. grid fee per month. Grid import = consumption − self-consumption.",

  // Excel section headers
  "excel.inputs": "Inputs (as on the website)",
  "excel.calibration_section": "Calibration (from 15-min simulation)",
  "excel.calculation": "Calculation",
  "excel.monthly_distribution": "Monthly distribution (share in % — editable)",
  "excel.summary_controls": "Key metrics",
  "excel.sheets_included": "Included sheets",

  // Excel labels
  "excel.pv_peak": "PV peak power",
  "excel.tilt": "Tilt",
  "excel.specific_yield": "Specific yield",
  "excel.specific_yield_note": "from solar model (location, tilt, orientation); adjustable here",
  "excel.pv_annual": "PV yield per year",
  "excel.pv_formula": "Power × specific yield",
  "excel.month": "Month",
  "excel.share_percent": "Share %",
  "excel.kwh_arrow": "→ kWh",
  "excel.sum_check": "Sum (check)",
  "excel.annual_consumption": "Annual consumption",
  "excel.annual_consumption_note": "set consumption for this consumer",
  "excel.grid_price": "Grid price",
  "excel.grid_price_fixed_note": "your fixed tariff",
  "excel.grid_price_dynamic_note": "avg. dynamic price of import hours",
  "excel.pv_coverage": "PV+battery coverage",
  "excel.pv_coverage_note": "share of consumption from own solar (battery dispatch)",
  "excel.pv_covered": "of which covered by PV+battery",
  "excel.pv_covered_formula": "Consumption × PV coverage%",
  "excel.grid_import": "Grid import",
  "excel.grid_import_formula": "Consumption − PV-covered",
  "excel.grid_cost": "Grid cost",
  "excel.grid_cost_formula": "Grid import × grid price (PV = 0 ct/kWh)",
  "excel.eff_price": "Effective electricity price",
  "excel.eff_price_formula": "Grid cost / consumption (self-consumption free)",

  // Heating sheet
  "excel.hp_electricity": "Heat pump: electricity demand",
  "excel.hp_electricity_note": "= consumption of HP consumer",
  "excel.jaz": "Seasonal COP (JAZ)",
  "excel.jaz_note": "Useful heat per kWh electricity",
  "excel.oil_price": "Heating oil price",
  "excel.oil_price_note": "standard assumption",
  "excel.oil_heating_value": "Heating oil value",
  "excel.oil_efficiency": "Oil boiler efficiency",
  "excel.oil_chimney": "Chimney sweep (oil)",
  "excel.gas_price": "Gas price",
  "excel.gas_efficiency": "Gas boiler efficiency",
  "excel.gas_grid_fee": "Gas grid fee",
  "excel.gas_fixed_costs": "Gas ancillary costs (fixed)",
  "excel.gas_chimney": "Chimney sweep (gas)",
  "excel.hp_effective_price": "HP electricity price (effective)",
  "excel.hp_effective_price_note": "PV-aware effective price of HP imports (grid + free PV)",
  "excel.useful_heat": "Useful heat",
  "excel.useful_heat_formula": "Electricity demand × COP",
  "excel.hp_total_cost": "Heat pump: total cost",
  "excel.hp_total_cost_formula": "Electricity demand × electricity price",
  "excel.oil_energy_need": "Oil energy need",
  "excel.oil_energy_need_formula": "Useful heat / efficiency",
  "excel.oil_amount": "Oil quantity",
  "excel.oil_amount_formula": "Energy need / heating value",
  "excel.oil_energy_cost": "Oil energy cost",
  "excel.oil_energy_cost_formula": "Quantity × price/100L",
  "excel.oil_total_cost": "Heating oil: total cost",
  "excel.oil_total_cost_formula": "Energy + chimney sweep",
  "excel.oil_extra_cost": "Extra cost vs. heat pump",
  "excel.gas_energy_need": "Gas energy need",
  "excel.gas_energy_need_formula": "Useful heat / efficiency",
  "excel.gas_energy_cost": "Gas energy cost",
  "excel.gas_energy_cost_formula": "Energy need × price",
  "excel.gas_grid_cost": "Gas grid fee",
  "excel.gas_grid_cost_formula": "Energy need × grid fee",
  "excel.gas_total_cost": "Natural gas: total cost",
  "excel.gas_total_cost_formula": "Energy + grid + ancillary + chimney sweep",
  "excel.gas_extra_cost": "Extra cost vs. heat pump",

  // Car sheet
  "excel.ev_annual_km": "Annual mileage",
  "excel.ev_consumption": "EV consumption",
  "excel.ev_maintenance": "EV maintenance",
  "excel.ev_tax": "EV vehicle tax",
  "excel.ev_insurance": "EV insurance + TÜV",
  "excel.diesel_consumption": "Diesel consumption",
  "excel.diesel_price": "Diesel price",
  "excel.diesel_maintenance": "Diesel maintenance",
  "excel.diesel_tax": "Diesel vehicle tax",
  "excel.diesel_insurance": "Diesel insurance + TÜV",
  "excel.ev_effective_price": "EV electricity price (effective)",
  "excel.ev_effective_price_note": "PV-aware effective price of charging (night + PV)",
  "excel.ev_energy_need": "EV: energy need",
  "excel.ev_energy_need_formula": "km/100 × consumption",
  "excel.ev_energy_cost": "EV: energy cost",
  "excel.ev_maintenance_cost": "EV: maintenance",
  "excel.ev_total_cost": "EV: total cost",
  "excel.ev_total_cost_formula": "Energy + maintenance + tax + ancillary",
  "excel.diesel_fuel_amount": "Diesel: fuel quantity",
  "excel.diesel_fuel_amount_formula": "km/100 × consumption",
  "excel.diesel_fuel_cost": "Diesel: fuel cost",
  "excel.diesel_maintenance_cost": "Diesel: maintenance",
  "excel.diesel_total_cost": "Diesel: total cost",
  "excel.diesel_total_cost_formula": "Fuel + maintenance + tax + ancillary",
  "excel.diesel_extra_cost": "Extra cost vs. EV",

  // Aggregate sheet
  "excel.total_consumption": "Total consumption",
  "excel.pv_yield": "PV yield",
  "excel.self_consumption": "Self-consumption",
  "excel.self_consumption_note": "PV+battery that covers the load",
  "excel.grid_export": "Grid export",
  "excel.export_revenue": "Export revenue",
  "excel.import_cost": "Import cost",
  "excel.net_import": "Grid import",
  "excel.net_import_formula": "Consumption − self-consumption",
  "excel.self_consumption_rate": "Self-consumption rate",
  "excel.self_consumption_rate_formula": "Self-consumption / PV yield",
  "excel.autarky": "Autarky rate",
  "excel.autarky_formula": "Self-consumption / consumption",
  "excel.net_balance": "Net balance",
  "excel.net_balance_formula": "Export revenue − import cost",

  // Overview sheet
  "excel.consumer_table": "Consumers (consumption = input · PV share = from simulation)",
  "excel.consumer": "Consumer",
  "excel.consumption_kwh": "Consumption kWh",
  "excel.pv_share_percent": "PV share %",
  "excel.pv_covered_kwh": "PV-covered kWh",
  "excel.grid_import_kwh": "Grid import kWh",
  "excel.eff_ct_kwh": "Eff. ct/kWh",
  "excel.total_consumers": "Total consumers",
  "excel.energy_balance": "Energy balance (production · import · export)",
  "excel.pv_production": "PV production",
  "excel.pv_production_note": "Annual system yield (from simulation)",
  "excel.grid_export_label": "Grid export",
  "excel.self_consumption_total": "Self-consumption (PV+battery)",
  "excel.self_consumption_total_note": "Sum of PV-covered of all consumers",
  "excel.grid_import_total": "Grid import",
  "excel.grid_import_total_note": "Sum of grid import of all consumers",
  "excel.total_consumption_label": "Total consumption",
  "excel.total_consumption_note": "Sum of consumption of all consumers",
  "excel.self_consumption_rate_label": "Self-consumption rate",
  "excel.self_consumption_rate_note": "Self-consumption / PV production",
  "excel.autarky_label": "Autarky rate",
  "excel.autarky_note": "Self-consumption / consumption",
  "excel.net_balance_label": "Net balance",
  "excel.net_balance_note": "Export revenue − import cost",

  // Example days sheet
  "excel.hour": "Hour",
  "excel.pv_kwh": "PV kWh",
  "excel.load_kwh": "Load kWh",
  "excel.self_use_kwh": "Self-use kWh",
  "excel.grid_import_kwh2": "Grid import kWh",
  "excel.grid_export_kwh": "Grid export kWh",
  "excel.avg_price": "Avg. price ct/kWh",
  "excel.avg_grid_fee": "Avg. grid fee ct/kWh",
  "excel.soc_kwh": "SoC kWh",
  "excel.day_total": "Daily total",
  "excel.day_example": "Example day — {label}",

  // Monthly overview sheet
  "excel.year": "Year",
  "excel.monthly_values": "Monthly values",

  // Summary sheet
  "excel.investment_total": "Total investment",
  "excel.baseline_cost": "Baseline grid cost (no PV)",
  "excel.baseline_cost_note": "Cost if all consumption came from the grid",
  "excel.net_balance_short": "Net balance",
  "excel.net_balance_short_note": "Export − Import",
  "excel.annual_savings": "Annual savings",
  "excel.annual_savings_note": "Baseline cost + net balance",
  "excel.payback": "Payback period",
  "excel.payback_formula": "Investment / annual savings",
  "excel.eff_price_total": "Effective electricity price (total)",
  "excel.npv": "Net present value (NPV)",
  "excel.irr": "Internal rate of return (IRR)",
  "excel.lcoe": "Levelised cost of electricity (LCOE)",

  // Overview sheet descriptions
  "excel.desc_pv": "Power × specific yield, monthly distribution",
  "excel.desc_consumers": "Consumption, PV coverage, effective price",
  "excel.desc_heating": "Heat pump vs. heating oil vs. natural gas",
  "excel.desc_car": "EV vs. diesel",
  "excel.desc_aggregate": "Energy and cost balance",
  "excel.desc_overview": "Production, import, export & all consumers in one overview",
  "excel.desc_example_days": "Hourly daily profiles (Jan, Mar, Jul) with consumers, avg. price & grid fee",
  "excel.desc_monthly": "Full year, one row per month: consumption, self-consumption, prices, net",

  // Consumer sheet titles
  "excel.household_title": "Household (H0 load profile)",
  "excel.heatpump_title": "Heat pump (heating)",
  "excel.ev_title": "EV (charging)",
  "excel.bwwp_title": "Domestic hot water heat pump",

  // Wizard
  "wizard.title": "PV scenario builder & advisor",
  "wizard.subtitle": "What-if? — Sliders on the left, smart energy advisor on the right. Both control the same scenario.",
  "wizard.monthly_title": "Energy flow per month",
  "wizard.monthly_hint": "Click a month to see the hourly detail view (incl. battery SoC).",
  "wizard.hourly_title": "Hourly detail",
  "wizard.scenario_title": "Scenario comparison — Net balance",
  "wizard.scenario_hint": "Net = export revenue − import cost for different feed-in & import tariffs.",
  "wizard.alternatives_title": "Alternatives compared",
  "wizard.alternatives_hint": "What the same heat output (heat pump) with heating oil/natural gas and the same car (EV) with diesel would cost.",
  "wizard.open_full": "🔗 Open in full calculator",
  "wizard.copy_link": "📋 Copy permalink",
  "wizard.copied": "copied!",
  "wizard.advisor_title": "Energy advisor",

  // Wizard presets
  "wizard.pv_none": "No PV",
  "wizard.pv_none_sub": "Baseline",
  "wizard.pv_balkon": "Balcony PV",
  "wizard.pv_balkon_sub": "800 Wp · South",
  "wizard.pv_10kw": "10 kWp",
  "wizard.pv_10kw_sub": "South · 35°",
  "wizard.pv_20kw": "20 kWp",
  "wizard.pv_20kw_sub": "East/West · 35°",
  "wizard.battery_none": "No battery",
  "wizard.battery_none_sub": "simple",
  "wizard.battery_with": "With battery",
  "wizard.battery_with_sub": "more self-consumption",

  // Wizard steps
  "wizard.step_household": "Household & electricity price",
  "wizard.step_household_desc": "Number of persons sets the standard load profile (1 → 1,500 … 2 → 2,500 kWh).",
  "wizard.step_persons": "Persons in household",
  "wizard.step_consumption": "Annual household consumption",
  "wizard.step_price": "Electricity price",
  "wizard.step_location": "Location",
  "wizard.step_consumers": "Additional consumers",
  "wizard.step_consumers_desc": "Optional — increases self-consumption.",
  "wizard.step_pv": "Choose PV system",
  "wizard.step_pv_desc": "From balcony PV to full roof.",
  "wizard.step_battery": "Battery",
  "wizard.step_battery_desc": "Increases self-consumption.",

  // Wizard toggles
  "wizard.heatpump_label": "Heat pump",
  "wizard.heatpump_sub": "~5,000 kWh/yr",
  "wizard.ev_label": "EV",
  "wizard.ev_sub": "~2,000 kWh/yr (80% PV)",
  "wizard.bwwp_label": "DHW heat pump",
  "wizard.bwwp_sub": "~400 kWh/yr",

  // Wizard summary
  "wizard.sum_pv_yield": "PV yield",
  "wizard.sum_self_use": "Self-consumption",
  "wizard.sum_grid_import": "Grid import",
  "wizard.sum_netto": "Net (Export−Import)",
  "wizard.sum_savings": "Savings vs. baseline",
  "wizard.sum_amortisation": "Payback",
  "wizard.sum_eff_price": "Eff. price",
  "wizard.sum_per_year": "per year",
  "wizard.sum_self_pv": "of PV",
  "wizard.sum_weighted": "weighted avg.",

  // Wizard recommendation
  "wizard.rec_baseline": "Starting point: your pure grid costs.",
  "wizard.rec_with": "with",
  "wizard.rec_without": "without",
  "wizard.rec_battery": "battery.",

  // Wizard hourly
  "wizard.hourly_detail": "Hourly detail —",

  // Chat UI
  "chat.placeholder": "Ask me about the energy transition …",
  "chat.send": "Send",
  "chat.error": "Sorry, something went wrong.",

  // Chat advisor
  "advisor.years": "years",
  "advisor.summary": "Summary –",
  "advisor.consumer_at": "Consumer @",
  "advisor.location": "Location ",
  "advisor.pv_yield": "PV yield",
  "advisor.self_consumption": "Self-consumption",
  "advisor.netto": "Net",
  "advisor.savings": "Savings",
  "advisor.amortisation": "Payback",
  "advisor.eff_price": "eff. price",
  "advisor.full_details": "Full details & charts in calculator:",
  "advisor.accepted": "Applied:",
  "advisor.result": "Result",
  "advisor.with_battery": "with battery",
  "advisor.without_battery": "without battery",
  "advisor.netto_label": "Net (Export − Import):",
  "advisor.savings_label": "Savings vs. baseline:",
  "advisor.price_change": "Electricity price →",
  "advisor.location_change": "Location →",
  "advisor.pv_none": "PV → No PV (baseline)",
  "advisor.battery_off": "Battery → off",
  "advisor.battery_on": "Battery →",
  "advisor.investment_change": "Investment →",
  "advisor.heatpump_on": "Heat pump → on",
  "advisor.ev_on": "EV → on",
  "advisor.bwwp_on": "DHW HP → on",
  "advisor.consumption_change": "Annual consumption →",

  // Chat welcome
  "advisor.welcome": "Hi! I'll adjust your PV scenario directly when you tell me something — no questions asked. Examples: \"electricity price 24 ct\", \"heat pump 3000\", \"10 kWp with battery\", \"different location Hamburg\".",
  "advisor.current": "Current:",

  // Chat clarify
  "advisor.clarify": "I didn't detect a change. Tell me what to adjust, e.g.:",
  "advisor.clarify_price": "Electricity price (\"24 ct\")",
  "advisor.clarify_location": "Location (\"Hamburg\")",
  "advisor.clarify_pv": "PV (\"balcony PV\", \"10 kWp\", \"20 kWp\")",
  "advisor.clarify_battery": "Battery (\"with/without battery\")",
  "advisor.clarify_consumers": "Consumers (\"heat pump 3000\", \"EV\", \"DHW HP\").",

  // UI
  "ui.sidebar_toggle": "⚙️ Inputs",
  "ui.sidebar_toggle_title": "Show/hide inputs",
  "ui.title": "PV revenue calculator",
  "ui.subtitle": "Direct marketing with battery — simulation of PV production, storage shifting and spot market revenue.",
  "ui.excel_button": "📊 Excel export (.xlsx)",
  "ui.excel_button_title": "Download Excel file with all calculations and formulas",
  "ui.excel_loading": "⏳ Generating…",
  "ui.excel_error": "Excel export failed. See console for details.",
};

const catalogs: Record<Locale, Messages> = { de, en };

/**
 * Look up a translated message by key.  Falls back to the key itself
 * if no translation is found, and to the German version as a last resort.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let msg = catalogs[currentLocale]?.[key]
    ?? catalogs.de[key]
    ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return msg;
}

/** Convenience: return the month-abbreviation keys in order. */
export function monthKeys(): string[] {
  return ["month.jan", "month.feb", "month.mar", "month.apr", "month.may", "month.jun",
    "month.jul", "month.aug", "month.sep", "month.oct", "month.nov", "month.dec"];
}

/** Convenience: return translated month abbreviations. */
export function monthAbbrevs(): string[] {
  return monthKeys().map((k) => t(k));
}

/** Convenience: return translated month full names. */
export function monthFullNames(): string[] {
  return [
    t("month.january"), t("month.february"), t("month.march"), t("month.april"),
    t("month.may_full"), t("month.june"), t("month.july"), t("month.august"),
    t("month.september"), t("month.october"), t("month.november"), t("month.december"),
  ];
}

/**
 * Return a locale-appropriate number formatter.
 * DE → "1.234,5", EN → "1,234.5"
 */
export function fmtNumber(v: number, decimals = 0): string {
  const locale = currentLocale === "de" ? "de-DE" : "en-GB";
  return v.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Return locale-appropriate EUR formatter. */
export function fmtEUR(v: number): string {
  return `${fmtNumber(v)} €`;
}

/** Return locale-appropriate kWh formatter. */
export function fmtKWh(v: number): string {
  return v >= 100 ? fmtNumber(Math.round(v)) : v.toFixed(1);
}
