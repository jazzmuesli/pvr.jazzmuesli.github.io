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
    expect(names).toContain("Gesamtkalkulation");
    expect(names).toContain("Beispieltage");
    expect(names).toContain("Monatsuebersicht");
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

/** Sum a column ("B", "C", …) over an inclusive 1-based row range. */
function sumColumn(hf: HyperFormula, sheetId: number, colLetter: string, firstRow: number, lastRow: number): number {
  const col = colLetter.charCodeAt(0) - 65;
  let total = 0;
  for (let r = firstRow - 1; r <= lastRow - 1; r++) {
    const v = hf.getCellValue({ sheet: sheetId, col, row: r });
    if (typeof v === "number") total += v;
  }
  return total;
}

describe("Excel export — Gesamtkalkulation sheet", () => {
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

  it("consumer-table totals: consumption, self-consumption and import sum up", () => {
    const sid = sheetId("Gesamtkalkulation");
    const row = rowByLabel(hf, sid, "Summe Verbraucher");
    const sum = report.summary;
    // Col B = consumption (exact), D = PV-covered, E = grid import. The PV-share
    // input cells are rounded to 2 decimals, so the derived PV-covered / grid
    // kWh drift by a fraction of a percent from the exact aggregate totals.
    expect(evalCell(hf, sid, `B${row}`)).toBeCloseTo(sum.totalLoadKWh, 0);
    expect(Math.abs(evalCell(hf, sid, `D${row}`) - sum.selfConsumptionKWh)).toBeLessThan(sum.selfConsumptionKWh * 0.005);
    expect(Math.abs(evalCell(hf, sid, `E${row}`) - sum.totalImportKWh)).toBeLessThan(sum.totalImportKWh * 0.005);
  });

  it("energy-balance formulas tie back to the consumer totals", () => {
    const sid = sheetId("Gesamtkalkulation");
    const sum = report.summary;
    expect(evalCell(hf, sid, addrByLabel(hf, sid, "Gesamtverbrauch"))).toBeCloseTo(sum.totalLoadKWh, 0);
    expect(Math.abs(evalCell(hf, sid, addrByLabel(hf, sid, "Eigenverbrauch (PV+Speicher)")) - sum.selfConsumptionKWh)).toBeLessThan(sum.selfConsumptionKWh * 0.005);
    expect(Math.abs(evalCell(hf, sid, addrByLabel(hf, sid, "Netz-Import")) - sum.totalImportKWh)).toBeLessThan(sum.totalImportKWh * 0.005);
  });

  it("self-consumption rate, autarky and net balance reproduce the summary", () => {
    const sid = sheetId("Gesamtkalkulation");
    // Rates derive from the (rounded-input) self-consumption, so allow the same
    // fraction-of-a-percent drift; the net balance is from exact calib cells.
    expect(evalCell(hf, sid, addrByLabel(hf, sid, "Eigenverbrauchsquote"))).toBeCloseTo(report.summary.selfConsumptionRatePct, 0);
    expect(evalCell(hf, sid, addrByLabel(hf, sid, "Autarkiegrad"))).toBeCloseTo(report.summary.selfSufficiencyPct, 0);
    expect(evalCell(hf, sid, addrByLabel(hf, sid, "Netto-Bilanz"))).toBeCloseTo(report.summary.netSelectedEUR, 1);
  });

  it("plausibility: rates are within physical bounds and PV covers part of the load", () => {
    const sid = sheetId("Gesamtkalkulation");
    const scr = evalCell(hf, sid, addrByLabel(hf, sid, "Eigenverbrauchsquote"));
    const aut = evalCell(hf, sid, addrByLabel(hf, sid, "Autarkiegrad"));
    const self = evalCell(hf, sid, addrByLabel(hf, sid, "Eigenverbrauch (PV+Speicher)"));
    expect(scr).toBeGreaterThan(0);
    expect(scr).toBeLessThanOrEqual(100);
    expect(aut).toBeGreaterThan(0);
    expect(aut).toBeLessThanOrEqual(100);
    expect(self).toBeGreaterThan(0);
    expect(self).toBeLessThanOrEqual(report.summary.totalLoadKWh + 1);
  });
});

