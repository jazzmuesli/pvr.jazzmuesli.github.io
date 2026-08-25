// Hand-rolled SVG charts (no charting dependency) with tooltips, value
// labels and drill-down. Follows basic usability patterns: clear titles, axis
// hints, hover tooltips with precise numbers, and on-bar value labels.

const SVGNS = "http://www.w3.org/2000/svg";

function el(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

export const COLORS = {
  pv: "#cbd5e1",
  solarExport: "#22c55e",
  batteryExport: "#1d4ed8",
  charge: "#f97316",
  price: "#ef4444",
  axis: "#94a3b8",
  text: "#334155",
  net: "#0ea5e9",
  fixed: "#94a3b8",
  selfUse: "#16a34a",
  load: "#0f172a",
  import: "#ea580c",
  exportK: "#1d4ed8",
};

// ---- shared tooltip -------------------------------------------------------
let tipEl: HTMLDivElement | null = null;
function tip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "chart-tooltip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(html: string, ev: MouseEvent): void {
  const t = tip();
  t.innerHTML = html;
  t.style.display = "block";
  moveTip(ev);
}
function moveTip(ev: MouseEvent): void {
  const t = tip();
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
function hideTip(): void {
  if (tipEl) tipEl.style.display = "none";
}
function bindTip(node: Element, html: () => string): void {
  node.addEventListener("mouseenter", (e) => showTip(html(), e as MouseEvent));
  node.addEventListener("mousemove", (e) => moveTip(e as MouseEvent));
  node.addEventListener("mouseleave", hideTip);
}

// ---- monthly chart (energy flows + net EUR) -------------------------------
export interface MonthlyChartDatum {
  month: number;
  label: string;
  pvKWh: number;
  selfConsumptionKWh: number;
  importKWh: number;
  exportKWh: number;
  netEUR: number;
}

export function renderMonthlyChart(
  host: HTMLElement,
  data: MonthlyChartDatum[],
  selectedMonth: number,
  onSelect: (month: number) => void,
): void {
  host.innerHTML = "";
  const W = 920;
  const H = 420;
  const m = { top: 36, right: 64, bottom: 44, left: 64 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxEnergy = Math.max(1, ...data.map((d) => Math.max(d.pvKWh, d.selfConsumptionKWh, d.importKWh, d.exportKWh)));
  const maxNet = Math.max(1, ...data.map((d) => Math.abs(d.netEUR)));
  const band = plotW / data.length;
  const barW = band * 0.13;

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const series: [number, string, string][] = [
      [d.selfConsumptionKWh, COLORS.selfUse, "Eigenverbrauch"],
      [d.exportKWh, COLORS.exportK, "Export (PV+Batterie)"],
      [d.importKWh, COLORS.import, "Netz-Import"],
    ];
    series.forEach(([val, color, name], s) => {
      const h = (val / maxEnergy) * plotH;
      const x = cx - barW * 1.5 + s * barW;
      const y = m.top + plotH - h;
      const rect = el("rect", { x, y, width: barW * 0.9, height: h, fill: color, rx: 1 });
      bindTip(rect, () => `<strong>${d.label}</strong><br>${name}: <b>${Math.round(val)} kWh</b>`);
      svg.appendChild(rect);
    });

    // PV line (left axis, kWh)
    const pvY = m.top + plotH - (d.pvKWh / maxEnergy) * plotH;
    const pvDot = el("circle", { cx, cy: pvY, r: 3, fill: COLORS.pv });
    bindTip(pvDot, () => `<strong>${d.label}</strong><br>PV-Ertrag: <b>${Math.round(d.pvKWh)} kWh</b>`);
    svg.appendChild(pvDot);

    // net EUR line (right axis)
    const netY = m.top + plotH - (d.netEUR / maxNet) * plotH;
    const netDot = el("circle", { cx, cy: netY, r: 3, fill: COLORS.price });
    bindTip(netDot, () => `<strong>${d.label}</strong><br>Netto (Export−Import): <b>${Math.round(d.netEUR)} €</b>`);
    svg.appendChild(netDot);

    const lbl = el("text", { x: cx, y: m.top + plotH - (d.pvKWh / maxEnergy) * plotH - 6, "text-anchor": "middle", fill: COLORS.text, "font-size": 10 });
    lbl.textContent = `${Math.round(d.pvKWh)}`;
    svg.appendChild(lbl);

    const hit = el("rect", {
      x: m.left + i * band, y: m.top, width: band, height: plotH,
      fill: "transparent", class: d.month === selectedMonth ? "month-hit selected" : "month-hit",
    });
    hit.addEventListener("click", () => onSelect(d.month));
    bindTip(hit, () =>
      `<strong>${d.label}</strong><br>` +
      `PV-Ertrag: <b>${Math.round(d.pvKWh)} kWh</b><br>` +
      `Eigenverbrauch: ${Math.round(d.selfConsumptionKWh)} kWh<br>` +
      `Export: ${Math.round(d.exportKWh)} kWh<br>` +
      `Netz-Import: ${Math.round(d.importKWh)} kWh<br>` +
      `Netto: <b>${Math.round(d.netEUR)} €</b>`);
    svg.appendChild(hit);

    const txt = el("text", { x: cx, y: m.top + plotH + 18, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 });
    txt.textContent = d.label;
    svg.appendChild(txt);
  });

  // connect PV dots and net dots
  const pvPts = data.map((d, i) => `${m.left + i * band + band / 2},${m.top + plotH - (d.pvKWh / maxEnergy) * plotH}`);
  svg.appendChild(el("polyline", { points: pvPts.join(" "), fill: "none", stroke: COLORS.pv, "stroke-width": 2 }));
  const netPts = data.map((d, i) => `${m.left + i * band + band / 2},${m.top + plotH - (d.netEUR / maxNet) * plotH}`);
  svg.appendChild(el("polyline", { points: netPts.join(" "), fill: "none", stroke: COLORS.price, "stroke-width": 2 }));

  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left + plotW, y1: m.top, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  const yLabel = el("text", { x: m.left - 12, y: m.top - 14, "text-anchor": "start", fill: COLORS.text, "font-size": 12 });
  yLabel.textContent = `Energie kWh/Monat (max ${Math.round(maxEnergy)})`;
  svg.appendChild(yLabel);
  const vLabel = el("text", { x: m.left + plotW + 12, y: m.top - 14, "text-anchor": "end", fill: COLORS.price, "font-size": 12 });
  vLabel.textContent = `Netto € (max ${Math.round(maxNet)})`;
  svg.appendChild(vLabel);
  const hint = el("text", { x: m.left, y: H - 6, "text-anchor": "start", fill: "#64748b", "font-size": 11 });
  hint.textContent = "Klick auf einen Monat → Stundendetail. Balken: Eigenverbrauch / Export / Import. Linien: PV (grau), Netto € (rot).";
  svg.appendChild(hint);

  host.appendChild(svg);
}

