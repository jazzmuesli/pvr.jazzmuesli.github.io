// Client-side Excel (.xlsx) export of the whole simulation, with **live
// formulas** so the user can trace every number back to its inputs.
//
// Design principle: every derived value is written as a real spreadsheet
// *formula* that references input cells (e.g. `=B7*B8/100`), never a
// pre-computed constant. Opening the file in Excel / LibreOffice / Google
// Sheets recomputes the whole model, and the user can change any *input* cell
// and immediately see the effect ripple through. The companion test
// (`tests/excel_export.test.ts`) evaluates the same formulas with
// HyperFormula and asserts they reproduce the `SimReport` numbers.
//
// Layout follows the conventions used by well-known German "Berechnungstools"
// (e.g. der-fachwerker-saniert.de): a titled header block, a colour legend,
// clearly separated **Eingaben** (editable, yellow) and **Berechnung**
// (calculated, grey) blocks, units in their own column, right-aligned numbers
// with thousands separators, and a highlighted bottom-line result row. Frozen
// header rows keep the context visible while scrolling.
//
// The workbook is produced from a `SimReport` and is environment-agnostic:
// `buildWorkbook` returns an ExcelJS `Workbook`; `workbookToBuffer` and
// `downloadWorkbook` are thin helpers for Node (tests) and the browser
// respectively.

import ExcelJS from "exceljs";
import type { SimReport } from "../calc/report";
import { averageNetzentgeltCt, cityForLocation } from "../calc/tariff";
import type { TariffScheme } from "../calc/tariff";

/** Round to 2 decimals (mirrors the calc modules' `round2`). */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Shared visual style tokens (the "design system" of the workbook).
// ---------------------------------------------------------------------------

const COLOR = {
  title: "FF1F4E78", // dark blue
  section: "FFDDEBF7", // light blue
  inputFill: "FFFFF2CC", // soft yellow — user inputs (as on the website)
  calibFill: "FFFCE4D6", // soft orange — calibration values from the 15-min simulation
  calcFill: "FFF2F2F2", // light grey — calculated
  resultFill: "FFE2EFDA", // soft green — bottom-line result
  headerFill: "FF1F4E78", // table header dark blue
  border: "FFBFBFBF",
} as const;

const NUM_FMT = "#,##0.##";
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: COLOR.border } },
  left: { style: "thin", color: { argb: COLOR.border } },
  bottom: { style: "thin", color: { argb: COLOR.border } },
  right: { style: "thin", color: { argb: COLOR.border } },
};

type CellKind = "input" | "calib" | "calc" | "result";

/** A labelled input row: `label | value | unit | note`. */
interface InputRow {
  key: string;
  label: string;
  value: number;
  unit?: string;
  note?: string;
}

/**
 * Builds a single, well-styled sheet: a title, a colour legend, a titled
 * "Eingaben" block (yellow, editable) and a "Berechnung" block (grey,
 * calculated), tracking the value-cell address of every named cell so
 * formulas can reference them by key.
 */
class SheetBuilder {
  private ws: ExcelJS.Worksheet;
  private row = 1;
  /** key -> "B<row>" address of the value column for that row. */
  readonly addr: Record<string, string> = {};

  constructor(wb: ExcelJS.Workbook, name: string) {
    this.ws = wb.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 4 }],
    });
    this.ws.getColumn(1).width = 44; // label
    this.ws.getColumn(2).width = 16; // value
    this.ws.getColumn(3).width = 11; // unit
    this.ws.getColumn(4).width = 52; // note / formula explanation
  }

  /** Header block: bold title + a colour legend, then a blank separator. */
  header(text: string, subtitle?: string): void {
    const t = this.ws.getCell(this.row, 1);
    t.value = text;
    t.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.title } };
    this.ws.getCell(this.row, 2).fill = t.fill;
    this.ws.getCell(this.row, 3).fill = t.fill;
    this.ws.getCell(this.row, 4).fill = t.fill;
    this.row += 1;

    if (subtitle) {
      const st = this.ws.getCell(this.row, 1);
      st.value = subtitle;
      st.font = { italic: true, size: 10, color: { argb: "FF595959" } };
    }
    this.row += 1;

    // Colour legend so the user knows which cells are editable.
    const legend = this.ws.getCell(this.row, 1);
    legend.value = "Legende:";
    legend.font = { bold: true, size: 9 };
    const inCell = this.ws.getCell(this.row, 2);
    inCell.value = "Eingabe";
    inCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.inputFill } };
    inCell.font = { size: 9 };
    inCell.alignment = { horizontal: "center" };
    const calibCell = this.ws.getCell(this.row, 3);
    calibCell.value = "Kalibr.";
    calibCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calibFill } };
    calibCell.font = { size: 9 };
    calibCell.alignment = { horizontal: "center" };
    const noteCell = this.ws.getCell(this.row, 4);
    noteCell.value = "gelb = Ihre Eingabe · orange = aus 15-Min-Simulation (anpassbar) · grau = Formel · grün = Ergebnis";
    noteCell.font = { size: 9, italic: true, color: { argb: "FF595959" } };
    this.row += 1; // legend occupies row 4 (frozen split at 4)
  }

  /** A section band spanning the four columns. */
  section(text: string): void {
    this.row += 1; // spacer
    for (let c = 1; c <= 4; c++) {
      const cell = this.ws.getCell(this.row, c);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.section } };
      cell.border = { bottom: { style: "thin", color: { argb: COLOR.border } } };
    }
    const cell = this.ws.getCell(this.row, 1);
    cell.value = text;
    cell.font = { bold: true, size: 11, color: { argb: COLOR.title } };
    this.row += 1;
  }

  private styleValueCell(cell: ExcelJS.Cell, kind: CellKind): void {
    cell.numFmt = NUM_FMT;
    cell.alignment = { horizontal: "right" };
    cell.border = THIN_BORDER;
    const fill =
      kind === "input" ? COLOR.inputFill
      : kind === "calib" ? COLOR.calibFill
      : kind === "result" ? COLOR.resultFill
      : COLOR.calcFill;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    if (kind === "result") cell.font = { bold: true };
  }

  private styleLabel(cell: ExcelJS.Cell, kind: CellKind): void {
    if (kind === "result") cell.font = { bold: true };
  }

  /** Add raw, editable rows and record their addresses. `kind` = "input"
   *  (yellow, user value) or "calib" (orange, from the 15-min simulation). */
  input(rows: InputRow[], kind: "input" | "calib" = "input"): void {
    for (const r of rows) {
      const label = this.ws.getCell(this.row, 1);
      label.value = r.label;
      this.styleLabel(label, "input");
      const valueCell = this.ws.getCell(this.row, 2);
      valueCell.value = r.value;
      this.styleValueCell(valueCell, kind);
      if (r.unit) this.ws.getCell(this.row, 3).value = r.unit;
      if (r.note) {
        const n = this.ws.getCell(this.row, 4);
        n.value = r.note;
        n.font = { size: 9, italic: true, color: { argb: "FF595959" } };
      }
      this.addr[r.key] = `B${this.row}`;
      this.row += 1;
    }
  }

  /** Convenience: calibration inputs (orange) sourced from the simulation. */
  calib(rows: InputRow[]): void {
    this.input(rows, "calib");
  }

  /**
   * Add a formula row. `key` records the result cell address; `result` is the
   * pre-computed value embedded so the file is valid before recomputation.
   * `kind` = "result" highlights bottom-line figures in green.
   */
  formula(
    key: string,
    label: string,
    formula: string,
    result: number | string,
    unit?: string,
    note?: string,
    kind: "calc" | "result" = "calc",
  ): void {
    const labelCell = this.ws.getCell(this.row, 1);
    labelCell.value = label;
    this.styleLabel(labelCell, kind);
    const cell = this.ws.getCell(this.row, 2);
    cell.value = { formula: formula.replace(/^=+/, ""), result } as ExcelJS.CellFormulaValue;
    this.styleValueCell(cell, kind);
    if (unit) this.ws.getCell(this.row, 3).value = unit;
    if (note) {
      const n = this.ws.getCell(this.row, 4);
      n.value = note;
      n.font = { size: 9, italic: true, color: { argb: "FF595959" } };
    }
    this.addr[key] = `B${this.row}`;
    this.row += 1;
  }

  /** A plain informational text row (label + optional right-hand note). */
  text(label: string, note?: string): void {
    this.ws.getCell(this.row, 1).value = label;
    if (note) {
      const n = this.ws.getCell(this.row, 4);
      n.value = note;
      n.font = { size: 9, italic: true, color: { argb: "FF595959" } };
    }
    this.row += 1;
  }

  /** Expose the underlying worksheet and the current row for table blocks. */
  get worksheet(): ExcelJS.Worksheet {
    return this.ws;
  }
  get currentRow(): number {
    return this.row;
  }
  set currentRow(v: number) {
    this.row = v;
  }
}