describe("Excel export — example-day sheet (combined Jan/März/Juli)", () => {
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

  /** 1-based column of a header cell whose text equals `label` on the given
   *  header row (1-based). */
  function colOfHeader(sid: number, headerRow: number, label: string): number {
    const dims = hf.getSheetDimensions(sid);
    for (let c = 0; c < dims.width; c++) {
      if (hf.getCellValue({ sheet: sid, col: c, row: headerRow - 1 }) === label) return c + 1;
    }
    throw new Error(`header not found: ${label}`);
  }
  const letter = (col: number) => String.fromCharCode(64 + col);

  /** All 1-based "Stunde" header rows on the sheet, in order. */
  function headerRows(sid: number): number[] {
    const dims = hf.getSheetDimensions(sid);
    const rows: number[] = [];
    for (let r = 0; r < dims.height; r++) {
      if (hf.getCellValue({ sheet: sid, col: 0, row: r }) === "Stunde") rows.push(r + 1);
    }
    return rows;
  }

  it("contains all three months (Januar, März, Juli)", () => {
    const sid = sheetId("Beispieltage");
    expect(headerRows(sid).length).toBe(3);
  });

  it("hourly grid-import formula = MAX(0, load − self-use) reproduces every month's profile", () => {
    const sid = sheetId("Beispieltage");
    const rows = headerRows(sid);
    const monthsData = [report.daily[0], report.daily[2], report.daily[6]]; // Jan, März, Juli
    rows.forEach((headerRow, mi) => {
      const gridCol = colOfHeader(sid, headerRow, "Netzbezug kWh");
      for (let h = 0; h < 24; h++) {
        const row = headerRow + 1 + h;
        expect(evalCell(hf, sid, `${letter(gridCol)}${row}`)).toBeCloseTo(monthsData[mi][h].importKWh, 1);
      }
    });
  });

  it("per-consumer columns hold the hourly consumer load (July)", () => {
    const sid = sheetId("Beispieltage");
    const julyHeader = headerRows(sid)[2];
    const july = report.daily[6];
    const hhCol = colOfHeader(sid, julyHeader, "Haushalt kWh");
    const wpCol = colOfHeader(sid, julyHeader, "Wärmepumpe kWh");
    const evCol = colOfHeader(sid, julyHeader, "E-Auto kWh");
    for (let h = 0; h < 24; h++) {
      const row = julyHeader + 1 + h;
      expect(evalCell(hf, sid, `${letter(hhCol)}${row}`)).toBeCloseTo(july[h].load.household, 2);
      expect(evalCell(hf, sid, `${letter(wpCol)}${row}`)).toBeCloseTo(july[h].load.heatpump, 2);
      expect(evalCell(hf, sid, `${letter(evCol)}${row}`)).toBeCloseTo(july[h].load.ev, 2);
    }
  });

  it("per-consumer columns SUM to the total-load column each hour (July)", () => {
    const sid = sheetId("Beispieltage");
    const julyHeader = headerRows(sid)[2];
    const loadCol = colOfHeader(sid, julyHeader, "Last kWh");
    const hhCol = colOfHeader(sid, julyHeader, "Haushalt kWh");
    const wpCol = colOfHeader(sid, julyHeader, "Wärmepumpe kWh");
    const bwCol = colOfHeader(sid, julyHeader, "BWWP kWh");
    const evCol = colOfHeader(sid, julyHeader, "E-Auto kWh");
    for (let h = 0; h < 24; h++) {
      const row = julyHeader + 1 + h;
      const parts =
        evalCell(hf, sid, `${letter(hhCol)}${row}`) +
        evalCell(hf, sid, `${letter(wpCol)}${row}`) +
        evalCell(hf, sid, `${letter(bwCol)}${row}`) +
        evalCell(hf, sid, `${letter(evCol)}${row}`);
      expect(parts).toBeCloseTo(evalCell(hf, sid, `${letter(loadCol)}${row}`), 1);
    }
  });

  it("price & Netzentgelt columns hold the simulation's average values (July)", () => {
    const sid = sheetId("Beispieltage");
    const julyHeader = headerRows(sid)[2];
    const priceCol = colOfHeader(sid, julyHeader, "Ø Strompreis ct/kWh");
    const july = report.daily[6];
    for (let h = 0; h < 24; h++) {
      const row = julyHeader + 1 + h;
      expect(evalCell(hf, sid, `${letter(priceCol)}${row}`)).toBeCloseTo(july[h].avgPrice, 1);
    }
    // Netzentgelt column must exist and be non-negative.
    const netCol = colOfHeader(sid, julyHeader, "Ø Netzentgelt ct/kWh");
    for (let h = 0; h < 24; h++) {
      expect(evalCell(hf, sid, `${letter(netCol)}${julyHeader + 1 + h}`)).toBeGreaterThanOrEqual(0);
    }
  });

  it("daily totals row = SUM of the 24 hourly rows (July PV)", () => {
    const sid = sheetId("Beispieltage");
    const julyHeader = headerRows(sid)[2];
    const pvCol = colOfHeader(sid, julyHeader, "PV kWh");
    // The July totals row is the "Tagessumme" right after the July block.
    const dims = hf.getSheetDimensions(sid);
    let totalRow = -1;
    for (let r = julyHeader; r < dims.height; r++) {
      if (hf.getCellValue({ sheet: sid, col: 0, row: r }) === "Tagessumme") {
        totalRow = r + 1;
        break;
      }
    }
    expect(totalRow).toBeGreaterThan(0);
    const firstRow = julyHeader + 1;
    const lastRow = totalRow - 1;
    const pvTotalCell = evalCell(hf, sid, `${letter(pvCol)}${totalRow}`);
    expect(pvTotalCell).toBeCloseTo(sumColumn(hf, sid, letter(pvCol), firstRow, lastRow), 2);
    const reportPvDay = report.daily[6].reduce((a, d) => a + d.pvKWh, 0);
    expect(pvTotalCell).toBeCloseTo(reportPvDay, 1);
  });

  it("plausibility: winter day imports more than summer day, summer PV exceeds winter PV", () => {
    const sid = sheetId("Beispieltage");
    const rows = headerRows(sid); // [Jan, März, Juli]
    const janHeader = rows[0];
    const julHeader = rows[2];
    const pvCol = colOfHeader(sid, janHeader, "PV kWh");
    const gridCol = colOfHeader(sid, janHeader, "Netzbezug kWh");
    // Locate each block's Tagessumme row.
    const dims = hf.getSheetDimensions(sid);
    const totalRowAfter = (start: number): number => {
      for (let r = start; r < dims.height; r++) {
        if (hf.getCellValue({ sheet: sid, col: 0, row: r }) === "Tagessumme") return r + 1;
      }
      throw new Error("Tagessumme not found");
    };
    const janTotal = totalRowAfter(janHeader);
    const julTotal = totalRowAfter(julHeader);
    const janPv = evalCell(hf, sid, `${letter(pvCol)}${janTotal}`);
    const julPv = evalCell(hf, sid, `${letter(pvCol)}${julTotal}`);
    expect(julPv).toBeGreaterThan(janPv);
    const janImport = evalCell(hf, sid, `${letter(gridCol)}${janTotal}`);
    const julImport = evalCell(hf, sid, `${letter(gridCol)}${julTotal}`);
    expect(janImport).toBeGreaterThan(julImport);
  });
});

