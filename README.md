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

- Dependabot opens a weekly pull request for npm and a monthly one for GitHub Actions.
- CI runs `npm audit` on runtime dependencies on every push and fails on moderate or higher findings.
- To take Folio's fixes, add it as a remote and merge: `git remote add upstream https://github.com/Forward-Future/folio`,
  then `git fetch upstream && git merge upstream/main`. Expect small conflicts in files that mention the app name.

Folio's original documentation is in [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party software keeps its own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
