// Config-surface duplication: how many source files hand-encode each wire key?
// Single-source codecs should score 1. Run from the repo root:
//   node tools/architecture-metrics/codec.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = await walk(path.join(ROOT, "src"));
const keys = ["kwp","tilt","o","loc","cap","pwr","minsoc","maxsoc","eff","soc0","charge","dsp","de","dm","evs","eve","mns","mne","fi","yr","py","hh","hk","wp","wk","bw","bwk","ev","ek","es","ex","im","ict","inv","hor","d","esc","om","invlife","invrep","batlife","batrep","batdeg","pvdeg","stdby","jaz","wpc","mm","km","dl","ec","wen","wc","wh","wt","wsm","expert"];
let total = 0;
const perKey = [];
for (const k of keys) {
  const needle = `"${k}"`;
  const hits = [];
  for (const f of files) {
    const t = await fs.readFile(f, "utf8");
    if (t.includes(needle)) hits.push(path.relative(ROOT, f));
  }
  total += hits.length;
  perKey.push([k, hits]);
}
perKey.sort((a, b) => b[1].length - a[1].length);
console.log("key | #src files with the literal | files");
for (const [k, hits] of perKey) console.log(`${k} | ${hits.length} | ${hits.join(", ")}`);
console.log(`\nAverage source files per wire key: ${(total / keys.length).toFixed(2)}`);
