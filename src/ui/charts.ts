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

// ---- monthly chart --------------------------------------------------------
export interface MonthlyChartDatum {
  month: number;
  label: string;
  pvKWh: number;
  exportSolarKWh: number;
  exportBatteryKWh: number;
  chargeKWh: number;
  marketValueEUR: number;
}

export function renderMonthlyChart(
  host: HTMLElement,
  data: MonthlyChartDatum[],
  selectedMonth: number,
  onSelect: (month: number) => void,
): void {
  host.innerHTML = "";
  const W = 920;
  const H = 400;
  const m = { top: 36, right: 64, bottom: 44, left: 64 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxPv = Math.max(1, ...data.map((d) => d.pvKWh));
  const maxVal = Math.max(1, ...data.map((d) => d.marketValueEUR));
  const band = plotW / data.length;
  const barW = band * 0.16;

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const series: [number, string, string][] = [
      [d.pvKWh, COLORS.pv, "PV-Ertrag"],
      [d.exportSolarKWh, COLORS.solarExport, "Direkt-Export (PV)"],
      [d.exportBatteryKWh, COLORS.batteryExport, "Batterie-Export"],
      [d.chargeKWh, COLORS.charge, "Batterie-Ladung"],
    ];
    series.forEach(([val, color, name], s) => {
      const h = (val / maxPv) * plotH;
      const x = cx - barW * 2 + s * barW;
      const y = m.top + plotH - h;
      const rect = el("rect", { x, y, width: barW * 0.9, height: h, fill: color, rx: 1 });
      bindTip(rect, () =>
        `<strong>${d.label}</strong><br>${name}: <b>${Math.round(val)} kWh</b>`);
      svg.appendChild(rect);
    });

    // value label: annualised PV production on top of the tallest bar
    const labelY = m.top + plotH - (d.pvKWh / maxPv) * plotH - 6;
    const lbl = el("text", { x: cx, y: labelY, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
    lbl.textContent = `${Math.round(d.pvKWh)}`;
    svg.appendChild(lbl);

    // selection highlight + click
    const hit = el("rect", {
      x: m.left + i * band, y: m.top, width: band, height: plotH,
      fill: "transparent", class: d.month === selectedMonth ? "month-hit selected" : "month-hit",
    });
    hit.addEventListener("click", () => onSelect(d.month));
    bindTip(hit, () =>
      `<strong>${d.label}</strong><br>` +
      `PV-Ertrag: <b>${Math.round(d.pvKWh)} kWh</b><br>` +
      `Direkt-Export: ${Math.round(d.exportSolarKWh)} kWh<br>` +
      `Batterie-Export: ${Math.round(d.exportBatteryKWh)} kWh<br>` +
      `Batterie-Ladung: ${Math.round(d.chargeKWh)} kWh<br>` +
      `Marktwert: <b>${Math.round(d.marketValueEUR)} €</b>`);
    svg.appendChild(hit);

    const txt = el("text", { x: cx, y: m.top + plotH + 18, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 });
    txt.textContent = d.label;
    svg.appendChild(txt);
  });

  // market value line (right axis)
  const pts = data.map((d, i) => {
    const x = m.left + i * band + band / 2;
    const y = m.top + plotH - (d.marketValueEUR / maxVal) * plotH;
    return `${x},${y}`;
  });
  svg.appendChild(el("polyline", { points: pts.join(" "), fill: "none", stroke: COLORS.price, "stroke-width": 2 }));
  data.forEach((d, i) => {
    const x = m.left + i * band + band / 2;
    const y = m.top + plotH - (d.marketValueEUR / maxVal) * plotH;
    const c = el("circle", { cx: x, cy: y, r: 3, fill: COLORS.price });
    bindTip(c, () => `<strong>${d.label}</strong><br>Marktwert: <b>${Math.round(d.marketValueEUR)} €</b>`);
    svg.appendChild(c);
    const v = el("text", { x, y: y - 8, "text-anchor": "middle", fill: COLORS.price, "font-size": 10 });
    v.textContent = `${Math.round(d.marketValueEUR)}`;
    svg.appendChild(v);
  });

  // axes + labels
  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left + plotW, y1: m.top, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  const yLabel = el("text", { x: m.left - 12, y: m.top - 14, "text-anchor": "start", fill: COLORS.text, "font-size": 12 });
  yLabel.textContent = `PV max ${Math.round(maxPv)} kWh/Monat`;
  svg.appendChild(yLabel);
  const vLabel = el("text", { x: m.left + plotW + 12, y: m.top - 14, "text-anchor": "end", fill: COLORS.price, "font-size": 12 });
  vLabel.textContent = `Marktwert € (max ${Math.round(maxVal)})`;
  svg.appendChild(vLabel);
  const hint = el("text", { x: m.left, y: H - 6, "text-anchor": "start", fill: "#64748b", "font-size": 11 });
  hint.textContent = "Klick auf einen Monat → Stundendetail. Hinweis: Werte sind Jahresmittel pro Monat.";
  svg.appendChild(hint);

  host.appendChild(svg);
}

// ---- hourly chart ---------------------------------------------------------
export interface HourlyChartDatum {
  hour: number;
  pvKWh: number;
  solarExportKWh: number;
  batteryExportKWh: number;
  chargeKWh: number;
  avgPrice: number;
}

export function renderHourlyChart(host: HTMLElement, data: HourlyChartDatum[], monthLabel: string): void {
  host.innerHTML = "";
  const W = 920;
  const H = 400;
  const m = { top: 36, right: 64, bottom: 44, left: 64 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxPos = Math.max(1, ...data.map((d) => Math.max(d.pvKWh, d.solarExportKWh + d.batteryExportKWh)));
  const maxNeg = Math.max(0.1, ...data.map((d) => d.chargeKWh));
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
    const sH = d.solarExportKWh * posScale;
    const bH = d.batteryExportKWh * posScale;
    svg.appendChild(el("rect", { x: cx - barW, y: zeroY - sH - bH, width: barW * 0.9, height: sH, fill: COLORS.solarExport }));
    svg.appendChild(el("rect", { x: cx, y: zeroY - bH, width: barW * 0.9, height: bH, fill: COLORS.batteryExport }));
    const cH = d.chargeKWh * negScale;
    svg.appendChild(el("rect", { x: cx + barW, y: zeroY, width: barW * 0.9, height: cH, fill: COLORS.charge }));

    const hit = el("rect", { x: m.left + i * band, y: m.top, width: band, height: plotH, fill: "transparent" });
    bindTip(hit, () =>
      `<strong>${monthLabel}, ${String(d.hour).padStart(2, "0")}:00 Uhr</strong><br>` +
      `PV produziert: <b>${d.pvKWh.toFixed(1)} kWh/h</b><br>` +
      `Direkt-Export: ${d.solarExportKWh.toFixed(1)} kWh/h<br>` +
      `Batterie-Export: ${d.batteryExportKWh.toFixed(1)} kWh/h<br>` +
      `Batterie-Ladung: ${d.chargeKWh.toFixed(1)} kWh/h<br>` +
      `Ø Strompreis: <b>${Math.round(d.avgPrice)} €/MWh</b>`);
    svg.appendChild(hit);
  });

  const pts = data.map((d, i) => {
    const x = m.left + i * band + band / 2;
    const y = m.top + posH - (d.avgPrice / maxPrice) * posH;
    return `${x},${y}`;
  });
  svg.appendChild(el("polyline", { points: pts.join(" "), fill: "none", stroke: COLORS.price, "stroke-width": 2 }));

  svg.appendChild(el("line", { x1: m.left, y1: zeroY, x2: m.left + plotW, y2: zeroY, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: COLORS.axis }));
  for (let h = 0; h <= 24; h += 3) {
    const x = m.left + (h / 24) * plotW;
    const txt = el("text", { x, y: m.top + plotH + 18, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
    txt.textContent = `${h}`;
    svg.appendChild(txt);
  }
  const t1 = el("text", { x: m.left - 12, y: m.top - 14, fill: COLORS.text, "font-size": 12 });
  t1.textContent = `${monthLabel} — kWh/h (oben: erzeugt/exportiert, unten: geladen)`;
  svg.appendChild(t1);
  const t2 = el("text", { x: m.left + plotW + 12, y: m.top - 14, "text-anchor": "end", fill: COLORS.price, "font-size": 12 });
  t2.textContent = `Preis €/MWh (max ${Math.round(maxPrice)})`;
  svg.appendChild(t2);

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
  hint.textContent = "Balken: Direktvermarktung (hellblau) vs. feste Einspeisung (grau). Trend über alle verfügbaren Preisjahre.";
  svg.appendChild(hint);

  host.appendChild(svg);
}

export function renderLegend(host: HTMLElement): void {
  host.innerHTML = "";
  const items: [string, string][] = [
    ["PV-Ertrag (kWh)", COLORS.pv],
    ["Direkt-Export (kWh)", COLORS.solarExport],
    ["Batterie-Export (kWh)", COLORS.batteryExport],
    ["Batterie-Ladung (kWh)", COLORS.charge],
    ["Marktwert / Strompreis (€)", COLORS.price],
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
