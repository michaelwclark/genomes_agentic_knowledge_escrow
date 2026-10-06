# Knowledge Escrow (Codex plugin)

Your knowledge, held in escrow until the moment it's needed.

Remembers decisions, commitments, and notes about people across chats, and
surfaces them again when relevant. Everything stays on your own computer —
no API keys, no Node install, no network calls at runtime. Sensitive
customer personal data (SSNs, account numbers, dates of birth, etc.) is
redacted automatically before anything is saved.

This directory is a **source template**, not the installable plugin. The
installable plugin (with a bundled server, embedding model, and MCP binary)
is produced by `npm run build:codex-plugin` from the repo root, which writes
`release/codex-marketplace/` — a local Codex plugin marketplace containing
this plugin fully packaged for the current machine's OS/arch.

## Building

```sh
npm run build:codex-plugin
```

This runs the TypeScript build, fetches/verifies the local embedding model,
bundles the MCP server into a single CommonJS file, builds a Node
single-executable application for the host OS/arch, and assembles
`release/codex-marketplace/` as a git repository Codex can add directly.

## Installing locally

```sh
codex plugin marketplace add /absolute/path/to/release/codex-marketplace
codex plugin add knowledge-escrow@knowledge-escrow
```

## Notes

- **Memory hooks.** The plugin declares a `SessionStart` hook (reminds the
  agent to read and write memory) and a `Stop` hook (copies the session
  transcript into `~/.knowledge-escrow/ingest/` for recent recall). Codex
  runs plugin hooks only after you trust them: open Codex, run `/hooks`,
  and trust the two Knowledge Escrow entries. Until then memory still works,
  but Codex is not reminded to use it.
- `npm run build:codex-plugin` builds for the host arch only. `npm run
  build:release` builds release tarballs for both `darwin-arm64` and
  `darwin-x64` (see `scripts/build-codex-plugin.mjs --help`). If the bundled
  binary doesn't match a machine, the launcher (`bin/escrow`) falls back to
  any Node.js 22.13+ on PATH, Codex's vendored Node, or the Node bundled in
  the ChatGPT app.
