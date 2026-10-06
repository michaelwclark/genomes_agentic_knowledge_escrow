#!/bin/sh
# Knowledge Escrow installer (macOS, for Codex).
#
#   curl -fsSL https://raw.githubusercontent.com/michaelwclark/genomes_agentic_knowledge_escrow/main/install.sh | sh
#
# Options:
#   --version <tag>   install a specific release (default: latest)
#   --from-dir <dir>  use a local tarball + SHA256SUMS instead of downloading
#   --upgrade         replace an existing install
#   --uninstall       remove the plugin (add --purge-data to also delete memories)
#   --dry-run         print what would happen, change nothing
#   --no-codex        unpack and verify only; do not register with Codex
#
# This script never edits ~/.codex/config.toml or ~/.codex/hooks.json, and it
# never touches hook trust: it only calls the `codex` CLI.

# Everything lives inside main(), invoked on the last line, so a truncated
# download cannot execute a half-read script.
main() {
  set -eu

  REPO="michaelwclark/genomes_agentic_knowledge_escrow"
  MARKETPLACE="knowledge-escrow"
  PLUGIN_REF="knowledge-escrow@knowledge-escrow"
  INSTALL_ROOT="$HOME/Library/Application Support/KnowledgeEscrow"
  PLUGIN_DIR="$INSTALL_ROOT/plugin"
  DATA_DIR="$HOME/.knowledge-escrow"
  CHATGPT_CODEX="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"

  VERSION=""
  FROM_DIR=""
  UPGRADE=0
  UNINSTALL=0
  PURGE_DATA=0
  DRY_RUN=0
  NO_CODEX=0
  WORK=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version needs a value"
        VERSION="${2#v}"
        shift 2
        ;;
      --from-dir)
        [ $# -ge 2 ] || die "--from-dir needs a directory"
        FROM_DIR="$2"
        shift 2
        ;;
      --upgrade) UPGRADE=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      --purge-data) PURGE_DATA=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --no-codex) NO_CODEX=1; shift ;;
      -h | --help)
        sed -n '2,15p' "$0" 2>/dev/null || echo "See the header of install.sh for options."
        return 0
        ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
  done

  if [ "$PURGE_DATA" = 1 ] && [ "$UNINSTALL" != 1 ]; then
    die "--purge-data only makes sense together with --uninstall"
  fi

  detect_platform
  CODEX_BIN=""
  if [ "$NO_CODEX" != 1 ]; then
    CODEX_BIN=$(find_codex)
  fi

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
    return 0
  fi

  WORK=$(mktemp -d "${TMPDIR:-/tmp}/knowledge-escrow-install.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT INT TERM

  resolve_version
  TARBALL="knowledge-escrow-$VERSION-darwin-$ARCH.tar.gz"
  say "Knowledge Escrow $VERSION for macOS ($ARCH)"

  INSTALLED_VERSION=$(installed_version)
  if [ -n "$INSTALLED_VERSION" ] && [ "$UPGRADE" != 1 ]; then
    if [ "$INSTALLED_VERSION" = "$VERSION" ]; then
      say "Version $VERSION is already installed; re-checking registration."
      register_with_codex
      smoke_test
      print_next_steps
      return 0
    fi
    die "version $INSTALLED_VERSION is already installed. Re-run with --upgrade to switch to $VERSION."
  fi

  fetch_assets
  verify_checksum
  unpack_plugin
  register_with_codex
  smoke_test
  print_next_steps
}

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Mutating commands go through here so --dry-run can narrate instead of act.
# Children never read the installer's own stdin (it is the script under curl|sh).
act() {
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] $*"
    return 0
  fi
  "$@" </dev/null
}

detect_platform() {
  OS=$(uname -s)
  [ "$OS" = "Darwin" ] || die "this installer supports macOS only (found $OS). Linux and Windows are not supported yet."
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac
}