// ---------------------------------------------------------------------------
// Sheet builders
// ---------------------------------------------------------------------------

function buildPvSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const s = new SheetBuilder(wb, "PV-Produktion");
  s.header("PV-Produktion", "Ihre Anlagengröße bestimmt den Ertrag; der spezifische Ertrag kommt aus der Simulation.");

  const annualPV = report.summary.totalPVKWh;
  const specificYield = report.inputs.peakKWp > 0 ? annualPV / report.inputs.peakKWp : 0;

  s.section("Eingaben (wie auf der Webseite)");
  s.input([
    { key: "kwp", label: "PV-Spitzenleistung", value: report.inputs.peakKWp, unit: "kWp" },
    { key: "tilt", label: "Neigung", value: report.inputs.tiltDeg, unit: "°" },
  ]);
  s.text("Ausrichtung", report.inputs.orientation);
  s.text("Standort", report.inputs.location);

  s.section("Kalibrierung (aus 15-Minuten-Simulation)");
  s.calib([
    {
      key: "specificYield",
      label: "Spezifischer Ertrag",
      value: r2(specificYield),
      unit: "kWh/kWp",
      note: "aus Solarmodell (Standort, Neigung, Ausrichtung); hier anpassbar",
    },
  ]);

  s.section("Berechnung");
  s.formula(
    "pvYear",
    "PV-Ertrag pro Jahr",
    `=${s.addr.kwp}*${s.addr.specificYield}`,
    r2(annualPV),
    "kWh",
    "Leistung × spezifischer Ertrag",
    "result",
  );

  // Monthly breakdown: a yellow monthly-share column (%) that the user can
  // edit; each month's kWh is derived = annual × share. The shares come from
  // the simulation's monthly split and sum to 100 %.
  s.section("Monatliche Verteilung (Anteil in % — editierbar)");
  const ws = s.worksheet;
  let rowIdx = s.currentRow;
  ["Monat", "Anteil %", "→ kWh"].forEach((h, i) => {
    const c = ws.getCell(rowIdx, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerFill } };
    c.border = THIN_BORDER;
  });
  rowIdx += 1;
  const pvYearAddr = s.addr.pvYear;
  const firstShareRow = rowIdx;
  for (const m of report.monthly) {
    const sharePct = annualPV > 0 ? (m.pvKWh / annualPV) * 100 : 0;
    const lc = ws.getCell(rowIdx, 1);
    lc.value = m.label;
    lc.border = THIN_BORDER;
    const sc = ws.getCell(rowIdx, 2);
    sc.value = r2(sharePct);
    sc.numFmt = NUM_FMT;
    sc.alignment = { horizontal: "right" };
    sc.border = THIN_BORDER;
    sc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.inputFill } };
    const kc = ws.getCell(rowIdx, 3);
    kc.value = { formula: `${pvYearAddr}*B${rowIdx}/100`, result: r2(m.pvKWh) } as ExcelJS.CellFormulaValue;
    kc.numFmt = NUM_FMT;
    kc.alignment = { horizontal: "right" };
    kc.border = THIN_BORDER;
    kc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
    rowIdx += 1;
  }
  const lastShareRow = rowIdx - 1;
  const chkLabel = ws.getCell(rowIdx, 1);
  chkLabel.value = "Summe (Kontrolle)";
  chkLabel.font = { bold: true };
  chkLabel.border = THIN_BORDER;
  const shareSum = ws.getCell(rowIdx, 2);
  shareSum.value = { formula: `SUM(B${firstShareRow}:B${lastShareRow})`, result: 100 } as ExcelJS.CellFormulaValue;
  shareSum.numFmt = NUM_FMT;
  shareSum.alignment = { horizontal: "right" };
  shareSum.font = { bold: true };
  shareSum.border = THIN_BORDER;
  const kwhSum = ws.getCell(rowIdx, 3);
  kwhSum.value = { formula: `SUM(C${firstShareRow}:C${lastShareRow})`, result: r2(annualPV) } as ExcelJS.CellFormulaValue;
  kwhSum.numFmt = NUM_FMT;
  kwhSum.alignment = { horizontal: "right" };
  kwhSum.font = { bold: true };
  kwhSum.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.resultFill } };
  kwhSum.border = THIN_BORDER;
  s.currentRow = rowIdx + 1;
}

