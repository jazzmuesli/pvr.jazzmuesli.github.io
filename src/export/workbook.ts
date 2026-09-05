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
import { t } from "../i18n";

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
    const titleCell = this.ws.getCell(this.row, 1);
    titleCell.value = text;
    titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.title } };
    this.ws.getCell(this.row, 2).fill = titleCell.fill;
    this.ws.getCell(this.row, 3).fill = titleCell.fill;
    this.ws.getCell(this.row, 4).fill = titleCell.fill;
    this.row += 1;

    if (subtitle) {
      const st = this.ws.getCell(this.row, 1);
      st.value = subtitle;
      st.font = { italic: true, size: 10, color: { argb: "FF595959" } };
    }
    this.row += 1;

    // Colour legend so the user knows which cells are editable.
    const legend = this.ws.getCell(this.row, 1);
    legend.value = t("workbook.legend");
    legend.font = { bold: true, size: 9 };
    const inCell = this.ws.getCell(this.row, 2);
    inCell.value = t("workbook.input");
    inCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.inputFill } };
    inCell.font = { size: 9 };
    inCell.alignment = { horizontal: "center" };
    const calibCell = this.ws.getCell(this.row, 3);
    calibCell.value = t("workbook.calibration");
    calibCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.calibFill } };
    calibCell.font = { size: 9 };
    calibCell.alignment = { horizontal: "center" };
    const noteCell = this.ws.getCell(this.row, 4);
    noteCell.value = t("workbook.legend_note");
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
  const s = new SheetBuilder(wb, t("sheet.pv"));
  s.header(t("sheet.pv_title"), t("sheet.pv_subtitle"));

  const annualPV = report.summary.totalPVKWh;
  const specificYield = report.inputs.peakKWp > 0 ? annualPV / report.inputs.peakKWp : 0;

  s.section(t("excel.inputs"));
  s.input([
    { key: "kwp", label: t("excel.pv_peak"), value: report.inputs.peakKWp, unit: "kWp" },
    { key: "tilt", label: t("excel.tilt"), value: report.inputs.tiltDeg, unit: "°" },
  ]);
  s.text("Ausrichtung", report.inputs.orientation);
  s.text("Standort", report.inputs.location);

  s.section(t("excel.calibration_section"));
  s.calib([
    {
      key: "specificYield",
      label: t("excel.specific_yield"),
      value: r2(specificYield),
      unit: "kWh/kWp",
      note: t("excel.specific_yield_note"),
    },
  ]);

  s.section(t("excel.calculation"));
  s.formula(
    "pvYear",
    t("excel.pv_annual"),
    `=${s.addr.kwp}*${s.addr.specificYield}`,
    r2(annualPV),
    "kWh",
    t("excel.pv_formula"),
    "result",
  );

  // Monthly breakdown: a yellow monthly-share column (%) that the user can
  // edit; each month's kWh is derived = annual × share. The shares come from
  // the simulation's monthly split and sum to 100 %.
  s.section(t("excel.monthly_distribution"));
  const ws = s.worksheet;
  let rowIdx = s.currentRow;
  [t("excel.month"), t("excel.share_percent"), t("excel.kwh_arrow")].forEach((h, i) => {
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
  chkLabel.value = t("excel.sum_check");
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
  s.section(t("excel.inputs"));
  s.input([
    { key: "annualKWh", label: t("excel.annual_consumption"), value: r2(cons?.annualKWh ?? 0), unit: "kWh", note: t("excel.annual_consumption_note") },
    { key: "gridPriceCt", label: t("excel.grid_price"), value: r2(cov?.gridPriceCt ?? 0), unit: "ct/kWh", note: report.inputs.importScheme === "fixed" ? t("excel.grid_price_fixed_note") : t("excel.grid_price_dynamic_note") },
  ]);

  s.section(t("excel.calibration_section"));
  const covPct = cov?.pvSharePct ?? 0;
  s.calib([
    { key: "pvCovPct", label: t("excel.pv_coverage"), value: r2(covPct), unit: "%", note: t("excel.pv_coverage_note") },
  ]);

  s.section(t("excel.calculation"));
  s.formula(
    "pvCovered",
    t("excel.pv_covered"),
    `=${s.addr.annualKWh}*${s.addr.pvCovPct}/100`,
    r2(cov?.pvCoveredKWh ?? 0),
    "kWh",
    t("excel.pv_covered_formula"),
  );
  s.formula(
    "gridKWh",
    t("excel.grid_import"),
    `=${s.addr.annualKWh}-${s.addr.pvCovered}`,
    r2(cov?.gridKWh ?? Math.max(0, (cons?.annualKWh ?? 0) - (cov?.pvCoveredKWh ?? 0))),
    "kWh",
    t("excel.grid_import_formula"),
  );
  s.formula(
    "gridCost",
    t("excel.grid_cost"),
    `=${s.addr.gridKWh}*${s.addr.gridPriceCt}/100`,
    r2(((cov?.gridKWh ?? 0) * (cov?.gridPriceCt ?? 0)) / 100),
    "€",
    t("excel.grid_cost_formula"),
  );
  s.formula(
    "effectiveCt",
    t("excel.eff_price"),
    `=IF(${s.addr.annualKWh}=0,0,${s.addr.gridCost}/${s.addr.annualKWh}*100)`,
    r2(effCt),
    "ct/kWh",
    t("excel.eff_price_formula"),
    "result",
  );
}

function buildHeatingSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const h = report.opportunityCosts.heating;
  const s = new SheetBuilder(wb, t("sheet.heating"));
  s.header(
    t("sheet.heating_title"),
    t("sheet.heating_subtitle"),
  );

  s.section(t("excel.inputs"));
  s.input([
    { key: "hpElec", label: t("excel.hp_electricity"), value: r2(h.heatpumpElectricKWh), unit: "kWh", note: t("excel.hp_electricity_note") },
    { key: "jaz", label: t("excel.jaz"), value: h.jaz, unit: "", note: t("excel.jaz_note") },
    { key: "oilEurPer100L", label: t("excel.oil_price"), value: 130, unit: "€/100L", note: t("excel.oil_price_note") },
    { key: "oilKWhPerL", label: t("excel.oil_heating_value"), value: 10, unit: "kWh/L" },
    { key: "oilEff", label: t("excel.oil_efficiency"), value: 0.85, unit: "" },
    { key: "oilSweep", label: t("excel.oil_chimney"), value: r2(h.oil.chimneySweepEUR), unit: "€/Jahr" },
    { key: "gasCt", label: t("excel.gas_price"), value: 11, unit: "ct/kWh" },
    { key: "gasEff", label: t("excel.gas_efficiency"), value: 0.92, unit: "" },
    { key: "gasGridFeeCt", label: t("excel.gas_grid_fee"), value: 2.0, unit: "ct/kWh" },
    { key: "gasNeben", label: t("excel.gas_fixed_costs"), value: r2(h.gas.otherNebenkostenEUR), unit: "€/Jahr" },
    { key: "gasSweep", label: t("excel.gas_chimney"), value: r2(h.gas.chimneySweepEUR), unit: "€/Jahr" },
  ]);

  s.section(t("excel.calibration_section"));
  s.calib([
    {
      key: "hpCt",
      label: t("excel.hp_effective_price"),
      value: r2((h.heatpump.energyCostEUR / Math.max(h.heatpumpElectricKWh, 1e-9)) * 100),
      unit: "ct/kWh",
      note: t("excel.hp_effective_price_note"),
    },
  ]);

  s.section("Nutzwärme-Berechnung");
  s.formula("usefulHeat", t("excel.useful_heat"), `=${s.addr.hpElec}*${s.addr.jaz}`, r2(h.usefulHeatKWh), "kWh", t("excel.useful_heat_formula"));

  s.section("Wärmepumpe");
  s.formula("hpTotal", t("excel.hp_total_cost"), `=${s.addr.hpElec}*${s.addr.hpCt}/100`, r2(h.heatpump.totalEUR), "€/Jahr", t("excel.hp_total_cost_formula"), "result");

  s.section("Heizöl");
  s.formula("oilPrimary", t("excel.oil_energy_need"), `=${s.addr.usefulHeat}/${s.addr.oilEff}`, r2(h.oil.primaryEnergyKWh), "kWh", t("excel.oil_energy_need_formula"));
  s.formula("oilLitres", t("excel.oil_amount"), `=${s.addr.oilPrimary}/${s.addr.oilKWhPerL}`, r2(h.oil.primaryEnergyKWh / 10), "L", t("excel.oil_amount_formula"));
  s.formula("oilEnergyCost", t("excel.oil_energy_cost"), `=${s.addr.oilLitres}*${s.addr.oilEurPer100L}/100`, r2(h.oil.energyCostEUR), "€", t("excel.oil_energy_cost_formula"));
  s.formula("oilTotal", t("excel.oil_total_cost"), `=${s.addr.oilEnergyCost}+${s.addr.oilSweep}`, r2(h.oil.totalEUR), "€/Jahr", t("excel.oil_total_cost_formula"), "result");
  s.formula("oilDelta", t("excel.oil_extra_cost"), `=${s.addr.oilTotal}-${s.addr.hpTotal}`, r2(h.oil.deltaVsHeatpumpEUR), "€/Jahr");

  s.section("Erdgas");
  s.formula("gasPrimary", t("excel.gas_energy_need"), `=${s.addr.usefulHeat}/${s.addr.gasEff}`, r2(h.gas.primaryEnergyKWh), "kWh", t("excel.gas_energy_need_formula"));
  s.formula("gasEnergyCost", t("excel.gas_energy_cost"), `=${s.addr.gasPrimary}*${s.addr.gasCt}/100`, r2(h.gas.energyCostEUR), "€", t("excel.gas_energy_cost_formula"));
  s.formula("gasGridFee", t("excel.gas_grid_cost"), `=${s.addr.gasPrimary}*${s.addr.gasGridFeeCt}/100`, r2(h.gas.gridFeeEUR), "€", t("excel.gas_grid_cost_formula"));
  s.formula("gasTotal", t("excel.gas_total_cost"), `=${s.addr.gasEnergyCost}+${s.addr.gasGridFee}+${s.addr.gasNeben}+${s.addr.gasSweep}`, r2(h.gas.totalEUR), "€/Jahr", t("excel.gas_total_cost_formula"), "result");
  s.formula("gasDelta", t("excel.gas_extra_cost"), `=${s.addr.gasTotal}-${s.addr.hpTotal}`, r2(h.gas.deltaVsHeatpumpEUR), "€/Jahr");
}

function buildCarSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const c = report.opportunityCosts.car;
  const s = new SheetBuilder(wb, t("sheet.car"));
  s.header(
    t("sheet.car_title"),
    t("sheet.car_subtitle"),
  );

  s.section(t("excel.inputs"));
  s.input([
    { key: "km", label: t("excel.ev_annual_km"), value: r2(c.annualKm), unit: "km" },
    { key: "evKwh100", label: t("excel.ev_consumption"), value: r2((c.ev.primaryEnergy / Math.max(c.annualKm, 1e-9)) * 100), unit: "kWh/100km" },
    { key: "evMaintCt", label: t("excel.ev_maintenance"), value: r2((c.ev.maintenanceEUR / Math.max(c.annualKm, 1e-9)) * 100), unit: "ct/km" },
    { key: "evTax", label: t("excel.ev_tax"), value: r2(c.ev.vehicleTaxEUR), unit: "€/Jahr" },
    { key: "evOther", label: t("excel.ev_insurance"), value: r2(c.ev.otherNebenkostenEUR), unit: "€/Jahr" },
    { key: "dieselL100", label: t("excel.diesel_consumption"), value: r2((c.diesel.primaryEnergy / Math.max(c.annualKm, 1e-9)) * 100), unit: "L/100km" },
    { key: "dieselEurL", label: t("excel.diesel_price"), value: r2(c.diesel.energyCostEUR / Math.max(c.diesel.primaryEnergy, 1e-9)), unit: "€/L" },
    { key: "dieselMaintCt", label: t("excel.diesel_maintenance"), value: r2((c.diesel.maintenanceEUR / Math.max(c.annualKm, 1e-9)) * 100), unit: "ct/km" },
    { key: "dieselTax", label: t("excel.diesel_tax"), value: r2(c.diesel.vehicleTaxEUR), unit: "€/Jahr" },
    { key: "dieselOther", label: t("excel.diesel_insurance"), value: r2(c.diesel.otherNebenkostenEUR), unit: "€/Jahr" },
  ]);

  s.section(t("excel.calibration_section"));
  s.calib([
    { key: "evCt", label: t("excel.ev_effective_price"), value: r2((c.ev.energyCostEUR / Math.max(c.ev.primaryEnergy, 1e-9)) * 100), unit: "ct/kWh", note: t("excel.ev_effective_price_note") },
  ]);

  s.section("E-Auto");
  s.formula("evEnergy", t("excel.ev_energy_need"), `=${s.addr.km}/100*${s.addr.evKwh100}`, r2(c.ev.primaryEnergy), "kWh", t("excel.ev_energy_need_formula"));
  s.formula("evEnergyCost", t("excel.ev_energy_cost"), `=${s.addr.evEnergy}*${s.addr.evCt}/100`, r2(c.ev.energyCostEUR), "€");
  s.formula("evMaint", t("excel.ev_maintenance_cost"), `=${s.addr.km}*${s.addr.evMaintCt}/100`, r2(c.ev.maintenanceEUR), "€");
  s.formula("evTotal", t("excel.ev_total_cost"), `=${s.addr.evEnergyCost}+${s.addr.evMaint}+${s.addr.evTax}+${s.addr.evOther}`, r2(c.ev.totalEUR), "€/Jahr", t("excel.ev_total_cost_formula"), "result");

  s.section("Diesel");
  s.formula("dieselLitres", t("excel.diesel_fuel_amount"), `=${s.addr.km}/100*${s.addr.dieselL100}`, r2(c.diesel.primaryEnergy), "L", t("excel.diesel_fuel_amount_formula"));
  s.formula("dieselEnergyCost", t("excel.diesel_fuel_cost"), `=${s.addr.dieselLitres}*${s.addr.dieselEurL}`, r2(c.diesel.energyCostEUR), "€");
  s.formula("dieselMaint", t("excel.diesel_maintenance_cost"), `=${s.addr.km}*${s.addr.dieselMaintCt}/100`, r2(c.diesel.maintenanceEUR), "€");
  s.formula("dieselTotal", t("excel.diesel_total_cost"), `=${s.addr.dieselEnergyCost}+${s.addr.dieselMaint}+${s.addr.dieselTax}+${s.addr.dieselOther}`, r2(c.diesel.totalEUR), "€/Jahr", t("excel.diesel_total_cost_formula"), "result");
  s.formula("dieselDelta", t("excel.diesel_extra_cost"), `=${s.addr.dieselTotal}-${s.addr.evTotal}`, r2(c.diesel.deltaVsEvEUR), "€/Jahr");
}

