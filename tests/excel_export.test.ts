// End-to-end test of the Excel export: build the workbook from a real
// `SimReport`, serialise it to .xlsx, read it back, and **evaluate the live
// formulas** with HyperFormula. The evaluated results must reproduce the
// numbers in the `SimReport` — this proves the formulas the user sees in the
// downloaded file actually implement the same model as the app.
//
// Pipeline:  runSimulation → buildWorkbook → xlsx buffer → ExcelJS.read
//            → HyperFormula.buildFromSheets → getCellValue → compare
//
// The last stage is the important one: HyperFormula is an independent Excel
// formula engine, so if our formulas were wrong (or referenced the wrong
// cells) the evaluated numbers would diverge from the report.

import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { HyperFormula } from "hyperformula";
import { runSimulation, DEFAULT_SIM_PARAMS, SimParams, SimReport } from "../src/calc/report";
import { ConsumerConfig } from "../src/calc/consumers";
import { buildWorkbook, workbookToBuffer } from "../src/export/workbook";

const baseConsumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 6500 },
  bwwp: { enabled: true, annualKWh: 480 },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

function params(overrides: Partial<SimParams> = {}): SimParams {
  return { ...DEFAULT_SIM_PARAMS, consumers: baseConsumers, ...overrides };
}

/**
 * Read an .xlsx buffer back with ExcelJS and turn every worksheet into the
 * 2-D array HyperFormula expects: formula cells become strings starting with
 * `=`, everything else keeps its literal (number / string) value.
 */
async function loadIntoHyperFormula(buffer: ArrayBuffer): Promise<{
  hf: HyperFormula;
  sheetId: (name: string) => number;
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheets: Record<string, unknown[][]> = {};
  const nameById: string[] = [];

  wb.eachSheet((ws) => {
    const grid: unknown[][] = [];
    // Determine the used bounds.
    const rowCount = ws.rowCount;
    const colCount = ws.columnCount;
    for (let r = 1; r <= rowCount; r++) {
      const row: unknown[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = ws.getCell(r, c);
        const v = cell.value;
        if (v && typeof v === "object" && "formula" in (v as object)) {
          const f = (v as ExcelJS.CellFormulaValue).formula;
          row.push("=" + f.replace(/^=+/, ""));
        } else if (v === null || v === undefined) {
          row.push(null);
        } else {
          row.push(v);
        }
      }
      grid.push(row);
    }
    sheets[ws.name] = grid;
    nameById.push(ws.name);
  });

  const hf = HyperFormula.buildFromSheets(
    sheets as Record<string, (string | number | boolean | null)[][]>,
    { licenseKey: "gpl-v3" },
  );
  const sheetId = (name: string): number => {
    const id = hf.getSheetId(name);
    if (id === undefined) throw new Error(`sheet not found: ${name}`);
    return id;
  };
  return { hf, sheetId };
}

/** Evaluate a single "B<row>"-style address on a named sheet. */
function evalCell(hf: HyperFormula, sheetId: number, address: string): number {
  const col = address.charCodeAt(0) - 65; // 'A' -> 0, 'B' -> 1
  const rowIdx = parseInt(address.slice(1), 10) - 1; // 1-based -> 0-based
  const v = hf.getCellValue({ sheet: sheetId, col, row: rowIdx });
  if (typeof v === "number") return v;
  throw new Error(`cell ${address} did not evaluate to a number: ${JSON.stringify(v)}`);
}

/**
 * Find the value-column ("B") row address of the row whose label (column "A")
 * equals `label` on the given sheet. Lets the test locate a formula cell
 * without hard-coding row numbers.
 */
function addrByLabel(hf: HyperFormula, sheetId: number, label: string): string {
  const dims = hf.getSheetDimensions(sheetId);
  for (let r = 0; r < dims.height; r++) {
    const a = hf.getCellValue({ sheet: sheetId, col: 0, row: r });
    if (a === label) return `B${r + 1}`;
  }
  throw new Error(`label not found: ${label}`);
}

/** 1-based row number of the row whose column-A label equals `label`. */
function rowByLabel(hf: HyperFormula, sheetId: number, label: string): number {
  const dims = hf.getSheetDimensions(sheetId);
  for (let r = 0; r < dims.height; r++) {
    const a = hf.getCellValue({ sheet: sheetId, col: 0, row: r });
    if (a === label) return r + 1;
  }
  throw new Error(`label not found: ${label}`);
}