function buildConsumerSheet(
  wb: ExcelJS.Workbook,
  report: SimReport,
  key: "household" | "heatpump" | "bwwp" | "ev",
  sheetName: string,
  title: string,
): void {
  const s = new SheetBuilder(wb, sheetName);
  const cons = report.inputs.consumers[key];
  const cov = report.effectivePrice.coverage[key];
  const effCt = report.effectivePrice.byConsumer[key] ?? 0;

  s.header(title, "Verbrauch und Tarif sind Ihre Eingaben; die PV-Deckung stammt aus der Simulation.");
  s.section("Eingaben (wie auf der Webseite)");
  s.input([
    { key: "annualKWh", label: "Jahresverbrauch", value: r2(cons?.annualKWh ?? 0), unit: "kWh", note: "eingestellter Verbrauch dieses Verbrauchers" },
    { key: "gridPriceCt", label: "Netzpreis (Grid)", value: r2(cov?.gridPriceCt ?? 0), unit: "ct/kWh", note: report.inputs.importScheme === "fixed" ? "Ihr fester Tarif" : "Ø dynamischer Preis der Bezugsstunden" },
  ]);

  s.section("Kalibrierung (aus 15-Minuten-Simulation)");
  const covPct = cov?.pvSharePct ?? 0;
  s.calib([
    { key: "pvCovPct", label: "PV+Speicher-Deckung", value: r2(covPct), unit: "%", note: "Anteil des Verbrauchs aus eigener Sonne (Batterie-Dispatch)" },
  ]);

  s.section("Berechnung");
  s.formula(
    "pvCovered",
    "davon aus PV+Speicher gedeckt",
    `=${s.addr.annualKWh}*${s.addr.pvCovPct}/100`,
    r2(cov?.pvCoveredKWh ?? 0),
    "kWh",
    "Verbrauch × PV-Deckung%",
  );
  s.formula(
    "gridKWh",
    "Netzbezug",
    `=${s.addr.annualKWh}-${s.addr.pvCovered}`,
    r2(cov?.gridKWh ?? Math.max(0, (cons?.annualKWh ?? 0) - (cov?.pvCoveredKWh ?? 0))),
    "kWh",
    "Verbrauch − PV-gedeckt",
  );
  s.formula(
    "gridCost",
    "Netzkosten",
    `=${s.addr.gridKWh}*${s.addr.gridPriceCt}/100`,
    r2(((cov?.gridKWh ?? 0) * (cov?.gridPriceCt ?? 0)) / 100),
    "€",
    "Netzbezug × Netzpreis (PV = 0 ct/kWh)",
  );
  s.formula(
    "effectiveCt",
    "Effektiver Strompreis",
    `=IF(${s.addr.annualKWh}=0,0,${s.addr.gridCost}/${s.addr.annualKWh}*100)`,
    r2(effCt),
    "ct/kWh",
    "Netzkosten / Verbrauch (Eigenverbrauch gratis)",
    "result",
  );
}

function buildHeatingSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const h = report.opportunityCosts.heating;
  const s = new SheetBuilder(wb, "Heizung");
  s.header(
    "Heizkostenvergleich — Wärmepumpe vs. Heizöl vs. Erdgas",
    "Gleiche Nutzwärme für alle drei Optionen; alle Kosten als nachvollziehbare Formeln.",
  );

  s.section("Eingaben (wie auf der Webseite)");
  s.input([
    { key: "hpElec", label: "Wärmepumpe: Strombedarf", value: r2(h.heatpumpElectricKWh), unit: "kWh", note: "= Verbrauch des WP-Verbrauchers" },
    { key: "jaz", label: "Jahresarbeitszahl (JAZ)", value: h.jaz, unit: "", note: "Nutzwärme je kWh Strom" },
    { key: "oilEurPer100L", label: "Heizöl-Preis", value: 130, unit: "€/100L", note: "Standardannahme" },
    { key: "oilKWhPerL", label: "Heizöl Heizwert", value: 10, unit: "kWh/L" },
    { key: "oilEff", label: "Ölkessel-Wirkungsgrad", value: 0.85, unit: "" },
    { key: "oilSweep", label: "Schornsteinfeger (Öl)", value: r2(h.oil.chimneySweepEUR), unit: "€/Jahr" },
    { key: "gasCt", label: "Gaspreis", value: 11, unit: "ct/kWh" },
    { key: "gasEff", label: "Gaskessel-Wirkungsgrad", value: 0.92, unit: "" },
    { key: "gasGridFeeCt", label: "Gas-Netzentgelt", value: 2.0, unit: "ct/kWh" },
    { key: "gasNeben", label: "Gas-Nebenkosten (Grundgebühr)", value: r2(h.gas.otherNebenkostenEUR), unit: "€/Jahr" },
    { key: "gasSweep", label: "Schornsteinfeger (Gas)", value: r2(h.gas.chimneySweepEUR), unit: "€/Jahr" },
  ]);

  s.section("Kalibrierung (aus 15-Minuten-Simulation)");
  s.calib([
    {
      key: "hpCt",
      label: "WP-Strompreis (effektiv)",
      value: r2((h.heatpump.energyCostEUR / Math.max(h.heatpumpElectricKWh, 1e-9)) * 100),
      unit: "ct/kWh",
      note: "PV-bewusster Effektivpreis der WP-Importe (Netz + gratis PV)",
    },
  ]);

  s.section("Nutzwärme-Berechnung");
  s.formula("usefulHeat", "Nutzwärme", `=${s.addr.hpElec}*${s.addr.jaz}`, r2(h.usefulHeatKWh), "kWh", "Strombedarf × JAZ");

  s.section("Wärmepumpe");
  s.formula("hpTotal", "Wärmepumpe: Gesamtkosten", `=${s.addr.hpElec}*${s.addr.hpCt}/100`, r2(h.heatpump.totalEUR), "€/Jahr", "Strombedarf × Strompreis", "result");

  s.section("Heizöl");
  s.formula("oilPrimary", "Öl-Energiebedarf", `=${s.addr.usefulHeat}/${s.addr.oilEff}`, r2(h.oil.primaryEnergyKWh), "kWh", "Nutzwärme / Wirkungsgrad");
  s.formula("oilLitres", "Öl-Menge", `=${s.addr.oilPrimary}/${s.addr.oilKWhPerL}`, r2(h.oil.primaryEnergyKWh / 10), "L", "Energiebedarf / Heizwert");
  s.formula("oilEnergyCost", "Öl-Energiekosten", `=${s.addr.oilLitres}*${s.addr.oilEurPer100L}/100`, r2(h.oil.energyCostEUR), "€", "Menge × Preis/100L");
  s.formula("oilTotal", "Heizöl: Gesamtkosten", `=${s.addr.oilEnergyCost}+${s.addr.oilSweep}`, r2(h.oil.totalEUR), "€/Jahr", "Energie + Schornsteinfeger", "result");
  s.formula("oilDelta", "Mehrkosten ggü. Wärmepumpe", `=${s.addr.oilTotal}-${s.addr.hpTotal}`, r2(h.oil.deltaVsHeatpumpEUR), "€/Jahr");

  s.section("Erdgas");
  s.formula("gasPrimary", "Gas-Energiebedarf", `=${s.addr.usefulHeat}/${s.addr.gasEff}`, r2(h.gas.primaryEnergyKWh), "kWh", "Nutzwärme / Wirkungsgrad");
  s.formula("gasEnergyCost", "Gas-Energiekosten", `=${s.addr.gasPrimary}*${s.addr.gasCt}/100`, r2(h.gas.energyCostEUR), "€", "Energiebedarf × Preis");
  s.formula("gasGridFee", "Gas-Netzentgelt", `=${s.addr.gasPrimary}*${s.addr.gasGridFeeCt}/100`, r2(h.gas.gridFeeEUR), "€", "Energiebedarf × Netzentgelt");
  s.formula("gasTotal", "Erdgas: Gesamtkosten", `=${s.addr.gasEnergyCost}+${s.addr.gasGridFee}+${s.addr.gasNeben}+${s.addr.gasSweep}`, r2(h.gas.totalEUR), "€/Jahr", "Energie + Netz + Nebenk. + Schornsteinfeger", "result");
  s.formula("gasDelta", "Mehrkosten ggü. Wärmepumpe", `=${s.addr.gasTotal}-${s.addr.hpTotal}`, r2(h.gas.deltaVsHeatpumpEUR), "€/Jahr");
}

function buildCarSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const c = report.opportunityCosts.car;
  const s = new SheetBuilder(wb, "Auto");
  s.header(
    "Fahrkostenvergleich — E-Auto vs. Diesel",
    "Gleiche Jahresfahrleistung; alle Kosten als nachvollziehbare Formeln.",
  );

  s.section("Eingaben (wie auf der Webseite)");
  s.input([
    { key: "km", label: "Jahresfahrleistung", value: r2(c.annualKm), unit: "km" },
    { key: "evKwh100", label: "E-Auto Verbrauch", value: r2((c.ev.primaryEnergy / Math.max(c.annualKm, 1e-9)) * 100), unit: "kWh/100km" },
    { key: "evMaintCt", label: "E-Auto Wartung", value: r2((c.ev.maintenanceEUR / Math.max(c.annualKm, 1e-9)) * 100), unit: "ct/km" },
    { key: "evTax", label: "E-Auto Kfz-Steuer", value: r2(c.ev.vehicleTaxEUR), unit: "€/Jahr" },
    { key: "evOther", label: "E-Auto Versicherung + TÜV", value: r2(c.ev.otherNebenkostenEUR), unit: "€/Jahr" },
    { key: "dieselL100", label: "Diesel Verbrauch", value: r2((c.diesel.primaryEnergy / Math.max(c.annualKm, 1e-9)) * 100), unit: "L/100km" },
    { key: "dieselEurL", label: "Diesel-Preis", value: r2(c.diesel.energyCostEUR / Math.max(c.diesel.primaryEnergy, 1e-9)), unit: "€/L" },
    { key: "dieselMaintCt", label: "Diesel Wartung", value: r2((c.diesel.maintenanceEUR / Math.max(c.annualKm, 1e-9)) * 100), unit: "ct/km" },
    { key: "dieselTax", label: "Diesel Kfz-Steuer", value: r2(c.diesel.vehicleTaxEUR), unit: "€/Jahr" },
    { key: "dieselOther", label: "Diesel Versicherung + TÜV", value: r2(c.diesel.otherNebenkostenEUR), unit: "€/Jahr" },
  ]);

  s.section("Kalibrierung (aus 15-Minuten-Simulation)");
  s.calib([
    { key: "evCt", label: "E-Auto Strompreis (effektiv)", value: r2((c.ev.energyCostEUR / Math.max(c.ev.primaryEnergy, 1e-9)) * 100), unit: "ct/kWh", note: "PV-bewusster Effektivpreis des Ladestroms (Nachtladen + PV)" },
  ]);

  s.section("E-Auto");
  s.formula("evEnergy", "E-Auto: Energiebedarf", `=${s.addr.km}/100*${s.addr.evKwh100}`, r2(c.ev.primaryEnergy), "kWh", "km/100 × Verbrauch");
  s.formula("evEnergyCost", "E-Auto: Energiekosten", `=${s.addr.evEnergy}*${s.addr.evCt}/100`, r2(c.ev.energyCostEUR), "€");
  s.formula("evMaint", "E-Auto: Wartung", `=${s.addr.km}*${s.addr.evMaintCt}/100`, r2(c.ev.maintenanceEUR), "€");
  s.formula("evTotal", "E-Auto: Gesamtkosten", `=${s.addr.evEnergyCost}+${s.addr.evMaint}+${s.addr.evTax}+${s.addr.evOther}`, r2(c.ev.totalEUR), "€/Jahr", "Energie + Wartung + Steuer + Nebenk.", "result");

  s.section("Diesel");
  s.formula("dieselLitres", "Diesel: Kraftstoffmenge", `=${s.addr.km}/100*${s.addr.dieselL100}`, r2(c.diesel.primaryEnergy), "L", "km/100 × Verbrauch");
  s.formula("dieselEnergyCost", "Diesel: Kraftstoffkosten", `=${s.addr.dieselLitres}*${s.addr.dieselEurL}`, r2(c.diesel.energyCostEUR), "€");
  s.formula("dieselMaint", "Diesel: Wartung", `=${s.addr.km}*${s.addr.dieselMaintCt}/100`, r2(c.diesel.maintenanceEUR), "€");
  s.formula("dieselTotal", "Diesel: Gesamtkosten", `=${s.addr.dieselEnergyCost}+${s.addr.dieselMaint}+${s.addr.dieselTax}+${s.addr.dieselOther}`, r2(c.diesel.totalEUR), "€/Jahr", "Kraftstoff + Wartung + Steuer + Nebenk.", "result");
  s.formula("dieselDelta", "Mehrkosten ggü. E-Auto", `=${s.addr.dieselTotal}-${s.addr.evTotal}`, r2(c.diesel.deltaVsEvEUR), "€/Jahr");
}

function buildAggregateSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const s = new SheetBuilder(wb, "Aggregat");
  const sum = report.summary;
  s.header("Aggregierte Energie- und Kostenbilanz", "Verbrauch ist Ihre Eingabe; Energieflüsse & Erlöse stammen aus der Simulation.");

  s.section("Eingaben (wie auf der Webseite)");
  s.input([
    { key: "load", label: "Gesamtverbrauch", value: r2(sum.totalLoadKWh), unit: "kWh", note: "Summe aller Verbraucher" },
  ]);

  s.section("Kalibrierung (aus 15-Minuten-Simulation)");
  s.calib([
    { key: "pvYear", label: "PV-Ertrag", value: r2(sum.totalPVKWh), unit: "kWh" },
    { key: "selfCons", label: "Eigenverbrauch", value: r2(sum.selfConsumptionKWh), unit: "kWh", note: "PV+Speicher, der die Last deckt" },
    { key: "export", label: "Netz-Einspeisung", value: r2(sum.totalExportKWh), unit: "kWh" },
    { key: "exportRev", label: "Export-Erlös", value: r2(sum.exportRevenueEUR), unit: "€" },
    { key: "importCost", label: "Import-Kosten", value: r2(sum.importCostEUR), unit: "€" },
  ]);

  s.section("Berechnung");
  s.formula("importKWh", "Netz-Import", `=${s.addr.load}-${s.addr.selfCons}`, r2(sum.totalImportKWh), "kWh", "Verbrauch − Eigenverbrauch");
  s.formula("selfConsRate", "Eigenverbrauchsquote", `=IF(${s.addr.pvYear}=0,0,${s.addr.selfCons}/${s.addr.pvYear}*100)`, r2(sum.selfConsumptionRatePct), "%", "Eigenverbrauch / PV-Ertrag");
  s.formula("selfSuff", "Autarkiegrad", `=IF(${s.addr.load}=0,0,${s.addr.selfCons}/${s.addr.load}*100)`, r2(sum.selfSufficiencyPct), "%", "Eigenverbrauch / Verbrauch");
  s.formula("netEUR", "Netto-Bilanz", `=${s.addr.exportRev}-${s.addr.importCost}`, r2(sum.netSelectedEUR), "€", "Export-Erlös − Import-Kosten", "result");
}

