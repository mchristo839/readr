// Opens, updates or closes the issue the daily update uses to report a problem. Uses the REST API only.
//
// node scripts/readr-issue.mjs open "<title>" [body file]   opens it, or comments on the open one with that title
// node scripts/readr-issue.mjs close "<title>"              closes the open one, saying the latest run worked
//
// If Issues are turned off for the repository, it says so in the run (as a warning) instead of failing it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [action, title, bodyFile] = process.argv.slice(2);
const REPO = process.env.GITHUB_REPOSITORY || "mchristo839/readr";
const run = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`;
const api = (path, ...fields) => JSON.parse(execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path, ...fields], { encoding: "utf8" }) || "null");

const repo = api(`repos/${REPO}`);
if (!repo.has_issues) {
  console.log(`::warning title=Issues are off::Turn on Issues in the repository settings so the daily update can report: ${title}`);
  process.exit(0);
}
// The issues list also returns pull requests; those have a pull_request field.
const open = api(`repos/${REPO}/issues?state=open&per_page=100`).find((i) => !i.pull_request && i.title === title);

if (action === "close") {
  if (open) {
    api(`repos/${REPO}/issues/${open.number}/comments`, "-f", `body=The latest daily update worked: ${run}`);
    api(`repos/${REPO}/issues/${open.number}`, "-X", "PATCH", "-f", "state=closed");
  }
} else {
  const details = bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, "utf8").trim() : "";
  const body = [details || "A step of the daily update failed before anything shipped.", "",
    `Workflow run: ${run}`, "", "Installed copies keep the version they have until a run succeeds."].join("\n");
  if (open) api(`repos/${REPO}/issues/${open.number}/comments`, "-f", `body=${body}`);
  else api(`repos/${REPO}/issues`, "-f", `title=${title}`, "-f", `body=${body}`);
}