// ---- day chart (hourly or typical day) ------------------------------------
export interface DayChartDatum {
  hour: number;
  pvKWh: number;
  loadKWh: number;
  selfUseKWh: number;
  importKWh: number;
  exportKWh: number;
  avgPrice: number;
}

export function renderHourlyChart(host: HTMLElement, data: DayChartDatum[], monthLabel: string): void {
  renderDayChart(host, data, monthLabel);
}

export function renderTypicalDayChart(host: HTMLElement, data: DayChartDatum[], monthLabel: string): void {
  renderDayChart(host, data, `${monthLabel} — typischer Tag`);
}

function renderDayChart(host: HTMLElement, data: DayChartDatum[], monthLabel: string): void {
  host.innerHTML = "";
  const W = 920;
  const H = 420;
  const m = { top: 36, right: 64, bottom: 44, left: 64 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxPos = Math.max(1, ...data.map((d) => Math.max(d.pvKWh, d.exportKWh, d.loadKWh)));
  const maxNeg = Math.max(0.1, ...data.map((d) => d.importKWh));
  const maxPrice = Math.max(1, ...data.map((d) => d.avgPrice));
  const posH = plotH * 0.78;
  const negH = plotH * 0.22;
  const zeroY = m.top + posH;
  const band = plotW / 24;
  const barW = band * 0.18;
  const posScale = posH / maxPos;
  const negScale = negH / maxNeg;

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const pvH = d.pvKWh * posScale;
    svg.appendChild(el("rect", { x: cx - barW * 2, y: zeroY - pvH, width: barW * 0.9, height: pvH, fill: COLORS.pv }));
    const eH = d.exportKWh * posScale;
    svg.appendChild(el("rect", { x: cx - barW, y: zeroY - eH, width: barW * 0.9, height: eH, fill: COLORS.exportK }));
    const iH = d.importKWh * negScale;
    svg.appendChild(el("rect", { x: cx, y: zeroY, width: barW * 0.9, height: iH, fill: COLORS.import }));

    // load line
    const loadY = zeroY - d.loadKWh * posScale;
    svg.appendChild(el("circle", { cx, cy: loadY, r: 2.5, fill: COLORS.load }));

    const hit = el("rect", { x: m.left + i * band, y: m.top, width: band, height: plotH, fill: "transparent" });
    bindTip(hit, () =>
      `<strong>${monthLabel}, ${String(d.hour).padStart(2, "0")}:00 Uhr</strong><br>` +
      `PV produziert: <b>${d.pvKWh.toFixed(1)} kWh/h</b><br>` +
      `Verbrauch: ${d.loadKWh.toFixed(1)} kWh/h<br>` +
      `Eigenverbrauch: ${d.selfUseKWh.toFixed(1)} kWh/h<br>` +
      `Export: ${d.exportKWh.toFixed(1)} kWh/h<br>` +
      `Netz-Import: ${d.importKWh.toFixed(1)} kWh/h` +
      (d.avgPrice ? `<br>Ø Strompreis: <b>${Math.round(d.avgPrice)} €/MWh</b>` : ""));
    svg.appendChild(hit);
  });

  // load polyline
  const loadPts = data.map((d, i) => `${m.left + i * band + band / 2},${zeroY - d.loadKWh * posScale}`);
  svg.appendChild(el("polyline", { points: loadPts.join(" "), fill: "none", stroke: COLORS.load, "stroke-width": 2 }));

  // price polyline (right axis)
  if (maxPrice > 0 && data.some((d) => d.avgPrice > 0)) {
    const pricePts = data.map((d, i) => `${m.left + i * band + band / 2},${m.top + posH - (d.avgPrice / maxPrice) * posH}`);
    svg.appendChild(el("polyline", { points: pricePts.join(" "), fill: "none", stroke: COLORS.price, "stroke-width": 2, "stroke-dasharray": "4 2" }));
  }

  svg.appendChild(el("line", { x1: m.left, y1: zeroY, x2: m.left + plotW, y2: zeroY, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: COLORS.axis }));
  for (let h = 0; h <= 24; h += 3) {
    const x = m.left + (h / 24) * plotW;
    const txt = el("text", { x, y: m.top + plotH + 18, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
    txt.textContent = `${h}`;
    svg.appendChild(txt);
  }
  const t1 = el("text", { x: m.left - 12, y: m.top - 14, fill: COLORS.text, "font-size": 12 });
  t1.textContent = `${monthLabel} — kWh/h (oben: erzeugt/verbraucht/export, unten: Import)`;
  svg.appendChild(t1);
  const t2 = el("text", { x: m.left + plotW + 12, y: m.top - 14, "text-anchor": "end", fill: COLORS.price, "font-size": 12 });
  t2.textContent = `Preis €/MWh (max ${Math.round(maxPrice)})`;
  svg.appendChild(t2);

  host.appendChild(svg);
}

// ---- scenario comparison (net EUR across export/import schemes) -----------
export interface ScenarioDatum {
  label: string;
  netEUR: number;
  exportEUR: number;
  importEUR: number;
}

export function renderScenarioChart(host: HTMLElement, data: ScenarioDatum[]): void {
  host.innerHTML = "";
  const W = 920;
  const H = 360;
  const m = { top: 36, right: 24, bottom: 56, left: 72 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxVal = Math.max(1, ...data.map((d) => Math.abs(d.netEUR)));
  const band = plotW / data.length;
  const barW = band * 0.5;

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const h = (Math.abs(d.netEUR) / maxVal) * plotH;
    const y = d.netEUR >= 0 ? m.top + plotH - h : m.top + plotH;
    const rect = el("rect", { x: cx - barW / 2, y, width: barW, height: h, fill: d.netEUR >= 0 ? COLORS.net : COLORS.price, rx: 2 });
    bindTip(rect, () =>
      `<strong>${d.label}</strong><br>Netto: <b>${Math.round(d.netEUR)} €</b><br>` +
      `Export-Erlös: ${Math.round(d.exportEUR)} €<br>Import-Kosten: ${Math.round(d.importEUR)} €`);
    svg.appendChild(rect);
    const lbl = el("text", { x: cx, y: y - 6, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
    lbl.textContent = `${Math.round(d.netEUR)}`;
    svg.appendChild(lbl);
    const txt = el("text", { x: cx, y: m.top + plotH + 20, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
    txt.textContent = d.label;
    svg.appendChild(txt);
  });

  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  const yL = el("text", { x: m.left - 12, y: m.top - 14, "text-anchor": "start", fill: COLORS.text, "font-size": 12 });
  yL.textContent = "Netto-Jahresbilanz (€)";
  svg.appendChild(yL);
  const hint = el("text", { x: m.left, y: H - 4, "text-anchor": "start", fill: "#64748b", "font-size": 11 });
  hint.textContent = "Netto = Export-Erlös − Import-Kosten für verschiedene Kombinationen aus Einspeisung und Stromtarif.";
  svg.appendChild(hint);

  host.appendChild(svg);
}

// ---- comparison chart (trend across years) --------------------------------
export interface ComparisonDatum {
  year: string;
  netMarketEUR: number;
  fixedValueEUR: number;
  vwapEURperMWh: number;
  marktPraemieCt: number;
  exportKWh: number;
}

export function renderComparisonChart(host: HTMLElement, data: ComparisonDatum[]): void {
  host.innerHTML = "";
  const W = 920;
  const H = 360;
  const m = { top: 36, right: 24, bottom: 48, left: 72 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxVal = Math.max(1, ...data.map((d) => Math.max(d.netMarketEUR, d.fixedValueEUR)));
  const band = plotW / data.length;
  const barW = band * 0.3;

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const netH = (d.netMarketEUR / maxVal) * plotH;
    const fixH = (d.fixedValueEUR / maxVal) * plotH;
    const net = el("rect", { x: cx - barW - 2, y: m.top + plotH - netH, width: barW, height: netH, fill: COLORS.net, rx: 2 });
    const fix = el("rect", { x: cx + 2, y: m.top + plotH - fixH, width: barW, height: fixH, fill: COLORS.fixed, rx: 2 });
    bindTip(net, () =>
      `<strong>${d.year}</strong><br>Direktvermarktung (netto): <b>${Math.round(d.netMarketEUR)} €</b><br>` +
      `Ø Preis: ${Math.round(d.vwapEURperMWh)} €/MWh<br>Export: ${Math.round(d.exportKWh)} kWh<br>` +
      `Marktprämie: ${d.marktPraemieCt.toFixed(2)} ct/kWh`);
    bindTip(fix, () => `<strong>${d.year}</strong><br>Feste Einspeisung: <b>${Math.round(d.fixedValueEUR)} €</b>`);
    svg.appendChild(net);
    svg.appendChild(fix);
    const nl = el("text", { x: cx - barW / 2 - 2, y: m.top + plotH - netH - 6, "text-anchor": "middle", fill: COLORS.net, "font-size": 11 });
    nl.textContent = `${Math.round(d.netMarketEUR)}`;
    svg.appendChild(nl);
    const fl = el("text", { x: cx + barW / 2 + 2, y: m.top + plotH - fixH - 6, "text-anchor": "middle", fill: "#475569", "font-size": 11 });
    fl.textContent = `${Math.round(d.fixedValueEUR)}`;
    svg.appendChild(fl);
    const txt = el("text", { x: cx, y: m.top + plotH + 20, "text-anchor": "middle", fill: COLORS.text, "font-size": 13 });
    txt.textContent = d.year;
    svg.appendChild(txt);
    const sub = el("text", { x: cx, y: m.top + plotH + 36, "text-anchor": "middle", fill: "#64748b", "font-size": 10 });
    sub.textContent = `${Math.round(d.vwapEURperMWh)} €/MWh`;
    svg.appendChild(sub);
  });

  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  const yL = el("text", { x: m.left - 12, y: m.top - 14, "text-anchor": "start", fill: COLORS.text, "font-size": 12 });
  yL.textContent = "Jahreserlös (€)";
  svg.appendChild(yL);
  const hint = el("text", { x: m.left, y: H - 4, "text-anchor": "start", fill: "#64748b", "font-size": 11 });
  hint.textContent = "Balken: Direktvermarktung (hellblau) vs. feste Einspeisung (grau). Export-Vergleich über die Preisjahre.";
  svg.appendChild(hint);

  host.appendChild(svg);
}

export function renderLegend(host: HTMLElement): void {
  host.innerHTML = "";
  const items: [string, string][] = [
    ["PV-Ertrag (kWh)", COLORS.pv],
    ["Eigenverbrauch (kWh)", COLORS.selfUse],
    ["Export (kWh)", COLORS.exportK],
    ["Netz-Import (kWh)", COLORS.import],
    ["Verbrauch (Linie)", COLORS.load],
    ["Netto € / Strompreis", COLORS.price],
  ];
  for (const [label, color] of items) {
    const wrap = document.createElement("span");
    wrap.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = color;
    wrap.appendChild(sw);
    wrap.appendChild(document.createTextNode(label));
    host.appendChild(wrap);
  }
}