/**
 * "Gesamtkalkulation" — a single overview sheet that puts the whole energy and
 * cost balance in one place, per the user's request: PV production, grid import,
 * grid export, and every active consumer (household, heat pump, hot-water heat
 * pump, EV). Each consumer's consumption is a yellow input; its PV+battery
 * coverage share is an orange calibration cell from the 15-min simulation; the
 * PV-covered and grid kWh are live formulas, and the column totals are `SUM`s
 * so the parts provably add up to the whole.
 */
function buildGesamtSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const s = new SheetBuilder(wb, "Gesamtkalkulation");
  const sum = report.summary;
  const cov = report.effectivePrice.coverage;
  s.header(
    "Gesamtkalkulation",
    "Produktion, Import, Export und alle Verbraucher (Haushalt, WP, BWWP, E-Auto) in einer Übersicht.",
  );

  // --- Consumer table: label | consumption (input) | PV-share % (calib) |
  //     PV-covered kWh (formula) | grid kWh (formula) | eff. price (formula) ---
  s.section("Verbraucher (Verbrauch = Eingabe · PV-Anteil = aus Simulation)");
  const ws = s.worksheet;
  // Give the extra data columns sensible widths.
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 16;

  let rowIdx = s.currentRow;
  const headers = ["Verbraucher", "Verbrauch kWh", "PV-Anteil %", "PV-gedeckt kWh", "Netzbezug kWh", "Eff. ct/kWh"];
  headers.forEach((h, i) => {
    const c = ws.getCell(rowIdx, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerFill } };
    c.border = THIN_BORDER;
  });
  rowIdx += 1;

  const consumerDefs: { key: "household" | "heatpump" | "bwwp" | "ev"; label: string }[] = [
    { key: "household", label: "Haushalt" },
    { key: "heatpump", label: "Wärmepumpe" },
    { key: "bwwp", label: "Brauchwasser-WP (BWWP)" },
    { key: "ev", label: "E-Auto" },
  ];
  const active = consumerDefs.filter((d) => report.inputs.consumers[d.key].enabled);
  const firstConsRow = rowIdx;
  for (const d of active) {
    const c = cov[d.key];
    const consumptionKWh = r2(c?.consumptionKWh ?? report.inputs.consumers[d.key].annualKWh ?? 0);
    const pvSharePct = r2(c?.pvSharePct ?? 0);
    const gridPriceCt = r2(c?.gridPriceCt ?? 0);

    // Col A: label
    const lc = ws.getCell(rowIdx, 1);
    lc.value = d.label;
    lc.border = THIN_BORDER;
    // Col B: consumption (yellow input)
    const bc = ws.getCell(rowIdx, 2);
    bc.value = consumptionKWh;
    bc.numFmt = NUM_FMT;
    bc.alignment = { horizontal: "right" };
    bc.border = THIN_BORDER;
    bc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.inputFill } };
    // Col C: PV share % (orange calibration)
    const cc = ws.getCell(rowIdx, 3);
    cc.value = pvSharePct;
    cc.numFmt = NUM_FMT;
    cc.alignment = { horizontal: "right" };
    cc.border = THIN_BORDER;
    cc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calibFill } };
    // Col D: PV-covered kWh = consumption × share/100 (formula)
    const dc = ws.getCell(rowIdx, 4);
    dc.value = { formula: `B${rowIdx}*C${rowIdx}/100`, result: r2(c?.pvCoveredKWh ?? 0) } as ExcelJS.CellFormulaValue;
    dc.numFmt = NUM_FMT;
    dc.alignment = { horizontal: "right" };
    dc.border = THIN_BORDER;
    dc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
    // Col E: grid kWh = consumption − PV-covered (formula)
    const ec = ws.getCell(rowIdx, 5);
    ec.value = { formula: `B${rowIdx}-D${rowIdx}`, result: r2(c?.gridKWh ?? 0) } as ExcelJS.CellFormulaValue;
    ec.numFmt = NUM_FMT;
    ec.alignment = { horizontal: "right" };
    ec.border = THIN_BORDER;
    ec.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
    // Col F: effective ct/kWh = grid kWh × grid price / consumption (formula).
    // The grid price sits in a helper cell in col G (kept out of the way but
    // still a real, editable input) so the effective-price formula is honest.
    const gpc = ws.getCell(rowIdx, 7);
    gpc.value = gridPriceCt;
    gpc.numFmt = NUM_FMT;
    gpc.alignment = { horizontal: "right" };
    gpc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.inputFill } };
    const fc = ws.getCell(rowIdx, 6);
    fc.value = {
      formula: `IF(B${rowIdx}=0,0,E${rowIdx}*G${rowIdx}/B${rowIdx})`,
      result: r2(c?.effectiveCt ?? 0),
    } as ExcelJS.CellFormulaValue;
    fc.numFmt = NUM_FMT;
    fc.alignment = { horizontal: "right" };
    fc.border = THIN_BORDER;
    fc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
    rowIdx += 1;
  }
  const lastConsRow = rowIdx - 1;
  // Totals row: SUM of each numeric column.
  const tl = ws.getCell(rowIdx, 1);
  tl.value = "Summe Verbraucher";
  tl.font = { bold: true };
  tl.border = THIN_BORDER;
  for (const col of [2, 4, 5]) {
    const cell = ws.getCell(rowIdx, col);
    const colLetter = String.fromCharCode(64 + col);
    const fallback =
      col === 2 ? r2(sum.totalLoadKWh)
      : col === 4 ? r2(sum.selfConsumptionKWh)
      : r2(sum.totalImportKWh);
    cell.value = {
      formula: `SUM(${colLetter}${firstConsRow}:${colLetter}${lastConsRow})`,
      result: fallback,
    } as ExcelJS.CellFormulaValue;
    cell.numFmt = NUM_FMT;
    cell.alignment = { horizontal: "right" };
    cell.font = { bold: true };
    cell.border = THIN_BORDER;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.resultFill } };
  }
  // Remember the total-consumption cell for the energy-balance block below.
  const loadTotalAddr = `B${rowIdx}`;
  const selfTotalAddr = `D${rowIdx}`;
  const gridTotalAddr = `E${rowIdx}`;
  s.currentRow = rowIdx + 1;

  // --- Energy balance: PV production, self-consumption, export, import ---
  s.section("Energiebilanz (Produktion · Import · Export)");
  s.calib([
    { key: "pvYear", label: "PV-Produktion", value: r2(sum.totalPVKWh), unit: "kWh", note: "Jahresertrag der Anlage (aus Simulation)" },
    { key: "exportKWh", label: "Netz-Einspeisung (Export)", value: r2(sum.totalExportKWh), unit: "kWh" },
    { key: "exportRev", label: "Export-Erlös", value: r2(sum.exportRevenueEUR), unit: "€" },
    { key: "importCost", label: "Import-Kosten", value: r2(sum.importCostEUR), unit: "€" },
  ]);
  // Self-consumption and import tie back to the consumer-table totals.
  s.formula("selfCons", "Eigenverbrauch (PV+Speicher)", `=${selfTotalAddr}`, r2(sum.selfConsumptionKWh), "kWh", "Summe PV-gedeckt aller Verbraucher");
  s.formula("importKWh", "Netz-Import", `=${gridTotalAddr}`, r2(sum.totalImportKWh), "kWh", "Summe Netzbezug aller Verbraucher");
  s.formula("load", "Gesamtverbrauch", `=${loadTotalAddr}`, r2(sum.totalLoadKWh), "kWh", "Summe Verbrauch aller Verbraucher");

  s.section("Kennzahlen");
  s.formula("selfConsRate", "Eigenverbrauchsquote", `=IF(${s.addr.pvYear}=0,0,${s.addr.selfCons}/${s.addr.pvYear}*100)`, r2(sum.selfConsumptionRatePct), "%", "Eigenverbrauch / PV-Produktion");
  s.formula("selfSuff", "Autarkiegrad", `=IF(${s.addr.load}=0,0,${s.addr.selfCons}/${s.addr.load}*100)`, r2(sum.selfSufficiencyPct), "%", "Eigenverbrauch / Verbrauch");
  s.formula("netEUR", "Netto-Bilanz", `=${s.addr.exportRev}-${s.addr.importCost}`, r2(sum.netSelectedEUR), "€", "Export-Erlös − Import-Kosten", "result");
}