# Codex is usually on PATH for developers, but the ChatGPT app bundles its own
# copy that non-technical users never put on PATH.
find_codex() {
  if command -v codex >/dev/null 2>&1; then
    command -v codex
  elif [ -x "$CHATGPT_CODEX" ]; then
    printf '%s\n' "$CHATGPT_CODEX"
  fi
}

resolve_version() {
  if [ -n "$VERSION" ]; then return 0; fi
  if [ -n "$FROM_DIR" ]; then
    # Infer from the tarball for this arch in the local directory.
    found=""
    for candidate in "$FROM_DIR"/knowledge-escrow-*-darwin-"$ARCH".tar.gz; do
      [ -f "$candidate" ] && { found=${candidate##*/}; break; }
    done
    [ -n "$found" ] || die "no knowledge-escrow-*-darwin-$ARCH.tar.gz in $FROM_DIR"
    VERSION=${found#knowledge-escrow-}
    VERSION=${VERSION%-darwin-"$ARCH".tar.gz}
    return 0
  fi
  # The "latest" URL redirects to /releases/tag/<tag>; reading the redirect
  # target avoids parsing JSON in sh.
  final=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" </dev/null) ||
    die "could not reach GitHub to find the latest release. Check your network, or use --version <tag>."
  tag=${final##*/}
  case "$tag" in
    v[0-9]*) VERSION=${tag#v} ;;
    *) die "no published release found yet at https://github.com/$REPO/releases" ;;
  esac
}

installed_version() {
  manifest="$PLUGIN_DIR/.codex-plugin/plugin.json"
  [ -f "$manifest" ] || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1
}

fetch_assets() {
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would obtain $TARBALL and SHA256SUMS from ${FROM_DIR:-github.com/$REPO releases}"
    return 0
  fi
  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$TARBALL" ] || die "$FROM_DIR/$TARBALL not found"
    [ -f "$FROM_DIR/SHA256SUMS" ] || die "$FROM_DIR/SHA256SUMS not found"
    cp "$FROM_DIR/$TARBALL" "$FROM_DIR/SHA256SUMS" "$WORK/"
    return 0
  fi
  base="https://github.com/$REPO/releases/download/v$VERSION"
  say "Downloading $TARBALL ..."
  curl -fSL --retry 3 --progress-bar -o "$WORK/$TARBALL" "$base/$TARBALL" </dev/null ||
    die "download failed: $base/$TARBALL (is there a release for $VERSION on macOS $ARCH?)"
  curl -fsSL --retry 3 -o "$WORK/SHA256SUMS" "$base/SHA256SUMS" </dev/null ||
    die "download failed: $base/SHA256SUMS"
}

verify_checksum() {
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would verify $TARBALL against SHA256SUMS with shasum -a 256"
    return 0
  fi
  line=$(grep -F "  $TARBALL" "$WORK/SHA256SUMS" | head -n 1 || true)
  [ -n "$line" ] || die "$TARBALL is not listed in SHA256SUMS; refusing to install."
  if ! (cd "$WORK" && printf '%s\n' "$line" | shasum -a 256 -c - >/dev/null 2>&1); then
    die "checksum mismatch for $TARBALL; the download is corrupt or has been tampered with. Nothing was installed."
  fi
  say "Checksum verified (sha256)."
}

have_git() {
  git_path=$(command -v git 2>/dev/null || true)
  [ -n "$git_path" ] || return 1
  # On a fresh Mac, /usr/bin/git is a stub that prompts for the Xcode Command
  # Line Tools instead of running git, so `command -v git` is not enough.
  if [ "$git_path" = "/usr/bin/git" ] && ! xcode-select -p >/dev/null 2>&1; then
    return 1
  fi
  git --version >/dev/null 2>&1
}

unpack_plugin() {
  if [ "$NO_CODEX" != 1 ] && [ "$DRY_RUN" != 1 ] && ! have_git; then
    die "git is not available. Codex needs git to register the plugin; install the Xcode Command Line Tools by running 'xcode-select --install', then re-run this installer. Nothing was changed."
  fi
  stage="$INSTALL_ROOT/.staging-$$"
  act mkdir -p "$INSTALL_ROOT"
  act mkdir -p "$stage"
  act tar -xzf "$WORK/$TARBALL" -C "$stage"
  strip_quarantine "$stage"
  if [ "$DRY_RUN" != 1 ] && [ ! -f "$stage/.codex-plugin/plugin.json" ]; then
    rm -rf "$stage"
    die "the archive does not look like a Knowledge Escrow plugin; nothing was installed."
  fi
  if [ "$DRY_RUN" != 1 ] && have_git; then
    (
      cd "$stage"
      git init --quiet </dev/null
      git add -A </dev/null
      # Explicit identity/no-sign/no-hooks so the user's global git config
      # (missing identity, commit signing, hooks) cannot break the install.
      git -c user.name="Knowledge Escrow" -c user.email="escrow@localhost" \
        -c commit.gpgsign=false -c core.hooksPath=/dev/null \
        commit --quiet -m "Knowledge Escrow $VERSION" </dev/null
    ) || { rm -rf "$stage"; die "could not create the local plugin repository."; }
  elif [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would git init + commit $stage"
  fi
  if [ "$DRY_RUN" != 1 ] && [ -d "$PLUGIN_DIR" ]; then
    # Unregister first so Codex is never pointing at a half-swapped directory.
    unregister_from_codex
    rm -rf "$PLUGIN_DIR"
  fi
  act mv "$stage" "$PLUGIN_DIR"
  if [ "$DRY_RUN" != 1 ]; then say "Installed to $PLUGIN_DIR"; fi
}

# Files fetched by browsers/curl-with-quarantine carry Gatekeeper's quarantine
# flag, which would block the bundled binary. Clear it only when present.
strip_quarantine() {
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  if xattr -lr "$1" 2>/dev/null | grep -q 'com.apple.quarantine'; then
    say "Removing the macOS download-quarantine flag from the unpacked files (standard for command-line installs)."
    xattr -dr com.apple.quarantine "$1" 2>/dev/null || true
  fi
}

codex_has_marketplace() {
  "$CODEX_BIN" plugin marketplace list </dev/null 2>/dev/null | grep -Eq "^${MARKETPLACE}[[:space:]]"
}

codex_has_plugin() {
  "$CODEX_BIN" plugin list </dev/null 2>/dev/null | grep -Eq "^${PLUGIN_REF}[[:space:]]+installed"
}

unregister_from_codex() {
  [ -n "$CODEX_BIN" ] || return 0
  if codex_has_plugin; then "$CODEX_BIN" plugin remove "$PLUGIN_REF" </dev/null >/dev/null 2>&1 || true; fi
  if codex_has_marketplace; then "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE" </dev/null >/dev/null 2>&1 || true; fi
}

register_with_codex() {
  if [ "$NO_CODEX" = 1 ]; then
    say "Skipping Codex registration (--no-codex)."
    return 0
  fi
  if [ -z "$CODEX_BIN" ]; then
    say "Codex was not found on this Mac, so the plugin was unpacked but not registered."
    say "To add it from the ChatGPT app: open Codex, go to Plugins, choose Add marketplace,"
    say "and pick this folder: $PLUGIN_DIR"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would run: $CODEX_BIN plugin marketplace add \"$PLUGIN_DIR\""
    say "[dry-run] would run: $CODEX_BIN plugin add $PLUGIN_REF"
    return 0
  fi
  if codex_has_marketplace && ! "$CODEX_BIN" plugin marketplace list </dev/null 2>/dev/null | grep -Fq "$PLUGIN_DIR"; then
    # A marketplace with our name pointing somewhere else (e.g. an old path).
    "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE" </dev/null >/dev/null 2>&1 || true
  fi
  if ! codex_has_marketplace; then
    "$CODEX_BIN" plugin marketplace add "$PLUGIN_DIR" </dev/null >/dev/null ||
      die "codex could not add the marketplace at $PLUGIN_DIR"
  fi
  if [ "$UPGRADE" = 1 ] && codex_has_plugin; then
    "$CODEX_BIN" plugin remove "$PLUGIN_REF" </dev/null >/dev/null 2>&1 || true
  fi
  if ! codex_has_plugin; then
    "$CODEX_BIN" plugin add "$PLUGIN_REF" </dev/null >/dev/null ||
      die "codex could not install $PLUGIN_REF"
  fi
  say "Registered with Codex ($PLUGIN_REF)."
}

# Sends initialize + one tools/call to the installed server over stdio, the
# same launcher and env Codex uses, in a throwaway data dir. Each call is its
# own server run: the server handles requests concurrently, so a write and a
# read piped together can race, whereas a real client waits for each reply.
smoke_call() {
  call_json="$1"
  out="$WORK/smoke.out"
  err="$WORK/smoke.err"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"installer-smoke","version":"1"}}}'
    printf '%s\n' "$call_json"
  } | env KNOWLEDGE_ESCROW_DATA_DIR="$WORK/smoke-data" KNOWLEDGE_ESCROW_SQLITE=1 \
    KNOWLEDGE_ESCROW_EMBEDDING_PROVIDER=local KNOWLEDGE_ESCROW_REDACTION=1 \
    sh "$PLUGIN_DIR/bin/escrow" >"$out" 2>"$err" &
  smoke_pid=$!
  (sleep 60; kill "$smoke_pid" 2>/dev/null) >/dev/null 2>&1 &
  watchdog=$!
  wait "$smoke_pid" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
}

