# Knowledge Escrow

Local-first memory for AI agents. Knowledge Escrow remembers decisions,
commitments, and notes about people across sessions, so your agent (Codex,
Claude Code, or anything else that speaks MCP) can recall them later —
without you re-explaining the same context every time.

## Local-first guarantee

Everything lives on your own machine:

- Memory is stored as a JSONL ledger plus an optional local SQLite document
  store (FTS5 + vector search) under `~/.knowledge-escrow` by default.
- No data leaves your machine at runtime. There are no required API keys and
  no required network calls.
- An optional local embedding model (`npm run fetch-local-model`) enables
  semantic search fully offline. Ollama and Postgres/pgvector are supported
  as opt-in add-ons for anyone who wants a bigger retrieval stack; neither
  is required.
- Write-time redaction can automatically strip sensitive values (SSNs,
  emails, phone numbers, and similar) before they're ever written to disk.
  Opt in with `KNOWLEDGE_ESCROW_REDACTION=1`.

## What it is

An MCP server exposing four tools — `memory_read`, `memory_write`,
`memory_forget`, `memory_link` — plus a CLI (`escrow`) for the same
operations, health checks, and analytics. A classifier sorts each write into
a memory kind (project rule, user preference, feature state, fact, etc.) and
routes it to the right local substrate; reads fan out across every
configured substrate and merge the results.

## Install (macOS, Codex)

```sh
curl -fsSL https://raw.githubusercontent.com/michaelwclark/genomes_agentic_knowledge_escrow/main/install.sh | sh
```

No Node, Docker, or API keys needed. The installer downloads the release for
your Mac, verifies its SHA-256 checksum, unpacks it to
`~/Library/Application Support/KnowledgeEscrow/plugin`, registers it with
Codex (`codex plugin marketplace add` + `codex plugin add`, from the Codex CLI
on your PATH or the one bundled in the ChatGPT app), and runs a write/read
smoke test.

**What gets installed:** a self-contained server binary, a small local
embedding model, two skills, and two memory hooks.

**The one manual step: trust the hooks.** Codex only runs plugin hooks after
you approve them. Open Codex, run `/hooks`, and trust the two Knowledge Escrow
hooks (SessionStart, Stop). Until you do, memory still works, but Codex won't
be reminded to use it. The installer never writes Codex's trust settings.

- `SessionStart` reminds the agent to read memory before non-trivial work and
  to write durable learnings afterward.
- `Stop` copies the session transcript into `~/.knowledge-escrow/ingest/` so
  recent conversations are searchable. Copies are redacted on read and deleted
  after 14 days (`KNOWLEDGE_ESCROW_INGEST_RETENTION_DAYS`). It never writes
  durable memories on its own.

**Where your data lives:** `~/.knowledge-escrow`.

**Upgrade:** re-run the installer with `--upgrade`
(`curl -fsSL <url> | sh -s -- --upgrade`).

**Uninstall:** `curl -fsSL <url> | sh -s -- --uninstall` removes the plugin and
Codex registration but keeps your memories; add `--purge-data` to delete
`~/.knowledge-escrow` too. Other options: `--version <tag>`, `--dry-run`,
`--no-codex`, `--from-dir <dir>` (offline install from a downloaded release).

**Privacy:** all memory stays on your computer. There are no required network
calls at runtime and no telemetry; the only network use is the one-time
download of the release from GitHub. Sensitive values (SSNs, account numbers,
and similar) are redacted before being written, and again when transcript
copies are read back.

**Claude Code support:** planned.

## Quick start (from source)

```sh
npm install
npm run build
KNOWLEDGE_ESCROW_SQLITE=1 node dist/cli.js write "Decision: chose Acme for SSO."
node dist/cli.js read "which identity provider"
node dist/cli.js doctor
```

To run it as an MCP server for Codex or Claude Code:

```sh
node dist/cli.js mcp
```

See `plugins/codex/knowledge-escrow/` for a packaged Codex plugin (built with
`npm run build:codex-plugin`) that bundles everything — server, local
embedding model, and launcher — into a self-contained install with no Node,
Docker, or API keys required.

## Configuration

All configuration is environment variables with the `KNOWLEDGE_ESCROW_`
prefix (see `.env.example` for the full list and `escrow help` for a
runtime-printed summary). Anyone upgrading from the private predecessor
project can keep using the legacy `GENOMES_BRAIN_*` names; they're accepted
as a fallback.

## Development

```sh
npm run check   # typecheck
npm test        # vitest
npm run build   # compile to dist/
node scripts/scrub-check.mjs --artifacts dist   # privacy scrub gate
```

## License

MIT — see [LICENSE](./LICENSE).