/**
 * The single "Beispieltage" sheet: for every requested month it lays out the
 * average 24-hour profile (from `report.daily[month-1]`) as an hourly table.
 *
 * Columns, left → right:
 *   Stunde | PV | Last gesamt | [Haushalt] [Wärmepumpe] [BWWP] [E-Auto] |
 *   Eigenverbrauch | Netzbezug | Einspeisung | Ø Strompreis | Ø Netzentgelt | SoC
 *
 * The per-consumer columns are only emitted for consumers that are enabled, per
 * the user's request. PV / load / self-use / export / SoC and the two price
 * columns are orange calibration values straight from the 15-min simulation;
 * the **grid import per hour is a live formula** `=MAX(0, Last − Eigenverbrauch)`
 * and a daily-totals row `SUM`s each kWh column so the day balances. The
 * Ø-Strompreis is the average import price for that hour/season (incl. all
 * levies), and Ø-Netzentgelt is the grid-fee component (time-varying under
 * § 14a) so the user can see *why* the price moves across the day.
 */
function buildExampleDaysSheet(
  wb: ExcelJS.Workbook,
  report: SimReport,
  sheetName: string,
  title: string,
  months: { monthIndex: number; label: string }[],
): void {
  const s = new SheetBuilder(wb, sheetName);
  s.header(
    title,
    "Durchschnittlicher Tagesverlauf (24 h) je Monat aus der 15-Min-Simulation. Netzbezug = Last − Eigenverbrauch; Ø-Preis & Ø-Netzentgelt = Mittel dieser Tages-/Jahreszeit.",
  );
  const ws = s.worksheet;

  // Which consumer columns to show (Haushalt always; the rest only if enabled).
  const consumerCols: { key: "household" | "heatpump" | "bwwp" | "ev"; label: string }[] = (
    [
      { key: "household", label: "Haushalt kWh" },
      { key: "heatpump", label: "Wärmepumpe kWh" },
      { key: "bwwp", label: "BWWP kWh" },
      { key: "ev", label: "E-Auto kWh" },
    ] as { key: "household" | "heatpump" | "bwwp" | "ev"; label: string }[]
  ).filter((c) => report.inputs.consumers[c.key].enabled);
  const headers: string[] = ["Stunde", "PV kWh", "Last kWh"];
  consumerCols.forEach((c) => headers.push(c.label));
  const idxSelf = headers.push("Eigenverbr. kWh"); // 1-based col of self-use
  const idxGrid = headers.push("Netzbezug kWh"); // grid import (formula)
  const idxExport = headers.push("Einspeisung kWh");
  const idxPrice = headers.push("Ø Strompreis ct/kWh");
  const idxNet = headers.push("Ø Netzentgelt ct/kWh");
  const idxSoc = headers.push("SoC kWh");
  const idxLoad = 3; // "Last kWh"
  const colLetter = (i: number) => String.fromCharCode(64 + i);

  // Widen columns: label wide, the rest uniform.
  ws.getColumn(1).width = 20;
  for (let c = 2; c <= headers.length; c++) ws.getColumn(c).width = 15;

  const city = cityForLocation(report.inputs.location);
  const scheme = report.inputs.importScheme as TariffScheme;

  for (const { monthIndex, label } of months) {
    const day = report.daily[monthIndex];
    s.section(`Beispieltag — ${label}`);
    let rowIdx = s.currentRow;
    headers.forEach((h, i) => {
      const c = ws.getCell(rowIdx, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerFill } };
      c.border = THIN_BORDER;
      c.alignment = { horizontal: "center", wrapText: true };
    });
    rowIdx += 1;

    const firstRow = rowIdx;
    for (const d of day) {
      // Col A: hour label
      const hc = ws.getCell(rowIdx, 1);
      hc.value = `${String(d.hour).padStart(2, "0")}:00`;
      hc.border = THIN_BORDER;

      // Calibration (orange) numeric cells keyed by their column index.
      const calib: Record<number, number> = {
        2: r2(d.pvKWh),
        [idxLoad]: r2(d.totalLoadKWh),
        [idxSelf]: r2(d.selfUseKWh),
        [idxExport]: r2(d.exportKWh),
        [idxPrice]: r2(d.avgPrice),
        [idxNet]: r2(averageNetzentgeltCt(scheme, city, monthIndex, d.hour)),
        [idxSoc]: r2(d.socKWh),
      };
      // Per-consumer columns come straight after "Last kWh" (col 3).
      consumerCols.forEach((c, i) => {
        calib[4 + i] = r2(d.load[c.key]);
      });
      for (const [colStr, val] of Object.entries(calib)) {
        const col = Number(colStr);
        const cell = ws.getCell(rowIdx, col);
        cell.value = val;
        cell.numFmt = NUM_FMT;
        cell.alignment = { horizontal: "right" };
        cell.border = THIN_BORDER;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calibFill } };
      }
      // Grid import = MAX(0, load − self-use) as a live formula (grey).
      const ec = ws.getCell(rowIdx, idxGrid);
      ec.value = {
        formula: `MAX(0,${colLetter(idxLoad)}${rowIdx}-${colLetter(idxSelf)}${rowIdx})`,
        result: r2(d.importKWh),
      } as ExcelJS.CellFormulaValue;
      ec.numFmt = NUM_FMT;
      ec.alignment = { horizontal: "right" };
      ec.border = THIN_BORDER;
      ec.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
      rowIdx += 1;
    }
    const lastRow = rowIdx - 1;

    // Daily totals row: SUM each kWh column (skip the two price columns, which
    // are averages, not sums — show the day-average there instead).
    const tl = ws.getCell(rowIdx, 1);
    tl.value = "Tagessumme";
    tl.font = { bold: true };
    tl.border = THIN_BORDER;
    const sumCols = [2, idxLoad, ...consumerCols.map((_, i) => 4 + i), idxSelf, idxGrid, idxExport];
    for (const col of sumCols) {
      const L = colLetter(col);
      const cell = ws.getCell(rowIdx, col);
      cell.value = { formula: `SUM(${L}${firstRow}:${L}${lastRow})`, result: 0 } as ExcelJS.CellFormulaValue;
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: "right" };
      cell.font = { bold: true };
      cell.border = THIN_BORDER;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.resultFill } };
    }
    // Day-average for the two price columns.
    for (const col of [idxPrice, idxNet]) {
      const L = colLetter(col);
      const cell = ws.getCell(rowIdx, col);
      cell.value = { formula: `AVERAGE(${L}${firstRow}:${L}${lastRow})`, result: 0 } as ExcelJS.CellFormulaValue;
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: "right" };
      cell.font = { bold: true, italic: true };
      cell.border = THIN_BORDER;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
    }
    s.currentRow = rowIdx + 1;
  }
}

