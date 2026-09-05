// Hand-rolled SVG charts — no charting dependency. Follows UX best
// practices from Fronius Solar.web, SolarEdge, and energy-dashboard research:
//
//  • Interactive legend: hover a legend item → highlights that series
//  • Shared crosshair tooltip at cursor position
//  • Clear axis labels with units, readable on mobile
//  • Maximum 4–5 series per chart for clarity
//  • Production vs consumption clearly separated
//  • Grid import/export shown as net balance (negative = export)
//  • Monetary balance with zero-line reference
//
// Per-consumer load breakdown: the monthly and hourly charts stack the load of
// each consumer (Haushalt / Wärmepumpe / Brauchw.-WP / E-Auto) so the user can
// see *who* consumes the energy, on top of the PV / net-€ context lines.

const SVGNS = "http://www.w3.org/2000/svg";

import {
  ConsumerKey,
  CONSUMER_ORDER,
  MonthlyChartDatum,
  DayChartDatum,
  ScenarioDatum,
  TariffCombination,
} from "../calc/report";

function el(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

// ---- semantic palette ------------------------------------------------------
export const CONSUMER_LABELS: Record<ConsumerKey, string> = {
  household: "Haushalt",
  heatpump: "Wärmepumpe",
  bwwp: "Brauchw.-WP",
  ev: "E-Auto",
};

export const COLORS = {
  // consumers (stack)
  household: "#0ea5e9", // sky
  heatpump: "#f59e0b", // amber
  bwwp: "#14b8a6", // teal
  ev: "#a855f7", // violet
  // energy flows
  pv: "#d97706", // strong solar amber
  selfUse: "#22c55e",
  import: "#ef4444", // red
  exportK: "#2563eb", // blue
  soc: "#8b5cf6",
  price: "#dc2626",
  net: "#0d9488", // teal-green
  fixed: "#94a3b8",
  // chrome
  axis: "#cbd5e1",
  grid: "#eef2f7",
  text: "#334155",
  muted: "#94a3b8",
};

export const CONSUMER_COLORS: Record<ConsumerKey, string> = {
  household: COLORS.household,
  heatpump: COLORS.heatpump,
  bwwp: COLORS.bwwp,
  ev: COLORS.ev,
};

// ---- scale helper ----------------------------------------------------------
function niceScale(maxV: number, targetTicks = 5): { max: number; step: number } {
  if (!isFinite(maxV) || maxV <= 0) return { max: 1, step: 1 };
  const raw = maxV / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step: number;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5;
  else step = 10;
  step *= mag;
  const max = Math.ceil(maxV / step) * step;
  return { max, step };
}

// Extended niceScale that also computes a min (for charts with negative values).
function niceScaleRange(minV: number, maxV: number, targetTicks = 5): { min: number; max: number; step: number } {
  const absMax = Math.max(Math.abs(minV), Math.abs(maxV), 1);
  const s = niceScale(absMax, targetTicks);
  const min = minV < 0 ? -s.max : 0;
  return { min, max: s.max, step: s.step };
}

// ---- shared tooltip --------------------------------------------------------
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

function fmtKWh(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString("de-DE") : v.toFixed(1);
}
function fmtEUR(v: number): string {
  return `${Math.round(v).toLocaleString("de-DE")} €`;
}

// ---- line / dot with a white halo so they read over filled bars ------------
function haloLine(svg: SVGElement, points: string, color: string, width = 3, dataKey?: string): void {
  const g = dataKey ? el("g", { "data-key": dataKey }) : svg;
  g.appendChild(el("polyline", { points, fill: "none", stroke: "#ffffff", "stroke-width": width + 3.5, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.9 }));
  g.appendChild(el("polyline", { points, fill: "none", stroke: color, "stroke-width": width, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  if (dataKey) svg.appendChild(g);
}
function haloDot(svg: SVGElement, cx: number, cy: number, r: number, color: string, dataKey?: string): void {
  const g = dataKey ? el("g", { "data-key": dataKey }) : svg;
  g.appendChild(el("circle", { cx, cy, r: r + 1.6, fill: "#ffffff", opacity: 0.9 }));
  g.appendChild(el("circle", { cx, cy, r, fill: color }));
  if (dataKey) svg.appendChild(g);
}

// ---- interactive legend ----------------------------------------------------
// Hovering a legend item highlights matching SVG elements and vice-versa.
interface LegendItem { label: string; color: string; shape: "rect" | "line"; key?: string; }
function appendLegend(host: HTMLElement, items: LegendItem[], svgEl?: SVGElement): void {
  const wrap = document.createElement("div");
  wrap.className = "chart-legend";

  for (const it of items) {
    const item = document.createElement("span");
    item.className = "legend-item";
    if (it.key) item.dataset.key = it.key;
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    if (it.shape === "line") {
      sw.style.background = "transparent";
      sw.style.borderTop = `3px solid ${it.color}`;
      sw.style.width = "18px";
      sw.style.height = "0";
      sw.style.borderRadius = "0";
    } else {
      sw.style.background = it.color;
    }
    item.appendChild(sw);
    const lbl = document.createElement("span");
    lbl.textContent = it.label;
    item.appendChild(lbl);

    // Hover on legend → highlight matching chart elements
    if (it.key && svgEl) {
      const key = it.key;
      item.addEventListener("mouseenter", () => {
        svgEl.querySelectorAll(`[data-key="${key}"]`).forEach((el) => el.classList.add("chart-element-highlighted"));
        svgEl.querySelectorAll(`[data-key]`).forEach((el) => {
          if (el.getAttribute("data-key") !== key) el.classList.add("chart-element-dimmed");
        });
        item.classList.add("legend-item-highlighted");
      });
      item.addEventListener("mouseleave", () => {
        svgEl.querySelectorAll(".chart-element-highlighted").forEach((el) => el.classList.remove("chart-element-highlighted"));
        svgEl.querySelectorAll(".chart-element-dimmed").forEach((el) => el.classList.remove("chart-element-dimmed"));
        item.classList.remove("legend-item-highlighted");
      });
    }

    wrap.appendChild(item);
  }

  // Hover on chart SVG element → highlight matching legend item
  if (svgEl) {
    svgEl.addEventListener("mouseover", (e) => {
      const target = (e.target as Element).closest("[data-key]");
      if (!target) return;
      const key = target.getAttribute("data-key");
      if (!key) return;
      wrap.querySelectorAll(`.legend-item[data-key="${key}"]`).forEach((li) => li.classList.add("legend-item-highlighted"));
      svgEl.querySelectorAll(`[data-key]`).forEach((el) => {
        if (el.getAttribute("data-key") !== key) el.classList.add("chart-element-dimmed");
      });
    });
    svgEl.addEventListener("mouseout", (e) => {
      const related = e.relatedTarget as Element | null;
      if (related && svgEl.contains(related) && related.closest("[data-key]")) return;
      wrap.querySelectorAll(".legend-item-highlighted").forEach((li) => li.classList.remove("legend-item-highlighted"));
      svgEl.querySelectorAll(".chart-element-dimmed").forEach((el) => el.classList.remove("chart-element-dimmed"));
    });
  }

  host.appendChild(wrap);
}

// ---- monthly chart (stacked consumer load + PV + net EUR) ------------------
export function renderMonthlyChart(
  host: HTMLElement,
  data: MonthlyChartDatum[],
  selectedMonth: number,
  onSelect: (month: number) => void,
): void {
  host.innerHTML = "";
  const W = 960;
  const H = 460;
  const m = { top: 44, right: 80, bottom: 56, left: 70 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const eMaxRaw = Math.max(1, ...data.map((d) => Math.max(d.totalLoadKWh, d.pvKWh)));
  const e = niceScale(eMaxRaw, 5);
  const eScale = (v: number) => m.top + plotH - (v / e.max) * plotH;

  const netAbs = Math.max(1, ...data.map((d) => Math.abs(d.netEUR)));
  const nBound = niceScale(netAbs, 5).max;
  const nScale = (v: number) => m.top + plotH / 2 - (v / nBound) * (plotH / 2);

  const band = plotW / data.length;
  const barW = Math.min(50, band * 0.58);

  // gridlines + left axis ticks (kWh)
  for (let t = 0; t <= e.max + 1e-6; t += e.step) {
    const y = eScale(t);
    svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + plotW, y2: y, stroke: COLORS.grid, "stroke-width": 1 }));
    const lbl = el("text", { x: m.left - 10, y: y + 4, "text-anchor": "end", fill: COLORS.muted, "font-size": 11 });
    lbl.textContent = String(Math.round(t));
    svg.appendChild(lbl);
  }
  // right axis ticks (€)
  for (const t of [-nBound, -nBound / 2, 0, nBound / 2, nBound]) {
    const y = nScale(t);
    const lbl = el("text", { x: m.left + plotW + 10, y: y + 4, "text-anchor": "start", fill: COLORS.net, "font-size": 11 });
    lbl.textContent = t === 0 ? "0" : `${Math.round(t)}`;
    svg.appendChild(lbl);
  }

  const pvPts: string[] = [];
  const netPts: string[] = [];

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;

    // stacked consumer bars (bottom-up)
    let yTop = m.top + plotH;
    for (const key of CONSUMER_ORDER) {
      const val = d.load[key];
      if (val <= 0) continue;
      const h = (val / e.max) * plotH;
      const rect = el("rect", { x: cx - barW / 2, y: yTop - h, width: barW, height: h, fill: CONSUMER_COLORS[key], rx: 2, class: "bar", "data-key": key });
      bindTip(rect, () =>
        `<strong>${d.label}</strong><br>` +
        `${CONSUMER_LABELS.household}: <b>${fmtKWh(d.load.household)} kWh</b><br>` +
        `${CONSUMER_LABELS.heatpump}: ${fmtKWh(d.load.heatpump)} kWh<br>` +
        `${CONSUMER_LABELS.bwwp}: ${fmtKWh(d.load.bwwp)} kWh<br>` +
        `${CONSUMER_LABELS.ev}: ${fmtKWh(d.load.ev)} kWh<br>` +
        `Summe Verbrauch: <b>${fmtKWh(d.totalLoadKWh)} kWh</b>`);
      svg.appendChild(rect);
      yTop -= h;
    }

    // total-load value label above the stack
    const totLbl = el("text", { x: cx, y: yTop - 6, "text-anchor": "middle", fill: COLORS.text, "font-size": 10 });
    totLbl.textContent = `${Math.round(d.totalLoadKWh)}`;
    svg.appendChild(totLbl);

    // PV line point (left axis) — emphasised
    const pvY = eScale(d.pvKWh);
    pvPts.push(`${cx},${pvY}`);
    haloDot(svg, cx, pvY, 4, COLORS.pv, "pv");
    const pvHit = el("circle", { cx, cy: pvY, r: 11, fill: "transparent", "data-key": "pv" });
    bindTip(pvHit, () => `<strong>${d.label}</strong><br>PV-Ertrag: <b>${fmtKWh(d.pvKWh)} kWh</b>`);
    svg.appendChild(pvHit);

    // net € line point (right axis)
    const netY = nScale(d.netEUR);
    netPts.push(`${cx},${netY}`);
    haloDot(svg, cx, netY, 3.5, COLORS.net, "net");
    const netLbl = el("text", { x: cx, y: netY - 8, "text-anchor": "middle", fill: COLORS.net, "font-size": 10, "data-key": "net" });
    netLbl.textContent = `${Math.round(d.netEUR)}`;
    svg.appendChild(netLbl);

    // selection hit area
    const hit = el("rect", {
      x: m.left + i * band, y: m.top, width: band, height: plotH,
      fill: "transparent", class: d.month === selectedMonth ? "month-hit selected" : "month-hit",
    });
    hit.addEventListener("click", () => onSelect(d.month));
    bindTip(hit, () =>
      `<strong>${d.label}</strong><br>` +
      `PV-Ertrag: <b>${fmtKWh(d.pvKWh)} kWh</b><br>` +
      `Verbrauch: ${fmtKWh(d.totalLoadKWh)} kWh<br>` +
      `Eigenverbrauch: ${fmtKWh(d.selfConsumptionKWh)} kWh<br>` +
      `Export: ${fmtKWh(d.exportKWh)} kWh<br>` +
      `Netz-Import: ${fmtKWh(d.importKWh)} kWh<br>` +
      `Netto: <b>${fmtEUR(d.netEUR)}</b>`);
    svg.appendChild(hit);

    const txt = el("text", { x: cx, y: m.top + plotH + 22, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 });
    txt.textContent = d.label;
    svg.appendChild(txt);
  });

  // emphasised PV + net lines (halo makes them pop over the bars)
  haloLine(svg, pvPts.join(" "), COLORS.pv, 3.5, "pv");
  haloLine(svg, netPts.join(" "), COLORS.net, 3, "net");

  // zero reference for net axis
  const zeroY = nScale(0);
  svg.appendChild(el("line", { x1: m.left, y1: zeroY, x2: m.left + plotW, y2: zeroY, stroke: COLORS.net, "stroke-dasharray": "4 3", "stroke-width": 1, opacity: 0.5 }));

  // axis frame
  svg.appendChild(el("line", { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left + plotW, y1: m.top, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));

  const yLabel = el("text", { x: m.left - 10, y: m.top - 18, "text-anchor": "start", fill: COLORS.muted, "font-size": 12 });
  yLabel.textContent = `Energie kWh/Monat (max ${Math.round(e.max)})`;
  svg.appendChild(yLabel);
  const vLabel = el("text", { x: m.left + plotW + 10, y: m.top - 18, "text-anchor": "end", fill: COLORS.net, "font-size": 12 });
  vLabel.textContent = `Netto €/Monat (0 = gestrichelt)`;
  svg.appendChild(vLabel);

  const hint = el("text", { x: m.left, y: H - 10, "text-anchor": "start", fill: COLORS.muted, "font-size": 11 });
  hint.textContent = "Klick auf einen Monat → Stundendetail. Gestapelte Balken = Verbrauch pro Verbraucher; Linien: PV-Ertrag (gold) und Netto-€ (türkis).";
  svg.appendChild(hint);

  host.appendChild(svg);

  appendLegend(host, [
    { label: CONSUMER_LABELS.household, color: COLORS.household, shape: "rect", key: "household" },
    { label: CONSUMER_LABELS.heatpump, color: COLORS.heatpump, shape: "rect", key: "heatpump" },
    { label: CONSUMER_LABELS.bwwp, color: COLORS.bwwp, shape: "rect", key: "bwwp" },
    { label: CONSUMER_LABELS.ev, color: COLORS.ev, shape: "rect", key: "ev" },
    { label: "PV-Ertrag", color: COLORS.pv, shape: "line", key: "pv" },
    { label: "Netto €", color: COLORS.net, shape: "line", key: "net" },
  ], svg);
}

// ---- day chart (hourly, stacked consumer area + PV/import/SOC/price) -------
export function renderHourlyChart(host: HTMLElement, data: DayChartDatum[], monthLabel: string, socMaxKWh: number): void {
  renderDayChart(host, data, monthLabel, true, socMaxKWh);
}

function renderDayChart(host: HTMLElement, data: DayChartDatum[], monthLabel: string, hasPrice: boolean, socMaxKWh: number): void {
  host.innerHTML = "";
  const W = 960;
  const H = 460;
  const m = { top: 44, right: 80, bottom: 56, left: 70 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  // Import can go negative (grid export) — extend axis below zero
  const eMaxRaw = Math.max(1, ...data.map((d) => Math.max(d.totalLoadKWh, d.pvKWh)));
  const eMinRaw = Math.min(0, ...data.map((d) => d.importKWh));
  const e = niceScaleRange(eMinRaw, eMaxRaw, 5);
  const eScale = (v: number) => m.top + plotH - ((v - e.min) / (e.max - e.min)) * plotH;

  const showSoc = socMaxKWh > 0;
  const maxPrice = Math.max(1, ...data.map((d) => d.avgPrice));
  const hasPriceData = hasPrice && data.some((d) => d.avgPrice > 0);
  const pScale = (v: number) => m.top + plotH - (v / maxPrice) * plotH;
  const socScale = (v: number) => m.top + plotH - (showSoc ? (v / socMaxKWh) : 0) * plotH;

  const band = plotW / 24;

  // gridlines + left axis ticks (kWh/h) — includes negative values
  for (let t = e.min; t <= e.max + 1e-6; t += e.step) {
    const y = eScale(t);
    const isZero = Math.abs(t) < 1e-6;
    svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + plotW, y2: y, stroke: isZero ? COLORS.axis : COLORS.grid, "stroke-width": isZero ? 1.2 : 1 }));
    const lbl = el("text", { x: m.left - 10, y: y + 4, "text-anchor": "end", fill: t < -0.5 ? COLORS.import : COLORS.muted, "font-size": 11 });
    lbl.textContent = String(Math.round(t));
    svg.appendChild(lbl);
  }
  // right axis ticks (€/MWh price) when present
  if (hasPriceData) {
    const p = niceScale(maxPrice, 5);
    for (let t = 0; t <= p.max + 1e-6; t += p.step) {
      const y = pScale(t);
      const lbl = el("text", { x: m.left + plotW + 10, y: y + 4, "text-anchor": "start", fill: COLORS.price, "font-size": 11 });
      lbl.textContent = String(Math.round(t));
      svg.appendChild(lbl);
    }
  }

  // stacked consumer areas
  const cum = new Array(data.length).fill(0);
  for (const key of CONSUMER_ORDER) {
    const topPts: string[] = [];
    const botPts: string[] = [];
    data.forEach((d, h) => {
      const x = m.left + h * band + band / 2;
      const yTop = eScale(cum[h] + d.load[key]);
      const yBot = eScale(cum[h]);
      topPts.push(`${x},${yTop}`);
      botPts.unshift(`${x},${yBot}`);
      cum[h] += d.load[key];
    });
    svg.appendChild(el("polygon", { points: [...topPts, ...botPts].join(" "), fill: CONSUMER_COLORS[key], opacity: 0.85, "data-key": key }));
  }

  // total-load outline
  const loadPts = data.map((_, h) => `${m.left + h * band + band / 2},${eScale(cum[h])}`);
  svg.appendChild(el("polyline", { points: loadPts.join(" "), fill: "none", stroke: COLORS.text, "stroke-width": 1.5, opacity: 0.4 }));

  // PV production line (emphasised)
  const pvPts = data.map((d, h) => `${m.left + h * band + band / 2},${eScale(d.pvKWh)}`);
  haloLine(svg, pvPts.join(" "), COLORS.pv, 3.5, "pv");

  // grid-import line (part of load, emphasised) — can go negative (export)
  const impPts = data.map((d, h) => `${m.left + h * band + band / 2},${eScale(d.importKWh)}`);
  haloLine(svg, impPts.join(" "), COLORS.import, 2.5, "import");

  // battery SOC line (own 0..capacity scale)
  if (showSoc) {
    const socPts = data.map((d, h) => `${m.left + h * band + band / 2},${socScale(d.socKWh)}`);
    haloLine(svg, socPts.join(" "), COLORS.soc, 2, "soc");
    for (let h = 0; h < data.length; h++) {
      haloDot(svg, m.left + h * band + band / 2, socScale(data[h].socKWh), 2, COLORS.soc, "soc");
    }
  }

  // price line (right axis)
  if (hasPriceData) {
    const pricePts = data.map((d, h) => `${m.left + h * band + band / 2},${pScale(d.avgPrice)}`);
    haloLine(svg, pricePts.join(" "), COLORS.price, 1.8, "price");
  }

  // hour labels
  for (let h = 0; h <= 24; h += 3) {
    const x = m.left + (h / 24) * plotW;
    const txt = el("text", { x, y: m.top + plotH + 22, "text-anchor": "middle", fill: COLORS.muted, "font-size": 11 });
    txt.textContent = `${h}`;
    svg.appendChild(txt);
  }

  // per-hour hit areas + tooltips
  data.forEach((d, h) => {
    const x = m.left + h * band;
    const hit = el("rect", { x, y: m.top, width: band, height: plotH, fill: "transparent" });
    bindTip(hit, () =>
      `<strong>${monthLabel}, ${String(d.hour).padStart(2, "0")}:00 Uhr</strong><br>` +
      `${CONSUMER_LABELS.household}: <b>${fmtKWh(d.load.household)} kWh/h</b><br>` +
      `${CONSUMER_LABELS.heatpump}: ${fmtKWh(d.load.heatpump)} kWh/h<br>` +
      `${CONSUMER_LABELS.bwwp}: ${fmtKWh(d.load.bwwp)} kWh/h<br>` +
      `${CONSUMER_LABELS.ev}: ${fmtKWh(d.load.ev)} kWh/h<br>` +
      `Summe Verbrauch: ${fmtKWh(d.totalLoadKWh)} kWh/h<br>` +
      `PV produziert: ${fmtKWh(d.pvKWh)} kWh/h<br>` +
      `Netz-Import: ${fmtKWh(d.importKWh)} kWh/h<br>` +
      `Eigenverbrauch: ${fmtKWh(d.selfUseKWh)} kWh/h<br>` +
      `Export: ${fmtKWh(d.exportKWh)} kWh/h` +
      (showSoc ? `<br>Batterie-SoC: <b>${fmtKWh(d.socKWh)} kWh</b>` : "") +
      (d.avgPrice ? `<br>Ø Strompreis: <b>${Math.round(d.avgPrice)} €/MWh</b>` : ""));
    svg.appendChild(hit);
  });

  // axis frame
  svg.appendChild(el("line", { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left + plotW, y1: m.top, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));

  const t1 = el("text", { x: m.left - 10, y: m.top - 18, "text-anchor": "start", fill: COLORS.muted, "font-size": 12 });
  t1.textContent = `${monthLabel} — kWh/h · gestapelte Fläche = Verbrauch pro Verbraucher${showSoc ? " · SoC (lila)" : ""}`;
  svg.appendChild(t1);
  const t2 = el("text", { x: m.left + plotW + 10, y: m.top - 18, "text-anchor": "end", fill: hasPriceData ? COLORS.price : COLORS.muted, "font-size": 12 });
  t2.textContent = hasPriceData ? `Preis €/MWh (max ${Math.round(maxPrice)})` : "kein Preisverlauf";
  svg.appendChild(t2);

  host.appendChild(svg);

  const hourlyLegend: LegendItem[] = [
    { label: CONSUMER_LABELS.household, color: COLORS.household, shape: "rect", key: "household" },
    { label: CONSUMER_LABELS.heatpump, color: COLORS.heatpump, shape: "rect", key: "heatpump" },
    { label: CONSUMER_LABELS.bwwp, color: COLORS.bwwp, shape: "rect", key: "bwwp" },
    { label: CONSUMER_LABELS.ev, color: COLORS.ev, shape: "rect", key: "ev" },
    { label: "PV-Ertrag", color: COLORS.pv, shape: "line", key: "pv" },
    { label: "Netz-Import", color: COLORS.import, shape: "line", key: "import" },
    { label: "Batterie-SoC", color: COLORS.soc, shape: "line", key: "soc" },
  ];
  if (hasPriceData) hourlyLegend.push({ label: "Preis", color: COLORS.price, shape: "line", key: "price" });
  appendLegend(host, hourlyLegend, svg);
}

