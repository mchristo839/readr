// Opens, updates or closes the issue the daily update uses to report a problem.
//
// node scripts/readr-issue.mjs open "<title>" [body file]   opens it, or comments on the open one with that title
// node scripts/readr-issue.mjs close "<title>"              closes the open one, saying the latest run worked
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [action, title, bodyFile] = process.argv.slice(2);
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const run = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const open = JSON.parse(gh("issue", "list", "--state", "open", "--limit", "50", "--json", "number,title"))
  .find((i) => i.title === title);

if (action === "close") {
  if (open) gh("issue", "close", String(open.number), "--comment", `The latest daily update worked: ${run}`);
} else {
  const details = bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, "utf8").trim() : "";
  const body = [details || "A step of the daily update failed before anything shipped.", "",
    `Workflow run: ${run}`, "", "Installed copies keep the version they have until a run succeeds."].join("\n");
  if (open) gh("issue", "comment", String(open.number), "--body", body);
  else gh("issue", "create", "--title", title, "--body", body);
}
