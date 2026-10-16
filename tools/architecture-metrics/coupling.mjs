// Architecture coupling metrics (fan-in/fan-out, instability, cycles, god
// modules). Run from the repo root:  node tools/architecture-metrics/coupling.mjs
//
// Afferent coupling  Ca = incoming deps (fan-in)
// Efferent coupling  Ce = outgoing deps (fan-out)
// Instability        I  = Ce / (Ca + Ce)   (0 = stable, 1 = volatile)
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = await walk(SRC);
const stats = new Map();
const importRe = /import\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*["']([^"']+)["']/g;
const exportRe = /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum|let|var)\s+([A-Za-z0-9_]+)/g;
const reExportRe = /export\s+(?:type\s+)?\{([^}]*)\}/g;
const fnRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;

for (const f of files) {
  const text = await fs.readFile(f, "utf8");
  const rel = path.relative(ROOT, f);
  const loc = text.split("\n").length;
  const imports = new Set();
  let m;
  while ((m = importRe.exec(text))) imports.add(m[1]);
  const exports = new Set();
  while ((m = exportRe.exec(text))) exports.add(m[1]);
  while ((m = reExportRe.exec(text))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exports.add(name);
    }
  }
  const fns = [];
  while ((m = fnRe.exec(text))) fns.push(m[1]);
  stats.set(rel, { loc, imports, exports, fns });
}

function resolveImport(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.join(path.dirname(path.join(ROOT, fromRel)), spec);
  for (const cand of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
    const r = path.relative(ROOT, cand);
    if (stats.has(r)) return r;
  }
  return null;
}

const deps = new Map();
const rdeps = new Map();
for (const rel of stats.keys()) { deps.set(rel, new Set()); rdeps.set(rel, new Set()); }
for (const [rel, s] of stats) {
  for (const spec of s.imports) {
    const t = resolveImport(rel, spec);
    if (!t) continue;
    deps.get(rel).add(t);
    rdeps.get(t).add(rel);
  }
}

console.log("=== PER-FILE METRICS (loc | out-deps | in-deps | instability | exports | fns) ===");
const rows = [...stats.entries()].map(([rel, s]) => ({
  rel, loc: s.loc,
  out: deps.get(rel).size,
  in: rdeps.get(rel).size,
  exports: s.exports.size,
  fns: s.fns.length,
}));
rows.sort((a, b) => b.loc - a.loc);
for (const r of rows) {
  const I = r.out + r.in === 0 ? 0 : r.out / (r.out + r.in);
  console.log(
    `${String(r.loc).padStart(5)} | out ${String(r.out).padStart(2)} | in ${String(r.in).padStart(2)} | I=${I.toFixed(2)} | exp ${String(r.exports).padStart(3)} | fn ${String(r.fns).padStart(3)} | ${r.rel}`
  );
}

console.log("\n=== TOP FAN-IN (afferent coupling) ===");
rows.sort((a, b) => b.in - a.in);
for (const r of rows.slice(0, 12)) console.log(`${String(r.in).padStart(3)}  ${r.rel}`);

console.log("\n=== TOP FAN-OUT (efferent coupling) ===");
rows.sort((a, b) => b.out - a.out);
for (const r of rows.slice(0, 12)) console.log(`${String(r.out).padStart(3)}  ${r.rel}`);

console.log("\n=== CIRCULAR DEPENDENCY CYCLES ===");
const cycles = [];
const seen = new Set();
function dfs(node, stack, visited) {
  stack.push(node);
  visited.add(node);
  for (const nb of deps.get(node)) {
    if (stack.includes(nb)) {
      const cyc = stack.slice(stack.indexOf(nb)).concat(nb);
      const key = [...cyc].sort().join("|");
      if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
    } else if (!visited.has(nb)) {
      dfs(nb, stack, visited);
    }
  }
  stack.pop();
}
for (const rel of stats.keys()) if (!seen.has(rel)) dfs(rel, [], new Set());
if (cycles.length === 0) console.log("(none)");
for (const c of cycles) console.log(c.join(" -> "));

const totalLoc = rows.reduce((a, r) => a + r.loc, 0);
console.log(`\nFiles: ${rows.length}, total LOC: ${totalLoc}`);