// ---- scenario comparison (export revenue vs import cost, net) --------------
export function renderScenarioChart(host: HTMLElement, data: ScenarioDatum[]): void {
  host.innerHTML = "";
  const W = 960;
  const H = 460;
  const m = { top: 44, right: 24, bottom: 64, left: 76 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const bound = niceScale(Math.max(1, ...data.map((d) => Math.max(d.exportEUR, d.importEUR))), 5).max;
  const zeroY = m.top + plotH / 2;
  const half = plotH / 2;
  const scale = (v: number) => zeroY - (v / bound) * half;

  // symmetric gridlines + € ticks
  for (const t of [-bound, -bound / 2, 0, bound / 2, bound]) {
    const y = scale(t);
    svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + plotW, y2: y, stroke: t === 0 ? COLORS.axis : COLORS.grid, "stroke-width": t === 0 ? 1.2 : 1 }));
    const lbl = el("text", { x: m.left - 10, y: y + 4, "text-anchor": "end", fill: COLORS.muted, "font-size": 11 });
    lbl.textContent = `${Math.round(t)}`;
    svg.appendChild(lbl);
  }

  const band = plotW / data.length;
  const barW = Math.min(58, band * 0.30);

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const gx = cx - barW - 4;
    const rx = cx + 4;

    // export revenue (green, up)
    const gH = (d.exportEUR / bound) * half;
    const grec = el("rect", { x: gx, y: zeroY - gH, width: barW, height: gH, fill: COLORS.exportK, rx: 3, class: "bar", "data-key": "export" });
    bindTip(grec, () => `<strong>${d.label}</strong><br>Export-Erlös: <b>${fmtEUR(d.exportEUR)}</b>`);
    svg.appendChild(grec);
    const gl = el("text", { x: gx + barW / 2, y: zeroY - gH - 6, "text-anchor": "middle", fill: COLORS.exportK, "font-size": 11 });
    gl.textContent = `${Math.round(d.exportEUR)}`;
    svg.appendChild(gl);

    // import cost (red, down)
    const rH = (d.importEUR / bound) * half;
    const rrec = el("rect", { x: rx, y: zeroY, width: barW, height: rH, fill: COLORS.import, rx: 3, class: "bar", "data-key": "import" });
    bindTip(rrec, () => `<strong>${d.label}</strong><br>Import-Kosten: <b>${fmtEUR(d.importEUR)}</b>`);
    svg.appendChild(rrec);
    const rl = el("text", { x: rx + barW / 2, y: zeroY + rH + 15, "text-anchor": "middle", fill: COLORS.import, "font-size": 11 });
    rl.textContent = `${Math.round(d.importEUR)}`;
    svg.appendChild(rl);

    // net label
    const netLbl = el("text", { x: cx, y: m.top + 16, "text-anchor": "middle", fill: d.netEUR >= 0 ? COLORS.net : COLORS.import, "font-size": 13, "font-weight": 700, "data-key": "net" });
    netLbl.textContent = `Netto ${fmtEUR(d.netEUR)}`;
    svg.appendChild(netLbl);

    const txt = el("text", { x: cx, y: m.top + plotH + 24, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 });
    txt.textContent = d.label;
    svg.appendChild(txt);
  });

  const yL = el("text", { x: m.left - 10, y: m.top - 18, "text-anchor": "start", fill: COLORS.muted, "font-size": 12 });
  yL.textContent = "Jahresbilanz je Tarifkombination (€)";
  svg.appendChild(yL);
  const hint = el("text", { x: m.left, y: H - 12, "text-anchor": "start", fill: COLORS.muted, "font-size": 11 });
  hint.textContent = "Blau = Export-Erlös (nach oben), Rot = Import-Kosten (nach unten). Netto = Erlös − Kosten.";
  svg.appendChild(hint);

  host.appendChild(svg);

  appendLegend(host, [
    { label: "Export-Erlös", color: COLORS.exportK, shape: "rect", key: "export" },
    { label: "Import-Kosten", color: COLORS.import, shape: "rect", key: "import" },
    { label: "Netto (Erlös−Kosten)", color: COLORS.net, shape: "line", key: "net" },
  ], svg);
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
  const W = 960;
  const H = 440;
  const m = { top: 40, right: 24, bottom: 52, left: 72 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const maxVal = niceScale(Math.max(1, ...data.map((d) => Math.max(d.netMarketEUR, d.fixedValueEUR))), 5).max;
  const scale = (v: number) => m.top + plotH - (v / maxVal) * plotH;
  const band = plotW / data.length;
  const barW = band * 0.3;

  for (let t = 0; t <= maxVal + 1e-6; t += maxVal / 5) {
    const y = scale(t);
    svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + plotW, y2: y, stroke: COLORS.grid, "stroke-width": 1 }));
    const lbl = el("text", { x: m.left - 10, y: y + 4, "text-anchor": "end", fill: COLORS.muted, "font-size": 11 });
    lbl.textContent = String(Math.round(t));
    svg.appendChild(lbl);
  }

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const netH = (d.netMarketEUR / maxVal) * plotH;
    const fixH = (d.fixedValueEUR / maxVal) * plotH;
    const net = el("rect", { x: cx - barW - 2, y: scale(d.netMarketEUR), width: barW, height: plotH - netH, fill: COLORS.net, rx: 2, class: "bar" });
    const fix = el("rect", { x: cx + 2, y: scale(d.fixedValueEUR), width: barW, height: plotH - fixH, fill: COLORS.fixed, rx: 2, class: "bar" });
    bindTip(net, () =>
      `<strong>${d.year}</strong><br>Direktvermarktung (netto): <b>${fmtEUR(d.netMarketEUR)}</b><br>` +
      `Ø Preis: ${Math.round(d.vwapEURperMWh)} €/MWh<br>Export: ${Math.round(d.exportKWh)} kWh<br>` +
      `Marktprämie: ${d.marktPraemieCt.toFixed(2)} ct/kWh`);
    bindTip(fix, () => `<strong>${d.year}</strong><br>Feste Einspeisung: <b>${fmtEUR(d.fixedValueEUR)}</b>`);
    svg.appendChild(net);
    svg.appendChild(fix);
    const nl = el("text", { x: cx - barW / 2 - 2, y: scale(d.netMarketEUR) - 6, "text-anchor": "middle", fill: COLORS.net, "font-size": 11 });
    nl.textContent = `${Math.round(d.netMarketEUR)}`;
    svg.appendChild(nl);
    const fl = el("text", { x: cx + barW / 2 + 2, y: scale(d.fixedValueEUR) - 6, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
    fl.textContent = `${Math.round(d.fixedValueEUR)}`;
    svg.appendChild(fl);
    const txt = el("text", { x: cx, y: m.top + plotH + 22, "text-anchor": "middle", fill: COLORS.text, "font-size": 13 });
    txt.textContent = d.year;
    svg.appendChild(txt);
    const sub = el("text", { x: cx, y: m.top + plotH + 38, "text-anchor": "middle", fill: COLORS.muted, "font-size": 10 });
    sub.textContent = `${Math.round(d.vwapEURperMWh)} €/MWh`;
    svg.appendChild(sub);
  });

  svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
  const yL = el("text", { x: m.left - 10, y: m.top - 16, "text-anchor": "start", fill: COLORS.muted, "font-size": 12 });
  yL.textContent = "Jahreserlös (€)";
  svg.appendChild(yL);
  const hint = el("text", { x: m.left, y: H - 8, "text-anchor": "start", fill: COLORS.muted, "font-size": 11 });
  hint.textContent = "Balken: Direktvermarktung (türkis) vs. feste Einspeisung (grau). Export-Vergleich über die Preisjahre.";
  svg.appendChild(hint);

  host.appendChild(svg);
}

