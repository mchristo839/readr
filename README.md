# Readr

A personal PDF reader for Windows, macOS, and Linux with Ask AI through OpenRouter.

Readr is a fork of [Folio](https://github.com/Forward-Future/folio) by Forward Future (MIT licensed). It keeps Folio's
reader, highlights, notes, signing, and webpage-to-PDF features, and changes these things:

- **Ask AI runs on OpenRouter.** Paste your own key in the Ask AI panel and pick any model. The key is stored encrypted
  with the system's secret store and never reaches the page. ChatGPT sign-in and Claude Code are still there as extra tabs.
- **Spending limits.** Set a credit limit on the key at openrouter.ai (a hard stop on their side), a monthly limit inside
  the app (tracked from the cost OpenRouter reports for each answer), and a cap on answer length. Limits are under
  **Limits** below the composer.
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

- Dependabot opens a weekly pull request for npm and a monthly one for GitHub Actions.
- CI runs `npm audit` on runtime dependencies on every push and fails on moderate or higher findings.
- To take Folio's fixes, add it as a remote and merge: `git remote add upstream https://github.com/Forward-Future/folio`,
  then `git fetch upstream && git merge upstream/main`. Expect small conflicts in files that mention the app name.

Folio's original documentation is in [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party software keeps its own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
