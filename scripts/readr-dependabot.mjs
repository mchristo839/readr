// Merges open Dependabot pull requests whose checks all passed into the local main branch, run by
// .github/workflows/readr-update.yml before the full test suite. A pull request that conflicts is skipped:
// Dependabot rebases it once main moves on, and a later run takes it. Once the workflow pushes main, GitHub
// marks the merged pull requests as merged.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); };
const report = (line) => appendFileSync("readr-report.md", line + "\n");

const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const prs = JSON.parse(gh("pr", "list", "--state", "open", "--author", "app/dependabot", "--limit", "20",
  "--json", "number,title,headRefName,headRefOid"));
const merged = [];
for (const pr of prs) {
  const { statusCheckRollup: checks = [], headRefOid } = JSON.parse(gh("pr", "view", String(pr.number), "--json", "statusCheckRollup,headRefOid"));
  const done = checks.length > 0 && checks.every((c) => (c.status ?? "COMPLETED") === "COMPLETED" && OK.has(c.conclusion ?? c.state));
  if (!done) { console.log(`#${pr.number} skipped: checks haven't all passed yet.`); continue; }
  if (git("fetch", "-q", "origin", pr.headRefName).status !== 0) { console.log(`#${pr.number} skipped: couldn't fetch its branch.`); continue; }
  if (git("rev-parse", "FETCH_HEAD").stdout.trim() !== headRefOid) { console.log(`#${pr.number} skipped: its branch changed after the checks ran.`); continue; }
  const m = git("merge", "--no-ff", "-q", "-m", `Merge Dependabot: ${pr.title} (#${pr.number})`, "FETCH_HEAD");
  if (m.status !== 0) {
    git("merge", "--abort");
    console.log(`#${pr.number} skipped: it conflicts with main. Dependabot will rebase it.`);
    continue;
  }
  merged.push(pr);
  console.log(`#${pr.number} merged: ${pr.title}`);
}
if (merged.length) {
  report("### Dependency updates\n");
  for (const pr of merged) report(`- ${pr.title} (#${pr.number})`);
  report("");
}
output("merged", String(merged.length));