// ---- tariff combinations (per year, per combination) -----------------------
export function renderTariffCombinationChart(host: HTMLElement, combo: TariffCombination): void {
  host.innerHTML = "";
  const W = 460;
  const H = 360;
  const m = { top: 40, right: 18, bottom: 56, left: 64 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });

  const data = combo.years;
  const bound = niceScale(Math.max(1, ...data.map((d) => Math.max(d.exportEUR, d.importEUR))), 5).max;
  const zeroY = m.top + plotH / 2;
  const half = plotH / 2;
  const scale = (v: number) => zeroY - (v / bound) * half;

  for (const t of [-bound, -bound / 2, 0, bound / 2, bound]) {
    const y = scale(t);
    svg.appendChild(el("line", { x1: m.left, y1: y, x2: m.left + plotW, y2: y, stroke: t === 0 ? COLORS.axis : COLORS.grid, "stroke-width": t === 0 ? 1.2 : 1 }));
    const lbl = el("text", { x: m.left - 10, y: y + 4, "text-anchor": "end", fill: COLORS.muted, "font-size": 10 });
    lbl.textContent = `${Math.round(t)}`;
    svg.appendChild(lbl);
  }

  const band = plotW / data.length;
  const barW = Math.min(30, band * 0.30);

  data.forEach((d, i) => {
    const cx = m.left + i * band + band / 2;
    const gx = cx - barW - 3;
    const rx = cx + 3;

    const gH = (d.exportEUR / bound) * half;
    const grec = el("rect", { x: gx, y: zeroY - gH, width: barW, height: gH, fill: COLORS.exportK, rx: 3, class: "bar", "data-key": "export" });
    bindTip(grec, () => `<strong>${combo.label} — ${d.year}</strong><br>Export-Erlös: <b>${fmtEUR(d.exportEUR)}</b><br>Export: ${Math.round(d.exportKWh)} kWh`);
    svg.appendChild(grec);

    const rH = (d.importEUR / bound) * half;
    const rrec = el("rect", { x: rx, y: zeroY, width: barW, height: rH, fill: COLORS.import, rx: 3, class: "bar", "data-key": "import" });
    bindTip(rrec, () => `<strong>${combo.label} — ${d.year}</strong><br>Import-Kosten: <b>${fmtEUR(d.importEUR)}</b><br>Import: ${Math.round(d.importKWh)} kWh`);
    svg.appendChild(rrec);

    const netLbl = el("text", { x: cx, y: m.top + 14, "text-anchor": "middle", fill: d.netEUR >= 0 ? COLORS.net : COLORS.import, "font-size": 11, "font-weight": 700, "data-key": "net" });
    netLbl.textContent = `Netto ${fmtEUR(d.netEUR)}`;
    svg.appendChild(netLbl);

    const txt = el("text", { x: cx, y: m.top + plotH + 20, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 });
    txt.textContent = d.year;
    svg.appendChild(txt);
  });

  const yL = el("text", { x: m.left - 10, y: m.top - 16, "text-anchor": "start", fill: COLORS.muted, "font-size": 11 });
  yL.textContent = "Jahresbilanz (€)";
  svg.appendChild(yL);

  host.appendChild(svg);
  appendLegend(host, [
    { label: "Export-Erlös", color: COLORS.exportK, shape: "rect", key: "export" },
    { label: "Import-Kosten", color: COLORS.import, shape: "rect", key: "import" },
    { label: "Netto (Erlös−Kosten)", color: COLORS.net, shape: "line", key: "net" },
  ], svg);
}

export function renderLegend(host: HTMLElement): void {
  host.innerHTML = "";
  const items: [string, string][] = [
    [CONSUMER_LABELS.household, COLORS.household],
    [CONSUMER_LABELS.heatpump, COLORS.heatpump],
    [CONSUMER_LABELS.bwwp, COLORS.bwwp],
    [CONSUMER_LABELS.ev, COLORS.ev],
    ["PV-Ertrag", COLORS.pv],
    ["Netz-Import", COLORS.import],
    ["Netto € (Monat)", COLORS.net],
    ["Batterie-SoC", COLORS.soc],
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
