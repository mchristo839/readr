// Merges Folio's main branch (upstream) into Readr, run daily by .github/workflows/readr-update.yml.
//
// Readr renames Folio's user-facing text (see brand() below), so many upstream edits land on lines Readr changed
// only by renaming them. Those conflicts are resolved by redoing the three-way merge with the same renaming applied
// to Folio's side too: a line Readr only renamed then matches, and Folio's edit goes through. Anything that still
// conflicts is a real clash, so the merge stops and the workflow opens an issue.
//
// Usage: node scripts/readr-sync.mjs            (merges upstream/main; UPSTREAM_REF overrides it)
// Writes readr-report.md for the release notes or the issue, and sets the step outputs merged (false, true or
// conflict), folio_version and workflows_changed.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const UPSTREAM = process.env.UPSTREAM_REF || "upstream/main";
const REPORT = "readr-report.md";
// Readr's own versions always win: these describe the fork, not Folio.
const KEEP_OURS = new Set(["README.md"]);
// Folio's release pipeline publishes to Folio's repositories, so the fork doesn't carry it.
const DROPPED = new Set([".github/workflows/release-build.yml", ".github/workflows/release-check.yml"]);

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const tryGit = (...args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); };
const report = (line) => appendFileSync(REPORT, line + "\n");

/** The renaming Readr applies to Folio's files. It must be idempotent: applying it twice changes nothing. */
export function brand(file, text) {
  if (/^(src|electron)\//.test(file) || file === "index.html") {
    return text.replace(/Forward-Future\/folio-releases/g, "mchristo839/readr").replace(/Folio/g, "Readr");
  }
  if (file === "scripts/smoke-test.mjs") return text.replace(/About Folio/g, "About Readr");
  return text;
}

const BRANDED = (file) => /^(src|electron)\/.*\.(tsx?|cjs|mjs|js|css|html)$/.test(file) || file === "index.html" || file === "scripts/smoke-test.mjs";

function stage(n, file) {
  const r = tryGit("show", `:${n}:${file}`);
  return r.status === 0 ? r.stdout : null;
}

function main() {
  if (tryGit("merge-base", "--is-ancestor", UPSTREAM, "HEAD").status === 0) {
    console.log(`Readr already includes ${UPSTREAM}.`);
    output("merged", "false");
    return;
  }
  const version = JSON.parse(git("show", `${UPSTREAM}:package.json`)).version;
  const subjects = git("log", "--no-merges", "--format=%s", `HEAD..${UPSTREAM}`).split("\n").filter(Boolean);
  const merge = tryGit("merge", "--no-commit", "--no-ff", UPSTREAM);
  const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  if (merge.status !== 0 && !conflicted.length) {
    tryGit("merge", "--abort");
    throw new Error(`git merge failed:\n${merge.stdout}${merge.stderr}`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "readr-sync-"));
  const unresolved = [];
  for (const file of conflicted) {
    if (DROPPED.has(file)) { tryGit("rm", "-q", "--cached", "--ignore-unmatch", file); rmSync(file, { force: true }); continue; }
    if (KEEP_OURS.has(file) || file === "package-lock.json") { git("checkout", "--ours", "--", file); git("add", "--", file); continue; }
    const base = stage(1, file), ours = stage(2, file), theirs = stage(3, file);
    if (base === null || ours === null || theirs === null) { unresolved.push(`${file} (added or deleted on one side)`); continue; }
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => path.join(tmp, n));
    writeFileSync(o, ours);
    writeFileSync(b, brand(file, base));
    writeFileSync(t, brand(file, theirs));
    const redo = spawnSync("git", ["merge-file", "-p", o, b, t], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (redo.status === 0) {
      writeFileSync(file, redo.stdout);
      git("add", "--", file);
    } else {
      unresolved.push(file);
    }
  }
  rmSync(tmp, { recursive: true, force: true });

  if (unresolved.length) {
    tryGit("merge", "--abort");
    report(`### Folio ${version} needs a hand merge\n\nThese files changed in both Folio and Readr in ways that can't be combined automatically:\n`);
    for (const f of unresolved) report(`- \`${f}\``);
    report(`\nNothing from Folio ${version} was merged. Ask Claude to merge \`upstream/main\` into \`main\` and resolve these files.\n`);
    // Not a failure of the run: dependency fixes still ship on Readr's current code while the merge waits.
    console.error(`Unresolved: ${unresolved.join(", ")}`);
    output("merged", "conflict");
    return;
  }

  // Folio's release workflows stay out even when Folio didn't touch them in this merge.
  for (const file of DROPPED) if (existsSync(file)) { git("rm", "-q", "--", file); }
  // New text from Folio gets the Readr name too.
  for (const file of git("ls-files").split("\n").filter(BRANDED)) {
    const text = readFileSync(file, "utf8");
    const next = brand(file, text);
    if (next !== text) { writeFileSync(file, next); git("add", "--", file); }
  }
  // Readr's lockfile was kept; let npm bring it in line with the merged package.json.
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit" });
  git("add", "package-lock.json");
  git("commit", "-q", "--no-edit", "-m", `Merge Folio ${version} into Readr`);

  report(`### Folio ${version}\n`);
  for (const s of subjects.slice(0, 40)) report(`- ${s}`);
  report("");
  // Any commit touching a workflow file needs a token with the workflows permission to be pushed.
  const workflows = git("log", "--format=", "--name-only", "HEAD^1..HEAD", "--", ".github/workflows");
  output("merged", "true");
  output("folio_version", version);
  output("workflows_changed", workflows ? "true" : "false");
  console.log(`Merged Folio ${version} (${subjects.length} commits).`);
}

main();
