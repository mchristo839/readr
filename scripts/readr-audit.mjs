// Audits the dependencies that ship inside Readr. Folio's CI runs `npm audit --omit=dev`, but this project lists
// Electron, React, pdf.js, KaTeX and the Markdown renderer as devDependencies because Vite bundles them, so that
// audit skips most of what users actually run. This one checks everything and ignores only advisories reached
// solely through build tools, which never ship.
//
// Usage: node scripts/readr-audit.mjs     Exits 1 and writes readr-audit.md when anything shipped is affected.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BUILD_ONLY = new Set(["electron-builder", "vite", "@vitejs/plugin-react", "typescript", "playwright-core",
  "@types/react", "@types/react-dom"]);
const SEVERITY = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const MIN = SEVERITY.moderate;

const run = spawnSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let audit;
try { audit = JSON.parse(run.stdout); } catch {
  console.error(`npm audit didn't return JSON:\n${run.stdout}${run.stderr}`);
  writeFileSync("readr-audit.md", "npm audit couldn't run, so the dependencies weren't checked. See the workflow log.\n");
  process.exit(1);
}
if (audit.error) {
  console.error(`npm audit failed: ${audit.error.summary ?? JSON.stringify(audit.error)}`);
  writeFileSync("readr-audit.md", `npm audit failed: ${audit.error.summary ?? "see the workflow log"}.\n`);
  process.exit(1);
}
const vulns = audit.vulnerabilities ?? {};
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const shippedRoots = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}).filter((d) => !BUILD_ONLY.has(d))];

// Every package reachable from what ships, by walking the installed tree from those roots.
const tree = JSON.parse(spawnSync("npm", ["ls", "--all", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout || "{}");
const reach = new Map(); // package name -> the shipped roots it comes in through
function walk(node, root, seen) {
  for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
    const key = `${name}@${child.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!reach.has(name)) reach.set(name, new Set());
    reach.get(name).add(root);
    walk(child, root, seen);
  }
}
for (const root of shippedRoots) {
  const node = tree.dependencies?.[root];
  if (!node) continue;
  if (!reach.has(root)) reach.set(root, new Set());
  reach.get(root).add(root);
  walk(node, root, new Set());
}
if (!reach.size) {
  writeFileSync("readr-audit.md", "Couldn't read the installed dependency tree, so the audit can't tell what ships. See the workflow log.\n");
  console.error("npm ls returned no tree.");
  process.exit(1);
}

const shipped = [];
let ignored = 0;
for (const [name, v] of Object.entries(vulns)) {
  if ((SEVERITY[v.severity] ?? 0) < MIN) continue;
  if (!reach.has(name)) { ignored++; continue; }
  const via = [...reach.get(name)];
  const advisories = (v.via ?? []).filter((x) => typeof x === "object")
    .map((x) => `[${x.title}](${x.url})`).filter((x, i, a) => a.indexOf(x) === i);
  const fix = v.fixAvailable === true ? "yes" : v.fixAvailable ? `yes, ${v.fixAvailable.name} ${v.fixAvailable.version}` : "not yet";
  shipped.push({ name, severity: v.severity, via, advisories, fix });
}

console.log(`Shipped dependencies with moderate or worse advisories: ${shipped.length}. Advisories only in build tools, ignored: ${ignored}.`);
if (!shipped.length) process.exit(0);
shipped.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
const lines = ["### Vulnerable dependencies that ship in Readr", "",
  "| Package | Severity | Comes in through | Fix | Advisory |", "| --- | --- | --- | --- | --- |",
  ...shipped.map((s) => `| ${s.name} | ${s.severity} | ${s.via.join(", ")} | ${s.fix} | ${s.advisories.join("<br>") || "see npm audit"} |`),
  "", "Dependabot opens a pull request when a fixed version exists, and the daily update merges it once its checks pass.",
  "If the fix column says \"not yet\", there's nothing to install until the package's maintainers ship one.", ""];
writeFileSync("readr-audit.md", lines.join("\n"));
for (const s of shipped) console.log(`${s.severity.padEnd(8)} ${s.name} via ${s.via.join(", ")} (fix: ${s.fix})`);
process.exit(1);