describe("Excel export — workbook builds and serialises", () => {
  it("produces a valid .xlsx with the expected sheets", async () => {
    const report = runSimulation(params());
    const wb = buildWorkbook(report);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Zusammenfassung");
    expect(names).toContain("PV-Produktion");
    expect(names).toContain("Haushalt");
    expect(names).toContain("Waermepumpe");
    expect(names).toContain("E-Auto");
    expect(names).toContain("Aggregat");
    expect(names).toContain("Heizung");
    expect(names).toContain("Auto");

    const buffer = await workbookToBuffer(wb);
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });
});

describe("Excel export — live formulas reproduce the SimReport", () => {
  let report: SimReport;
  let hf: HyperFormula;
  let sheetId: (name: string) => number;

  beforeAll(async () => {
    report = runSimulation(params());
    const buffer = await workbookToBuffer(buildWorkbook(report));
    const loaded = await loadIntoHyperFormula(buffer);
    hf = loaded.hf;
    sheetId = loaded.sheetId;
  });

  it("PV: annual yield formula = kWp × specific yield", () => {
    const sid = sheetId("PV-Produktion");
    const addr = addrByLabel(hf, sid, "PV-Ertrag pro Jahr");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.summary.totalPVKWh, 0);
  });

  it("PV: monthly kWh SUM (derived from share × annual) = annual PV total", () => {
    const sid = sheetId("PV-Produktion");
    const row = rowByLabel(hf, sid, "Summe (Kontrolle)");
    // Column C holds the derived kWh sum; column B holds the share sum (≈100).
    // Monthly shares are rounded to 2 decimals, so the reconstructed kWh sum
    // drifts by a fraction of a percent from the exact annual total.
    const kwhSum = evalCell(hf, sid, `C${row}`);
    expect(Math.abs(kwhSum - report.summary.totalPVKWh)).toBeLessThan(report.summary.totalPVKWh * 0.005);
    expect(evalCell(hf, sid, `B${row}`)).toBeCloseTo(100, 0);
  });

  it("Aggregate: net balance formula = export − import", () => {
    const sid = sheetId("Aggregat");
    const addr = addrByLabel(hf, sid, "Netto-Bilanz");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.summary.netSelectedEUR, 1);
  });

  it("Aggregate: self-consumption rate and autarky match the summary", () => {
    const sid = sheetId("Aggregat");
    const scr = addrByLabel(hf, sid, "Eigenverbrauchsquote");
    const aut = addrByLabel(hf, sid, "Autarkiegrad");
    expect(evalCell(hf, sid, scr)).toBeCloseTo(report.summary.selfConsumptionRatePct, 1);
    expect(evalCell(hf, sid, aut)).toBeCloseTo(report.summary.selfSufficiencyPct, 1);
  });

  it("Aggregate: grid import formula = load − self-consumption", () => {
    const sid = sheetId("Aggregat");
    const addr = addrByLabel(hf, sid, "Netz-Import");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.summary.totalImportKWh, 1);
  });

  it("Summary: amortisation formula = investment / annual benefit", () => {
    const sid = sheetId("Zusammenfassung");
    const addr = addrByLabel(hf, sid, "Amortisationszeit");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.amortisation.paybackYears, 1);
  });

  it("Heating: useful heat formula = electricity × JAZ", () => {
    const sid = sheetId("Heizung");
    const addr = addrByLabel(hf, sid, "Nutzwärme");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.opportunityCosts.heating.usefulHeatKWh, 1);
  });

  it("Heating: heat-pump / oil / gas totals reproduce the report", () => {
    const sid = sheetId("Heizung");
    const hp = addrByLabel(hf, sid, "Wärmepumpe: Gesamtkosten");
    const oil = addrByLabel(hf, sid, "Heizöl: Gesamtkosten");
    const gas = addrByLabel(hf, sid, "Erdgas: Gesamtkosten");
    const h = report.opportunityCosts.heating;
    // Heat pump uses the exact effective ct/kWh recovered from the report;
    // allow a small tolerance for the ct rounding in the input cell.
    expect(evalCell(hf, sid, hp)).toBeCloseTo(h.heatpump.totalEUR, 0);
    expect(evalCell(hf, sid, oil)).toBeCloseTo(h.oil.totalEUR, 0);
    expect(evalCell(hf, sid, gas)).toBeCloseTo(h.gas.totalEUR, 0);
  });

  it("Heating: oil/gas delta formulas = total − heat-pump total", () => {
    const sid = sheetId("Heizung");
    const oilDelta = addrByLabel(hf, sid, "Mehrkosten ggü. Wärmepumpe");
    const h = report.opportunityCosts.heating;
    // The first "Mehrkosten..." label belongs to oil.
    expect(evalCell(hf, sid, oilDelta)).toBeCloseTo(h.oil.deltaVsHeatpumpEUR, 0);
  });

  it("Car: EV and diesel totals reproduce the report", () => {
    const sid = sheetId("Auto");
    const ev = addrByLabel(hf, sid, "E-Auto: Gesamtkosten");
    const diesel = addrByLabel(hf, sid, "Diesel: Gesamtkosten");
    const c = report.opportunityCosts.car;
    expect(evalCell(hf, sid, ev)).toBeCloseTo(c.ev.totalEUR, 0);
    expect(evalCell(hf, sid, diesel)).toBeCloseTo(c.diesel.totalEUR, 0);
  });

  it("Car: EV energy formula = km/100 × kWh/100km", () => {
    const sid = sheetId("Auto");
    const addr = addrByLabel(hf, sid, "E-Auto: Energiebedarf");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.opportunityCosts.car.ev.primaryEnergy, 1);
  });

  it("Consumer sheet (Haushalt): effective price = grid cost / consumption", () => {
    const sid = sheetId("Haushalt");
    const addr = addrByLabel(hf, sid, "Effektiver Strompreis");
    expect(evalCell(hf, sid, addr)).toBeCloseTo(report.effectivePrice.byConsumer.household, 1);
  });

  it("Consumer sheet (E-Auto): PV-covered = consumption × PV-coverage%", () => {
    const sid = sheetId("E-Auto");
    const addr = addrByLabel(hf, sid, "davon aus PV+Speicher gedeckt");
    const cov = report.effectivePrice.coverage.ev;
    // pvCovPct is stored rounded to 2 decimals, so allow a small tolerance.
    expect(evalCell(hf, sid, addr)).toBeCloseTo(cov.pvCoveredKWh, 0);
  });

  it("Consumer sheet (E-Auto): grid kWh = consumption − PV covered", () => {
    const sid = sheetId("E-Auto");
    const addr = addrByLabel(hf, sid, "Netzbezug");
    const cov = report.effectivePrice.coverage.ev;
    expect(evalCell(hf, sid, addr)).toBeCloseTo(cov.gridKWh, 0);
  });

  it("Summary: annual benefit = baseline + net, and payback = invest / benefit", () => {
    const sid = sheetId("Zusammenfassung");
    const benefit = addrByLabel(hf, sid, "Jahresersparnis");
    const payback = addrByLabel(hf, sid, "Amortisationszeit");
    expect(evalCell(hf, sid, benefit)).toBeCloseTo(report.amortisation.annualBenefitEUR, 0);
    expect(evalCell(hf, sid, payback)).toBeCloseTo(report.amortisation.paybackYears, 1);
  });
});

