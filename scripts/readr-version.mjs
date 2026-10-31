// Decides whether main needs a new Readr release and picks its version.
//
// Readr follows Folio's version but needs a higher number for every release of its own, including ones that only
// update dependencies. Folio 1.10.8 becomes Readr 1.10.800, 1.10.801, and so on, and Folio 1.10.9 starts again at
// 1.10.900. Installed copies (and dpkg) see each one as newer than the last.
//
// Usage: node scripts/readr-version.mjs [--force]
// Sets the step outputs release (true/false) and version, and writes release-notes.md.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); };
const force = process.argv.includes("--force");

const [major, minor, patch] = JSON.parse(readFileSync("package.json", "utf8")).version.split(/[.+-]/).map(Number);
if (![major, minor, patch].every(Number.isInteger)) throw new Error("package.json has no plain x.y.z version.");
const parse = (tag) => { const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag); return m ? m.slice(1).map(Number) : null; };
// Readr's own tags have a patch number of 100 or more; Folio's tags (copied when the fork was made) don't.
const ours = git("tag", "-l", "v*").split("\n").map((t) => ({ tag: t, v: parse(t) })).filter((t) => t.v && t.v[2] >= 100);
const newest = ours.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]).at(-1);

if (newest && !force) {
  const shipped = git("diff", "--name-only", newest.tag, "HEAD").split("\n").filter(Boolean)
    .filter((f) => !/\.md$/i.test(f) && !f.startsWith(".github/") && !/^scripts\/(readr-|test-)/.test(f) && f !== "LICENSE");
  if (!shipped.length) {
    console.log(`Nothing that ships has changed since ${newest.tag}.`);
    output("release", "false");
    process.exit(0);
  }
}

const same = ours.filter((t) => t.v[0] === major && t.v[1] === minor && Math.floor(t.v[2] / 100) === patch).map((t) => t.v[2]);
const next = same.length ? Math.max(...same) + 1 : patch * 100;
if (next >= (patch + 1) * 100) throw new Error(`Readr has used every release number for Folio ${major}.${minor}.${patch}.`);
const version = `${major}.${minor}.${next}`;
if (newest && spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${version}`]).status === 0) throw new Error(`v${version} already exists.`);

const notes = [`Readr ${version}, based on Folio ${major}.${minor}.${patch}.`, ""];
if (existsSync("readr-report.md")) notes.push(readFileSync("readr-report.md", "utf8").trim(), "");
const log = git("log", "--no-merges", "--format=- %s", ...(newest ? [`${newest.tag}..HEAD`] : ["-20"])).split("\n").filter(Boolean);
if (log.length) notes.push("### All changes", "", ...log.slice(0, 60), "");
notes.push("Install or update on Linux Mint: download `Readr-linux-amd64.deb`, then run `sudo apt install ./Readr-linux-amd64.deb`.",
  "Installed copies find this release on their own and install it when you click Restart.", "");
writeFileSync("release-notes.md", notes.join("\n"));
console.log(`Next release: v${version}`);
output("release", "true");
output("version", version);