function buildAggregateSheet(wb: ExcelJS.Workbook, report: SimReport): void {
  const s = new SheetBuilder(wb, t("sheet.aggregate"));
  const sum = report.summary;
  s.header(t("sheet.aggregate_title"), t("sheet.aggregate_subtitle"));

  s.section(t("excel.inputs"));
  s.input([
    { key: "load", label: t("excel.total_consumption"), value: r2(sum.totalLoadKWh), unit: "kWh", note: t("excel.total_consumption_note") },
  ]);

  s.section(t("excel.calibration_section"));
  s.calib([
    { key: "pvYear", label: t("excel.pv_yield"), value: r2(sum.totalPVKWh), unit: "kWh" },
    { key: "selfCons", label: t("excel.self_consumption"), value: r2(sum.selfConsumptionKWh), unit: "kWh", note: t("excel.self_consumption_note") },
    { key: "export", label: t("excel.grid_export"), value: r2(sum.totalExportKWh), unit: "kWh" },
    { key: "exportRev", label: t("excel.export_revenue"), value: r2(sum.exportRevenueEUR), unit: "€" },
    { key: "importCost", label: t("excel.import_cost"), value: r2(sum.importCostEUR), unit: "€" },
  ]);

  s.section(t("excel.calculation"));
  s.formula("importKWh", t("excel.net_import"), `=${s.addr.load}-${s.addr.selfCons}`, r2(sum.totalImportKWh), "kWh", t("excel.net_import_formula"));
  s.formula("selfConsRate", t("excel.self_consumption_rate"), `=IF(${s.addr.pvYear}=0,0,${s.addr.selfCons}/${s.addr.pvYear}*100)`, r2(sum.selfConsumptionRatePct), "%", t("excel.self_consumption_rate_formula"));
  s.formula("selfSuff", t("excel.autarky"), `=IF(${s.addr.load}=0,0,${s.addr.selfCons}/${s.addr.load}*100)`, r2(sum.selfSufficiencyPct), "%", t("excel.autarky_formula"));
  s.formula("netEUR", t("excel.net_balance"), `=${s.addr.exportRev}-${s.addr.importCost}`, r2(sum.netSelectedEUR), "€", t("excel.net_balance_formula"), "result");
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
  const s = new SheetBuilder(wb, t("sheet.overview"));
  const sum = report.summary;
  const cov = report.effectivePrice.coverage;
  s.header(
    t("sheet.overview_title"),
    t("sheet.overview_subtitle"),
  );

  // --- Consumer table: label | consumption (input) | PV-share % (calib) |
  //     PV-covered kWh (formula) | grid kWh (formula) | eff. price (formula) ---
  s.section(t("excel.consumer_table"));
  const ws = s.worksheet;
  // Give the extra data columns sensible widths.
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 16;

  let rowIdx = s.currentRow;
  const headers = [t("excel.consumer"), t("excel.consumption_kwh"), t("excel.pv_share_percent"), t("excel.pv_covered_kwh"), t("excel.grid_import_kwh"), t("excel.eff_ct_kwh")];
  headers.forEach((h, i) => {
    const c = ws.getCell(rowIdx, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerFill } };
    c.border = THIN_BORDER;
  });
  rowIdx += 1;

  const consumerDefs: { key: "household" | "heatpump" | "bwwp" | "ev"; label: string }[] = [
    { key: "household", label: t("consumer.household") },
    { key: "heatpump", label: t("consumer.heatpump") },
    { key: "bwwp", label: t("consumer.bwwp.full") },
    { key: "ev", label: t("consumer.ev") },
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
  tl.value = t("excel.total_consumers");
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
  s.section(t("excel.energy_balance"));
  s.calib([
    { key: "pvYear", label: t("excel.pv_production"), value: r2(sum.totalPVKWh), unit: "kWh", note: t("excel.pv_production_note") },
    { key: "exportKWh", label: t("excel.grid_export_label"), value: r2(sum.totalExportKWh), unit: "kWh" },
    { key: "exportRev", label: t("excel.export_revenue"), value: r2(sum.exportRevenueEUR), unit: "€" },
    { key: "importCost", label: t("excel.import_cost"), value: r2(sum.importCostEUR), unit: "€" },
  ]);
  // Self-consumption and import tie back to the consumer-table totals.
  s.formula("selfCons", t("excel.self_consumption_total"), `=${selfTotalAddr}`, r2(sum.selfConsumptionKWh), "kWh", t("excel.self_consumption_total_note"));
  s.formula("importKWh", t("excel.grid_import_total"), `=${gridTotalAddr}`, r2(sum.totalImportKWh), "kWh", t("excel.grid_import_total_note"));
  s.formula("load", t("excel.total_consumption_label"), `=${loadTotalAddr}`, r2(sum.totalLoadKWh), "kWh", t("excel.total_consumption_note"));

  s.section(t("excel.summary_controls"));
  s.formula("selfConsRate", t("excel.self_consumption_rate_label"), `=IF(${s.addr.pvYear}=0,0,${s.addr.selfCons}/${s.addr.pvYear}*100)`, r2(sum.selfConsumptionRatePct), "%", t("excel.self_consumption_rate_note"));
  s.formula("selfSuff", t("excel.autarky_label"), `=IF(${s.addr.load}=0,0,${s.addr.selfCons}/${s.addr.load}*100)`, r2(sum.selfSufficiencyPct), "%", t("excel.autarky_note"));
  s.formula("netEUR", t("excel.net_balance_label"), `=${s.addr.exportRev}-${s.addr.importCost}`, r2(sum.netSelectedEUR), "€", t("excel.net_balance_note"), "result");
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
    t("sheet.example_days_subtitle"),
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
  const headers: string[] = [t("excel.hour"), t("excel.pv_kwh"), t("excel.load_kwh")];
  consumerCols.forEach((c) => headers.push(c.label));
  const idxSelf = headers.push(t("excel.self_use_kwh"));
  const idxGrid = headers.push(t("excel.grid_import_kwh2"));
  const idxExport = headers.push(t("excel.grid_export_kwh"));
  const idxPrice = headers.push(t("excel.avg_price"));
  const idxNet = headers.push(t("excel.avg_grid_fee"));
  const idxSoc = headers.push(t("excel.soc_kwh"));
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
    tl.value = t("excel.day_total");
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
  const s = new SheetBuilder(wb, t("sheet.monthly_overview"));
  s.header(
    t("sheet.monthly_overview_title"),
    t("sheet.monthly_overview_subtitle"),
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
  const headers: string[] = [t("excel.month"), t("excel.pv_kwh"), t("excel.consumption_kwh")];
  consumerCols.forEach((c) => headers.push(c.label));
  const idxSelf = headers.push(t("excel.self_use_kwh"));
  const idxGrid = headers.push(t("excel.grid_import_kwh2"));
  const idxExport = headers.push(t("excel.grid_export_kwh"));
  const idxPrice = headers.push(t("excel.avg_price"));
  const idxNet = headers.push(t("excel.avg_grid_fee"));
  const idxNetto = headers.push(t("excel.net_balance_short"));
  const idxLoad = 3; // "Verbrauch kWh"
  const colLetter = (i: number) => String.fromCharCode(64 + i);

  ws.getColumn(1).width = 14;
  for (let c = 2; c <= headers.length; c++) ws.getColumn(c).width = 15;

  const city = cityForLocation(report.inputs.location);
  const scheme = report.inputs.importScheme as TariffScheme;

  s.section(t("excel.monthly_values"));
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
  tl.value = t("excel.year");
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
  const s = new SheetBuilder(wb, t("sheet.summary"));
  const sum = report.summary;
  const am = report.amortisation;
  s.header(t("sheet.summary_title"), t("sheet.summary_subtitle"));

  const net = sum.netSelectedEUR;
  const annualBenefit = am.annualBenefitEUR;
  const baselineCost = annualBenefit - net; // baseline = benefit − net (identity)

  s.section(t("excel.inputs"));
  s.input([
    { key: "invest", label: t("excel.investment_total"), value: r2(am.totalInvestmentEUR), unit: "€" },
  ]);

  s.section(t("excel.calibration_section"));
  s.calib([
    { key: "baseline", label: t("excel.baseline_cost"), value: r2(baselineCost), unit: "€/Jahr", note: t("excel.baseline_cost_note") },
    { key: "exportRev", label: t("excel.export_revenue"), value: r2(sum.exportRevenueEUR), unit: "€" },
    { key: "importCost", label: t("excel.import_cost"), value: r2(sum.importCostEUR), unit: "€" },
  ]);

  s.section(t("excel.summary_controls"));
  s.formula("netEUR", t("excel.net_balance_short"), `=${s.addr.exportRev}-${s.addr.importCost}`, r2(net), "€", t("excel.net_balance_short_note"));
  s.formula("annualBenefit", t("excel.annual_savings"), `=${s.addr.baseline}+${s.addr.netEUR}`, r2(annualBenefit), "€/Jahr", t("excel.annual_savings_note"));
  s.formula(
    "payback",
    t("excel.payback"),
    `=IF(${s.addr.annualBenefit}<=0,"n/a",${s.addr.invest}/${s.addr.annualBenefit})`,
    Number.isFinite(am.paybackYears) ? r2(am.paybackYears) : "n/a",
    "Jahre",
    t("excel.payback_formula"),
    "result",
  );

  s.section("Weitere Kennzahlen (aus Simulation)");
  s.calib([
    { key: "effOverall", label: t("excel.eff_price_total"), value: r2(report.effectivePrice.overallCt), unit: "ct/kWh" },
    { key: "npv", label: t("excel.npv"), value: r2(report.cashflow.npvEUR), unit: "€" },
    { key: "irr", label: t("excel.irr"), value: r2(report.cashflow.irrPercent), unit: "%" },
    { key: "lcoe", label: t("excel.lcoe"), value: r2(report.cashflow.lcoeCtPerKWh), unit: "ct/kWh" },
  ]);

  s.section(t("excel.sheets_included"));
  s.text(t("sheet.pv"), t("excel.desc_pv"));
  s.text(`${t("sheet.household")} / ${t("sheet.heatpump")} / ${t("sheet.ev")} / ${t("sheet.bwwp")}`, t("excel.desc_consumers"));
  s.text(t("sheet.heating"), t("excel.desc_heating"));
  s.text(t("sheet.car"), t("excel.desc_car"));
  s.text(t("sheet.aggregate"), t("excel.desc_aggregate"));
  s.text(t("sheet.overview"), t("excel.desc_overview"));
  s.text(t("sheet.example_days"), t("excel.desc_example_days"));
  s.text(t("sheet.monthly_overview"), t("excel.desc_monthly"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build the complete workbook (with live formulas) from a `SimReport`. */
export function buildWorkbook(report: SimReport): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = t("workbook.creator");
  wb.created = new Date();

  buildSummarySheet(wb, report);
  buildPvSheet(wb, report);
  buildConsumerSheet(wb, report, "household", t("sheet.household"), t("excel.household_title"));
  if (report.inputs.consumers.heatpump.enabled) {
    buildConsumerSheet(wb, report, "heatpump", t("sheet.heatpump"), t("excel.heatpump_title"));
  }
  if (report.inputs.consumers.ev.enabled) {
    buildConsumerSheet(wb, report, "ev", t("sheet.ev"), t("excel.ev_title"));
  }
  if (report.inputs.consumers.bwwp.enabled) {
    buildConsumerSheet(wb, report, "bwwp", t("sheet.bwwp"), t("excel.bwwp_title"));
  }
  buildAggregateSheet(wb, report);
  buildGesamtSheet(wb, report);
  // One combined example-day sheet (January, March, July) + a month-by-month
  // overview for the whole year.
  buildExampleDaysSheet(wb, report, t("sheet.example_days"), t("sheet.example_days"), [
    { monthIndex: 0, label: t("month.january") },
    { monthIndex: 2, label: t("month.march") },
    { monthIndex: 6, label: t("month.july") },
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
