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

## Quick start

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
