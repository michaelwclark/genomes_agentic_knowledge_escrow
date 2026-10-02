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

- **No hooks are shipped in v1.** Codex plugin hooks do not fire on a fresh
  install (a trust-gate behavior observed empirically against Codex CLI
  0.155), so shipping one would silently do nothing for a new install. If
  that changes in a future Codex release, hooks can be added then.
- The bundled binary is built for the host machine's OS/arch only
  (`darwin-arm64` or `darwin-x86_64`, whichever Mac this is). Cross-arch
  builds are out of scope for v1 — the launcher (`bin/escrow`) falls back to
  any Node.js 22.13+ on the user's PATH, or Codex's own vendored Node
  runtime, if the bundled binary doesn't match their machine.
