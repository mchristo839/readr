# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, report them privately through
[GitHub's private vulnerability reporting](https://github.com/mchristo839/marginalia/security/advisories/new).

Include the Folio version (shown in **About Folio**), what an attacker could do, and steps or a sample PDF that
reproduce it. You can expect an acknowledgement within a week. Fixes ship as a new release that installed copies pick
up automatically.

## Supported versions

Only the latest release receives security fixes. Installed copies update automatically unless automatic updates are
turned off in **Settings**. Portable copies must be updated manually.

## Security model

Folio opens untrusted PDFs, so it's built to keep a malicious document contained:

- PDFs are parsed and rendered by [pdf.js](https://github.com/mozilla/pdf.js). PDF JavaScript and XFA forms are not run.
- The interface runs in a sandboxed Electron renderer with context isolation, no Node.js access, and a strict
  Content Security Policy. Only a small, validated set of calls into the main process is exposed, and only to Folio's
  own page.
- Links inside PDFs open in your default browser; Folio never navigates its own window away from the app.
- Webpages opened from a link are loaded in a separate hidden window: sandboxed, no Node.js or preload, a throwaway
  in-memory session per page, every permission denied, pop-ups and downloads blocked, only http(s)/data/blob requests
  allowed, no requests into local-network addresses when the page itself is public, and a 60-second limit. Only the
  printed PDF reaches Folio.
- Electron fuses disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, and inspector flags, and require app code to load
  from an integrity-checked archive.
- Printing hands the document to Chromium's built-in PDF viewer.
- **Ask AI** runs entirely in the main process. ChatGPT uses OpenAI's Sign in with ChatGPT (OAuth 2.0 with PKCE, a
  loopback redirect on `127.0.0.1`, state and nonce checks, and ID-token signature verification). Tokens are encrypted
  with Electron `safeStorage` (Windows DPAPI, the macOS Keychain, or the Linux secret store; kept in memory only when
  no secret store is available) and never reach the page. Claude runs the user's own, unmodified Claude
  Code CLI with all tools, MCP servers, settings, and slash commands disabled, in an empty temporary folder; Folio never
  handles Claude credentials. Document text goes to the chosen provider only when the user asks a question.

Known limitations:

- **Builds aren't signed with developer certificates yet.** Windows builds are unsigned and macOS builds are ad-hoc
  signed (not notarized); the release build signs both automatically once the certificates are added (see
  [SIGNING.md](SIGNING.md)). Installers are built on GitHub Actions from this repository. Updates are downloaded over
  HTTPS from [Forward-Future/folio-releases](https://github.com/Forward-Future/folio-releases) and checked against the
  SHA-512 published with each release, but without a signature the update channel is only as secure as that GitHub
  account. Until Mac builds are signed, Macs don't install updates automatically: Folio announces new versions, which
  are downloaded from the releases page.
- The Linux apt repository (published with each release) is signed with Folio's own key (fingerprint
  `B337 6868 EE22 8389 6C2B  8ABD C455 276C CAE0 3757`), installed by the .deb as
  `/usr/share/keyrings/folio-archive-keyring.gpg` and used only for Folio's source (`signed-by`). apt rejects any
  repository metadata not signed with it.
- Local data (recent files, reading positions, an optionally remembered signature) is stored unencrypted in your user
  profile. See [Privacy](README.md#privacy).
