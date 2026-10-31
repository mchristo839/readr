// Merges open Dependabot pull requests whose checks all passed into the local main branch, run by
// .github/workflows/readr-update.yml before the full test suite. A pull request that conflicts is skipped:
// Dependabot rebases it once main moves on, and a later run takes it. Once the workflow pushes main, GitHub
// marks the merged pull requests as merged. Uses the REST API only.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY || "mchristo839/readr";
const api = (path) => JSON.parse(execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); };
const report = (line) => appendFileSync("readr-report.md", line + "\n");

const OK = new Set(["success", "neutral", "skipped"]);

/** True when every check run and commit status on `sha` has finished and passed. */
function passed(sha) {
  const runs = api(`repos/${REPO}/commits/${sha}/check-runs?per_page=100`).check_runs ?? [];
  const statuses = api(`repos/${REPO}/commits/${sha}/status`).statuses ?? [];
  if (!runs.length && !statuses.length) return false;
  return runs.every((r) => r.status === "completed" && OK.has(r.conclusion)) && statuses.every((s) => s.state === "success");
}

const prs = api(`repos/${REPO}/pulls?state=open&per_page=50`).filter((p) => p.user?.login === "dependabot[bot]");
const merged = [];
for (const pr of prs) {
  const sha = pr.head.sha;
  if (!passed(sha)) { console.log(`#${pr.number} skipped: its checks haven't all passed yet.`); continue; }
  if (git("fetch", "-q", "origin", `refs/pull/${pr.number}/head`).status !== 0) { console.log(`#${pr.number} skipped: couldn't fetch it.`); continue; }
  if (git("rev-parse", "FETCH_HEAD").stdout.trim() !== sha) { console.log(`#${pr.number} skipped: it changed after its checks ran.`); continue; }
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
console.log(`Open Dependabot pull requests: ${prs.length}, merged now: ${merged.length}.`);
output("merged", String(merged.length));