/**
 * The "Monatsuebersicht" sheet: the whole year with **one row per month** and
 * the same figures as the example days, aggregated to the month:
 *
 *   Monat | PV | Verbrauch gesamt | [Haushalt] [WP] [BWWP] [E-Auto] |
 *   Eigenverbrauch | Netzbezug | Einspeisung | Ø Strompreis | Ø Netzentgelt | Netto €
 *
 * The per-consumer columns follow the same "only if enabled" rule. Monthly PV,
 * consumption (total + per consumer), self-consumption, export and the net
 * balance are orange calibration values from the simulation; the **grid import
 * is a live formula** `=Verbrauch − Eigenverbrauch`; the two price columns are
 * the month's average import price and grid fee. A "Jahr" totals row SUMs the
 * kWh / € columns and averages the two price columns.
 */
function buildMonthlySheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const s = new SheetBuilder(wb, "Monatsuebersicht");
  s.header(
    "Monatsübersicht — ganzes Jahr (eine Zeile = ein Monat)",
    "Produktion, Verbrauch je Verbraucher, Eigenverbrauch, Netzbezug/Einspeisung sowie Ø-Strompreis & Ø-Netzentgelt pro Monat. Netzbezug = Verbrauch − Eigenverbrauch.",
  );
  const ws = s.worksheet;

  const consumerCols: { key: "household" | "heatpump" | "bwwp" | "ev"; label: string }[] = (
    [
      { key: "household", label: "Haushalt kWh" },
      { key: "heatpump", label: "Wärmepumpe kWh" },
      { key: "bwwp", label: "BWWP kWh" },
      { key: "ev", label: "E-Auto kWh" },
    ] as { key: "household" | "heatpump" | "bwwp" | "ev"; label: string }[]
  ).filter((c) => report.inputs.consumers[c.key].enabled);
  const headers: string[] = ["Monat", "PV kWh", "Verbrauch kWh"];
  consumerCols.forEach((c) => headers.push(c.label));
  const idxSelf = headers.push("Eigenverbr. kWh");
  const idxGrid = headers.push("Netzbezug kWh");
  const idxExport = headers.push("Einspeisung kWh");
  const idxPrice = headers.push("Ø Strompreis ct/kWh");
  const idxNet = headers.push("Ø Netzentgelt ct/kWh");
  const idxNetto = headers.push("Netto €");
  const idxLoad = 3; // "Verbrauch kWh"
  const colLetter = (i: number) => String.fromCharCode(64 + i);

  ws.getColumn(1).width = 14;
  for (let c = 2; c <= headers.length; c++) ws.getColumn(c).width = 15;

  const city = cityForLocation(report.inputs.location);
  const scheme = report.inputs.importScheme as TariffScheme;

  s.section("Monatswerte");
  let rowIdx = s.currentRow;
  headers.forEach((h, i) => {
    const c = ws.getCell(rowIdx, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerFill } };
    c.border = THIN_BORDER;
    c.alignment = { horizontal: "center", wrapText: true };
  });
  rowIdx += 1;

  const firstRow = rowIdx;
  for (let m = 0; m < report.monthly.length; m++) {
    const mo = report.monthly[m];
    // Month-average import price = mean of the 24 hourly averages for that month.
    const day = report.daily[m];
    const avgPrice = day.length > 0 ? day.reduce((a, d) => a + d.avgPrice, 0) / day.length : 0;

    const lc = ws.getCell(rowIdx, 1);
    lc.value = mo.label;
    lc.border = THIN_BORDER;

    const calib: Record<number, number> = {
      2: r2(mo.pvKWh),
      [idxLoad]: r2(mo.totalLoadKWh),
      [idxSelf]: r2(mo.selfConsumptionKWh),
      [idxExport]: r2(mo.exportKWh),
      [idxPrice]: r2(avgPrice),
      [idxNet]: r2(averageNetzentgeltCt(scheme, city, m)),
      [idxNetto]: r2(mo.netEUR),
    };
    consumerCols.forEach((c, i) => {
      calib[4 + i] = r2(mo.load[c.key]);
    });
    for (const [colStr, val] of Object.entries(calib)) {
      const col = Number(colStr);
      const cell = ws.getCell(rowIdx, col);
      cell.value = val;
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: "right" };
      cell.border = THIN_BORDER;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calibFill } };
    }
    // Grid import = MAX(0, consumption − self-consumption) as a live formula.
    const ec = ws.getCell(rowIdx, idxGrid);
    ec.value = {
      formula: `MAX(0,${colLetter(idxLoad)}${rowIdx}-${colLetter(idxSelf)}${rowIdx})`,
      result: r2(mo.importKWh),
    } as ExcelJS.CellFormulaValue;
    ec.numFmt = NUM_FMT;
    ec.alignment = { horizontal: "right" };
    ec.border = THIN_BORDER;
    ec.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
    rowIdx += 1;
  }
  const lastRow = rowIdx - 1;

  // "Jahr" totals row: SUM the kWh / € columns, AVERAGE the two price columns.
  const tl = ws.getCell(rowIdx, 1);
  tl.value = "Jahr";
  tl.font = { bold: true };
  tl.border = THIN_BORDER;
  const sumCols = [2, idxLoad, ...consumerCols.map((_, i) => 4 + i), idxSelf, idxGrid, idxExport, idxNetto];
  for (const col of sumCols) {
    const L = colLetter(col);
    const cell = ws.getCell(rowIdx, col);
    cell.value = { formula: `SUM(${L}${firstRow}:${L}${lastRow})`, result: 0 } as ExcelJS.CellFormulaValue;
    cell.numFmt = NUM_FMT;
    cell.alignment = { horizontal: "right" };
    cell.font = { bold: true };
    cell.border = THIN_BORDER;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.resultFill } };
  }
  for (const col of [idxPrice, idxNet]) {
    const L = colLetter(col);
    const cell = ws.getCell(rowIdx, col);
    cell.value = { formula: `AVERAGE(${L}${firstRow}:${L}${lastRow})`, result: 0 } as ExcelJS.CellFormulaValue;
    cell.numFmt = NUM_FMT;
    cell.alignment = { horizontal: "right" };
    cell.font = { bold: true, italic: true };
    cell.border = THIN_BORDER;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calcFill } };
  }
  s.currentRow = rowIdx + 1;
}

function buildSummarySheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const s = new SheetBuilder(wb, "Zusammenfassung");
  const sum = report.summary;
  const am = report.amortisation;
  s.header("Zusammenfassung", "Ihre Investition ist die Eingabe; Bilanz und Amortisation ergeben sich per Formel.");

  const net = sum.netSelectedEUR;
  const annualBenefit = am.annualBenefitEUR;
  const baselineCost = annualBenefit - net; // baseline = benefit − net (identity)

  s.section("Eingaben (wie auf der Webseite)");
  s.input([
    { key: "invest", label: "Investition (gesamt)", value: r2(am.totalInvestmentEUR), unit: "€" },
  ]);

  s.section("Kalibrierung (aus 15-Minuten-Simulation)");
  s.calib([
    { key: "baseline", label: "Baseline-Stromkosten (ohne PV)", value: r2(baselineCost), unit: "€/Jahr", note: "Kosten, wenn der ganze Verbrauch aus dem Netz käme" },
    { key: "exportRev", label: "Export-Erlös", value: r2(sum.exportRevenueEUR), unit: "€" },
    { key: "importCost", label: "Import-Kosten", value: r2(sum.importCostEUR), unit: "€" },
  ]);

  s.section("Kennzahlen");
  s.formula("netEUR", "Netto-Bilanz", `=${s.addr.exportRev}-${s.addr.importCost}`, r2(net), "€", "Export − Import");
  s.formula("annualBenefit", "Jahresersparnis", `=${s.addr.baseline}+${s.addr.netEUR}`, r2(annualBenefit), "€/Jahr", "Baseline-Kosten + Netto-Bilanz");
  s.formula(
    "payback",
    "Amortisationszeit",
    `=IF(${s.addr.annualBenefit}<=0,"n/a",${s.addr.invest}/${s.addr.annualBenefit})`,
    Number.isFinite(am.paybackYears) ? r2(am.paybackYears) : "n/a",
    "Jahre",
    "Investition / Jahresersparnis",
    "result",
  );

  s.section("Weitere Kennzahlen (aus Simulation)");
  s.calib([
    { key: "effOverall", label: "Effektiver Strompreis (gesamt)", value: r2(report.effectivePrice.overallCt), unit: "ct/kWh" },
    { key: "npv", label: "Kapitalwert (NPV)", value: r2(report.cashflow.npvEUR), unit: "€" },
    { key: "irr", label: "Interne Rendite (IRR)", value: r2(report.cashflow.irrPercent), unit: "%" },
    { key: "lcoe", label: "Stromgestehungskosten (LCOE)", value: r2(report.cashflow.lcoeCtPerKWh), unit: "ct/kWh" },
  ]);

  s.section("Enthaltene Blätter");
  s.text("PV-Produktion", "Leistung × spezifischer Ertrag, monatliche Verteilung");
  s.text("Haushalt / Wärmepumpe / E-Auto / Brauchwasser", "Verbrauch, PV-Deckung, effektiver Preis");
  s.text("Heizung", "Wärmepumpe vs. Heizöl vs. Erdgas");
  s.text("Auto", "E-Auto vs. Diesel");
  s.text("Aggregat", "Energie- und Kostenbilanz");
  s.text("Gesamtkalkulation", "Produktion, Import, Export & alle Verbraucher in einer Übersicht");
  s.text("Beispieltage", "Stündliche Tagesprofile (Jan, März, Juli) mit Verbrauchern, Ø-Preis & Netzentgelt");
  s.text("Monatsübersicht", "Ganzes Jahr, eine Zeile je Monat: Verbrauch, Eigenverbrauch, Preise, Netto");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build the complete workbook (with live formulas) from a `SimReport`. */
export function buildWorkbook(report: SimReport): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PV-Erlösrechner";
  wb.created = new Date();

  buildSummarySheet(wb, report);
  buildPvSheet(wb, report);
  buildConsumerSheet(wb, report, "household", "Haushalt", "Haushalt (H0-Lastprofil)");
  if (report.inputs.consumers.heatpump.enabled) {
    buildConsumerSheet(wb, report, "heatpump", "Waermepumpe", "Wärmepumpe (Heizung)");
  }
  if (report.inputs.consumers.ev.enabled) {
    buildConsumerSheet(wb, report, "ev", "E-Auto", "E-Auto (Laden)");
  }
  if (report.inputs.consumers.bwwp.enabled) {
    buildConsumerSheet(wb, report, "bwwp", "Brauchwasser", "Brauchwasser-Wärmepumpe");
  }
  buildAggregateSheet(wb, report);
  buildGesamtSheet(wb, report);
  // One combined example-day sheet (January, March, July) + a month-by-month
  // overview for the whole year.
  buildExampleDaysSheet(wb, report, "Beispieltage", "Beispieltage — Januar, März & Juli", [
    { monthIndex: 0, label: "Januar" },
    { monthIndex: 2, label: "März" },
    { monthIndex: 6, label: "Juli" },
  ]);
  buildMonthlySheet(wb, report);
  if (report.opportunityCosts.heating.heatpumpElectricKWh > 0) {
    buildHeatingSheet(wb, report);
  }
  if (report.opportunityCosts.car.annualKm > 0) {
    buildCarSheet(wb, report);
  }

  return wb;
}

/** Serialise the workbook to bytes (Node / tests / browser). */
export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const data = await wb.xlsx.writeBuffer();
  return data as ArrayBuffer;
}

/**
 * Build the workbook and trigger a browser download. No-op outside a browser.
 * The filename encodes the key system size for easy identification.
 */
export async function downloadWorkbook(report: SimReport, filename?: string): Promise<void> {
  const wb = buildWorkbook(report);
  const data = await wb.xlsx.writeBuffer();
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    filename ??
    `pv-berechnung_${report.inputs.peakKWp}kwp_${report.inputs.capacityKWh}kwh.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