describe("Excel export — Monatsuebersicht sheet", () => {
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

  function colOfHeader(sid: number, headerRow: number, label: string): number {
    const dims = hf.getSheetDimensions(sid);
    for (let c = 0; c < dims.width; c++) {
      if (hf.getCellValue({ sheet: sid, col: c, row: headerRow - 1 }) === label) return c + 1;
    }
    throw new Error(`header not found: ${label}`);
  }
  const letter = (col: number) => String.fromCharCode(64 + col);

  it("has one data row per month (12) plus a Jahr totals row", () => {
    const sid = sheetId("Monatsuebersicht");
    const headerRow = rowByLabel(hf, sid, "Monat");
    const jahrRow = rowByLabel(hf, sid, "Jahr");
    // 12 month rows sit between the header and the Jahr row.
    expect(jahrRow - headerRow - 1).toBe(12);
  });

  it("monthly grid-import formula = MAX(0, consumption − self-consumption)", () => {
    const sid = sheetId("Monatsuebersicht");
    const headerRow = rowByLabel(hf, sid, "Monat");
    const gridCol = colOfHeader(sid, headerRow, "Netzbezug kWh");
    for (let m = 0; m < 12; m++) {
      const row = headerRow + 1 + m;
      expect(evalCell(hf, sid, `${letter(gridCol)}${row}`)).toBeCloseTo(report.monthly[m].importKWh, 1);
    }
  });

  it("Jahr totals: PV, consumption, export and net reproduce the annual figures", () => {
    const sid = sheetId("Monatsuebersicht");
    const headerRow = rowByLabel(hf, sid, "Monat");
    const jahrRow = rowByLabel(hf, sid, "Jahr");
    const pvCol = colOfHeader(sid, headerRow, "PV kWh");
    const loadCol = colOfHeader(sid, headerRow, "Verbrauch kWh");
    const nettoCol = colOfHeader(sid, headerRow, "Netto €");
    expect(evalCell(hf, sid, `${letter(pvCol)}${jahrRow}`)).toBeCloseTo(report.summary.totalPVKWh, 0);
    expect(evalCell(hf, sid, `${letter(loadCol)}${jahrRow}`)).toBeCloseTo(report.summary.totalLoadKWh, 0);
    // Sum of monthly net balances = the selected-scenario annual net balance.
    const netSum = report.monthly.reduce((a, mo) => a + mo.netEUR, 0);
    expect(evalCell(hf, sid, `${letter(nettoCol)}${jahrRow}`)).toBeCloseTo(netSum, 0);
  });

  it("per-consumer monthly columns SUM to the total-consumption column", () => {
    const sid = sheetId("Monatsuebersicht");
    const headerRow = rowByLabel(hf, sid, "Monat");
    const loadCol = colOfHeader(sid, headerRow, "Verbrauch kWh");
    const hhCol = colOfHeader(sid, headerRow, "Haushalt kWh");
    const wpCol = colOfHeader(sid, headerRow, "Wärmepumpe kWh");
    const bwCol = colOfHeader(sid, headerRow, "BWWP kWh");
    const evCol = colOfHeader(sid, headerRow, "E-Auto kWh");
    for (let m = 0; m < 12; m++) {
      const row = headerRow + 1 + m;
      const parts =
        evalCell(hf, sid, `${letter(hhCol)}${row}`) +
        evalCell(hf, sid, `${letter(wpCol)}${row}`) +
        evalCell(hf, sid, `${letter(bwCol)}${row}`) +
        evalCell(hf, sid, `${letter(evCol)}${row}`);
      expect(parts).toBeCloseTo(evalCell(hf, sid, `${letter(loadCol)}${row}`), 1);
    }
  });

  it("plausibility: July PV exceeds December PV; grid-fee column is non-negative", () => {
    const sid = sheetId("Monatsuebersicht");
    const headerRow = rowByLabel(hf, sid, "Monat");
    const pvCol = colOfHeader(sid, headerRow, "PV kWh");
    const netCol = colOfHeader(sid, headerRow, "Ø Netzentgelt ct/kWh");
    const julyPv = evalCell(hf, sid, `${letter(pvCol)}${headerRow + 1 + 6}`);
    const decPv = evalCell(hf, sid, `${letter(pvCol)}${headerRow + 1 + 11}`);
    expect(julyPv).toBeGreaterThan(decPv);
    for (let m = 0; m < 12; m++) {
      expect(evalCell(hf, sid, `${letter(netCol)}${headerRow + 1 + m}`)).toBeGreaterThanOrEqual(0);
    }
  });
});