describe("Excel export — formulas track changed inputs (what-if)", () => {
  it("editing an input cell recomputes the dependent formula", async () => {
    const report = runSimulation(params());
    const buffer = await workbookToBuffer(buildWorkbook(report));
    const { hf, sheetId } = await loadIntoHyperFormula(buffer);

    const sid = sheetId("Heizung");
    const jazAddr = addrByLabel(hf, sid, "Jahresarbeitszahl (JAZ)");
    const heatAddr = addrByLabel(hf, sid, "Nutzwärme");
    const elecAddr = addrByLabel(hf, sid, "Wärmepumpe: Strombedarf");

    const elec = evalCell(hf, sid, elecAddr);
    const col = jazAddr.charCodeAt(0) - 65;
    const rowIdx = parseInt(jazAddr.slice(1), 10) - 1;
    // Change JAZ to 5 → useful heat must become electricity × 5.
    hf.setCellContents({ sheet: sid, col, row: rowIdx }, [[5]]);
    expect(evalCell(hf, sid, heatAddr)).toBeCloseTo(elec * 5, 2);
  });

  it("changing the user's kWp rescales the PV yield", async () => {
    const report = runSimulation(params());
    const buffer = await workbookToBuffer(buildWorkbook(report));
    const { hf, sheetId } = await loadIntoHyperFormula(buffer);

    const sid = sheetId("PV-Produktion");
    const kwpAddr = addrByLabel(hf, sid, "PV-Spitzenleistung");
    const yieldAddr = addrByLabel(hf, sid, "PV-Ertrag pro Jahr");
    const specYield = report.summary.totalPVKWh / report.inputs.peakKWp;

    const col = kwpAddr.charCodeAt(0) - 65;
    const rowIdx = parseInt(kwpAddr.slice(1), 10) - 1;
    // Double the array size → annual yield must double (kWp × specific yield).
    hf.setCellContents({ sheet: sid, col, row: rowIdx }, [[20]]);
    expect(evalCell(hf, sid, yieldAddr)).toBeCloseTo(20 * specYield, 1);
  });
});
