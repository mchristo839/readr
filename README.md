# Readr

A personal PDF reader for Windows, macOS, and Linux with Ask AI through OpenRouter.

Readr is a fork of [Folio](https://github.com/Forward-Future/folio) by Forward Future (MIT licensed). It keeps Folio's
reader, highlights, notes, signing, and webpage-to-PDF features, and changes these things:

- **Ask AI with your own API key.** The **Haiku** tab uses an Anthropic API key and always sends requests to Claude
  Haiku 5.5, whatever else the key could reach. The **OpenRouter** tab uses an OpenRouter key with any model. Keys are
  stored encrypted with the system's secret store and never reach the page. ChatGPT sign-in and Claude Code are still
  there as extra tabs.
- **Spending limits.** Each key provider has a monthly limit inside the app and a cap on answer length, under **Limits**
  below the composer. For a hard stop on the provider's side, put the Anthropic key in its own Console workspace with a
  spend limit, or set a credit limit on the OpenRouter key. OpenRouter reports each answer's cost. For Haiku the app works
  it out from the token counts and Anthropic's published prices ($0.10 in and $0.50 out per million tokens, or $0.50 and
  $2.50 once a prompt is over 100,000 tokens), set in `electron/ai.cjs`.
- **No upstream update channel.** Updates and the Linux package no longer point at Folio's releases or apt repository.

## Build and run

Requires [Node.js](https://nodejs.org/) 22 or newer.

```
npm install
npm run app        # build and run the desktop app
npm run smoke      # end-to-end check
npm run dist:win   # or dist:mac, dist:linux, on that platform: installers land in release/
```

## Staying patched

`.github/workflows/readr-update.yml` runs every day and after every push to `main`:

1. Merges Folio's latest changes. Conflicts caused only by the Readr rename resolve on their own
   (`scripts/readr-sync.mjs`). A real clash opens a **Folio update needs a hand merge** issue, and dependency fixes
   keep shipping in the meantime.
2. Merges Dependabot pull requests whose checks passed (`scripts/readr-dependabot.mjs`).
3. Audits every dependency that ships in the app, Electron, React and pdf.js included (`scripts/readr-audit.mjs`).
   Findings open a **Security audit** issue. Folio's own CI audit skips those, since they're listed as devDependencies.
4. Runs the build, the unit tests, the Ask AI provider tests and the end-to-end smoke test. Nothing ships unless they pass.
5. Publishes a release with a higher version (`scripts/readr-version.mjs`): Folio 1.10.8 becomes Readr 1.10.800,
   1.10.801 and so on.

Installed copies check the latest release every four hours, download it, verify its SHA-512, and install it when you
click **Restart** (a .deb asks for your password). The AppImage replaces itself.

One-time setup on GitHub: enable Actions and Issues on the fork, turn on Dependabot alerts and security updates, and
add a `READR_BOT_TOKEN` secret (fine-grained token for this repository: Contents, Workflows, Pull requests and Issues
set to read and write) so merges that touch workflow files can be pushed.

Folio's original documentation is in [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party software keeps its own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
