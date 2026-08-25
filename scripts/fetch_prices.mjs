import { writeFileSync } from "fs";

const tz = "Europe/Berlin";
function berlinParts(unix) {
  const d = new Date(unix * 1000);
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t) => s.find((p) => p.type === t).value;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  return { year: +get("year"), month: +get("month"), day: +get("day"), hour };
}

const start = "2023-01-01", end = "2027-01-01";
const url = `https://api.energy-charts.info/price?start=${start}&end=${end}`;
const r = await fetch(url);
const j = await r.json();
const ts = j.unix_seconds, price = j.price;
console.log("fetched points:", ts.length);

const HOURS = 8760;
const byYear = { 2023: new Array(HOURS).fill(null), 2024: new Array(HOURS).fill(null), 2025: new Array(HOURS).fill(null), 2026: new Array(HOURS).fill(null) };

for (let k = 0; k < ts.length; k++) {
  const p = price[k];
  if (p == null) continue;
  const { year, month, day, hour } = berlinParts(ts[k]);
  if (!byYear[year]) continue;
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const thisDate = new Date(Date.UTC(year, month - 1, day));
  const doy = Math.floor((thisDate - startOfYear) / 86400000);
  const idx = doy * 24 + hour;
  if (idx >= 0 && idx < HOURS) {
    if (byYear[year][idx] == null) byYear[year][idx] = p;
    else byYear[year][idx] = (byYear[year][idx] + p) / 2; // DST overlap -> average
  }
}

// Fill missing hours in 2026 (and any gaps) using average of 2023-2025 at same hour-of-year.
for (let i = 0; i < HOURS; i++) {
  const avail = [2023, 2024, 2025].map((y) => byYear[y][i]).filter((v) => v != null);
  const avg = avail.length ? avail.reduce((a, b) => a + b, 0) / avail.length : 0;
  for (const y of [2023, 2024, 2025, 2026]) {
    if (byYear[y][i] == null) byYear[y][i] = Math.round(avg * 10) / 10;
  }
}

// Report completeness
for (const y of [2023, 2024, 2025, 2026]) {
  const nulls = byYear[y].filter((v) => v == null).length;
  const avg = byYear[y].reduce((a, b) => a + b, 0) / HOURS;
  const neg = byYear[y].filter((v) => v <= 0).length;
  console.log(`year ${y}: avg=${avg.toFixed(1)} €/MWh, nulls=${nulls}, nonpos=${neg}`);
}

const out = {};
for (const y of [2023, 2024, 2025, 2026]) out[String(y)] = byYear[y];
writeFileSync("src/data/prices.json", JSON.stringify(out));
console.log("wrote src/data/prices.json");
