// Hand-rolled SVG charts (no charting dependency) with interactive drill-down.
const SVGNS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs)
        e.setAttribute(k, String(attrs[k]));
    return e;
}
export const COLORS = {
    pv: "#cbd5e1",
    solarExport: "#22c55e",
    batteryExport: "#3b82f6",
    charge: "#f97316",
    price: "#ef4444",
    axis: "#94a3b8",
    text: "#334155",
};
export function renderMonthlyChart(host, data, selectedMonth, onSelect) {
    host.innerHTML = "";
    const W = 920;
    const H = 380;
    const m = { top: 30, right: 60, bottom: 40, left: 60 };
    const plotW = W - m.left - m.right;
    const plotH = H - m.top - m.bottom;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", width: "100%" });
    const maxPv = Math.max(1, ...data.map((d) => d.pvKWh));
    const maxVal = Math.max(1, ...data.map((d) => d.marketValueEUR));
    const band = plotW / data.length;
    // PV bars
    data.forEach((d, i) => {
        const x = m.left + i * band + band * 0.15;
        const w = band * 0.7;
        const h = (d.pvKWh / maxPv) * plotH;
        const y = m.top + plotH - h;
        const rect = el("rect", {
            x, y, width: w, height: h,
            fill: COLORS.pv,
            stroke: d.month === selectedMonth ? "#0f172a" : "none",
            "stroke-width": d.month === selectedMonth ? 2 : 0,
            class: "bar",
        });
        rect.addEventListener("click", () => onSelect(d.month));
        const t = el("title");
        t.textContent = `${d.label}: ${Math.round(d.pvKWh)} kWh PV, ${Math.round(d.exportKWh)} kWh export`;
        rect.appendChild(t);
        svg.appendChild(rect);
    });
    // market value line (right axis)
    const pts = data.map((d, i) => {
        const x = m.left + i * band + band / 2;
        const y = m.top + plotH - (d.marketValueEUR / maxVal) * plotH;
        return `${x},${y}`;
    });
    svg.appendChild(el("polyline", {
        points: pts.join(" "),
        fill: "none",
        stroke: COLORS.price,
        "stroke-width": 2,
    }));
    // axes + labels
    svg.appendChild(el("line", { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
    svg.appendChild(el("line", { x1: m.left + plotW, y1: m.top, x2: m.left + plotW, y2: m.top + plotH, stroke: COLORS.axis }));
    data.forEach((d, i) => {
        const x = m.left + i * band + band / 2;
        const txt = el("text", { x, y: m.top + plotH + 18, "text-anchor": "middle", fill: COLORS.text, "font-size": 12 });
        txt.textContent = d.label;
        svg.appendChild(txt);
    });
    const yLabel = el("text", { x: m.left - 10, y: m.top - 10, "text-anchor": "start", fill: COLORS.text, "font-size": 12 });
    yLabel.textContent = `PV max ${Math.round(maxPv)} kWh/mo`;
    svg.appendChild(yLabel);
    const vLabel = el("text", { x: m.left + plotW + 10, y: m.top - 10, "text-anchor": "end", fill: COLORS.price, "font-size": 12 });
    vLabel.textContent = `value € max ${Math.round(maxVal)}`;
    svg.appendChild(vLabel);
    host.appendChild(svg);
}
export function renderHourlyChart(host, data, monthLabel) {
    host.innerHTML = "";
    const W = 920;
    const H = 380;
    const m = { top: 30, right: 60, bottom: 40, left: 60 };
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
    const posScale = posH / maxPos;
    const negScale = negH / maxNeg;
    data.forEach((d, i) => {
        const x = m.left + i * band + band * 0.15;
        const w = band * 0.7;
        // PV produced (background)
        const pvH = d.pvKWh * posScale;
        svg.appendChild(el("rect", { x, y: zeroY - pvH, width: w, height: pvH, fill: COLORS.pv }));
        // solar export (stacked from 0)
        const sH = d.solarExportKWh * posScale;
        const bH = d.batteryExportKWh * posScale;
        svg.appendChild(el("rect", { x, y: zeroY - sH - bH, width: w, height: sH, fill: COLORS.solarExport }));
        svg.appendChild(el("rect", { x, y: zeroY - bH, width: w, height: bH, fill: COLORS.batteryExport }));
        // charge (downward)
        const cH = d.chargeKWh * negScale;
        svg.appendChild(el("rect", { x, y: zeroY, width: w, height: cH, fill: COLORS.charge }));
    });
    // price line (right axis)
    const pts = data.map((d, i) => {
        const x = m.left + i * band + band / 2;
        const y = m.top + posH - (d.avgPrice / maxPrice) * posH;
        return `${x},${y}`;
    });
    svg.appendChild(el("polyline", { points: pts.join(" "), fill: "none", stroke: COLORS.price, "stroke-width": 2 }));
    // zero line + axis
    svg.appendChild(el("line", { x1: m.left, y1: zeroY, x2: m.left + plotW, y2: zeroY, stroke: COLORS.axis }));
    svg.appendChild(el("line", { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: COLORS.axis }));
    for (let h = 0; h <= 24; h += 3) {
        const x = m.left + (h / 24) * plotW;
        const txt = el("text", { x, y: m.top + plotH + 18, "text-anchor": "middle", fill: COLORS.text, "font-size": 11 });
        txt.textContent = `${h}`;
        svg.appendChild(txt);
    }
    const t1 = el("text", { x: m.left - 10, y: m.top - 10, fill: COLORS.text, "font-size": 12 });
    t1.textContent = `${monthLabel} — kWh/h (up: produced/exported, down: charged)`;
    svg.appendChild(t1);
    const t2 = el("text", { x: m.left + plotW + 10, y: m.top - 10, "text-anchor": "end", fill: COLORS.price, "font-size": 12 });
    t2.textContent = `price €/MWh max ${Math.round(maxPrice)}`;
    svg.appendChild(t2);
    host.appendChild(svg);
}
export function renderLegend(host) {
    host.innerHTML = "";
    const items = [
        ["PV produced", COLORS.pv],
        ["Direct solar export", COLORS.solarExport],
        ["Battery export", COLORS.batteryExport],
        ["Battery charge", COLORS.charge],
        ["Market price", COLORS.price],
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