smoke_test() {
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] would run an MCP write/read smoke test via $PLUGIN_DIR/bin/escrow"
    return 0
  fi
  token="installer-smoke-$$"
  mkdir -p "$WORK/smoke-data"
  smoke_call "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_write\",\"arguments\":{\"content\":\"Decision: $token verified the install.\"}}}"
  grep -q '"recordId' "$out" || smoke_fail "memory_write returned no record"
  smoke_call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_read\",\"arguments\":{\"query\":\"$token\"}}}"
  grep -q "$token" "$out" || smoke_fail "memory_read did not return the memory just written"
  say "Smoke test passed: wrote and recalled a memory through the installed server."
}

smoke_fail() {
  warn "smoke test FAILED: $1. Server stderr:"
  sed 's/^/  /' "$WORK/smoke.err" >&2 || true
  die "the installed server did not complete a write/read round-trip."
}

print_next_steps() {
  if [ "$DRY_RUN" = 1 ]; then
    say ""
    say "Dry run finished; nothing was changed."
    return 0
  fi
  say ""
  say "Knowledge Escrow is installed."
  say ""
  say "One manual step remains:"
  say "  Open Codex, run /hooks, and trust the two Knowledge Escrow hooks (SessionStart, Stop)."
  say "  Until you do, memory still works, but Codex won't be reminded to use it."
  say ""
  say "Your memories live in: $DATA_DIR  (nothing leaves this computer)"
  say "To uninstall:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- --uninstall"
  say "               (add --purge-data to also delete your memories)"
}

do_uninstall() {
  say "Uninstalling Knowledge Escrow ..."
  if [ -n "$CODEX_BIN" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say "[dry-run] would run: $CODEX_BIN plugin remove $PLUGIN_REF; plugin marketplace remove $MARKETPLACE"
    else
      unregister_from_codex
    fi
  fi
  if [ -d "$INSTALL_ROOT" ]; then
    act rm -rf "$INSTALL_ROOT"
  fi
  if [ "$PURGE_DATA" = 1 ]; then
    if [ -d "$DATA_DIR" ]; then
      say "Deleting your memories at $DATA_DIR (--purge-data)."
      act rm -rf "$DATA_DIR"
    fi
  elif [ -d "$DATA_DIR" ]; then
    say "Kept your memories at $DATA_DIR. Delete that folder, or re-run with --purge-data, to remove them."
  fi
  say "Done. Any Codex hook-trust entries are left untouched; they are harmless once the plugin is gone."
}

main "$@"
