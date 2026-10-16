// Shotgun surgery: for each domain parameter, how many files must know about
// it? Run from the repo root:
//   node tools/architecture-metrics/shotgun.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") await walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...(await walk(path.join(ROOT, "src"))), ...(await walk(path.join(ROOT, "tests")))];
const contents = new Map();
for (const f of files) contents.set(path.relative(ROOT, f), await fs.readFile(f, "utf8"));

// config field -> search terms (identifier + its wire key)
const fields = [
  ["peakKWp", ["peakKWp", '"kwp"', "\\bkwp\\b"]],
  ["tiltDeg", ["tiltDeg", '"tilt"']],
  ["orientation", ["orientation", '"o"']],
  ["location", ["location", '"loc"']],
  ["capacityKWh", ["capacityKWh", '"cap"']],
  ["maxPowerKW", ["maxPowerKW", '"pwr"']],
  ["minSOC", ["minSOC", '"minsoc"']],
  ["maxSOC", ["maxSOC", '"maxsoc"']],
  ["efficiency", ["\\befficiency\\b", '"eff"']],
  ["startSOC", ["startSOC", '"soc0"']],
  ["chargeMode", ["chargeMode", '"charge"']],
  ["dischargeMode", ["dischargeMode", '"dsp"']],
  ["eveningStart", ["eveningStart", '"evs"']],
  ["feedInCt", ["feedInCt", '"fi"']],
  ["commissioningYear", ["commissioningYear", '"yr"']],
  ["priceYear", ["priceYear", '"py"']],
  ["heatpumpJaz", ["heatpumpJaz", '"jaz"']],
  ["marketMarginCt", ["marketMarginCt", '"mm"']],
  ["windEnabled", ["windEnabled", '"wen"']],
  ["windCount", ["windCount", '"wc"']],
  ["windHubHeightM", ["windHubHeightM", '"wh"']],
  ["windTurbineId", ["windTurbineId", '"wt"']],
  ["windSpeedMeanMs", ["windSpeedMeanMs", '"wsm"']],
  ["horizonYears", ["horizonYears", '"hor"']],
  ["discountRatePct", ["discountRatePct", '"d"']],
  ["batteryDegradationPct", ["batteryDegradationPct", '"batdeg"']],
  ["standbyWattage", ["standbyWattage", '"stdby"']],
  ["investmentEUR", ["investmentEUR", '"inv"']],
];

console.log("field | #files | #non-test files | #test files | non-test files touched");
let totalFiles = 0;
for (const [name, pats] of fields) {
  const hits = new Map();
  for (const [rel, text] of contents) {
    let n = 0;
    for (const p of pats) n += (text.match(new RegExp(p, "g")) || []).length;
    if (n > 0) hits.set(rel, n);
  }
  const nonTest = [...hits.keys()].filter((k) => !k.startsWith("tests/"));
  const test = [...hits.keys()].filter((k) => k.startsWith("tests/"));
  totalFiles += nonTest.length;
  console.log(`${name} | ${hits.size} | ${nonTest.length} | ${test.length} | ${nonTest.join(", ")}`);
}
console.log(`\nAverage non-test files touched per parameter: ${(totalFiles / fields.length).toFixed(1)}`);
