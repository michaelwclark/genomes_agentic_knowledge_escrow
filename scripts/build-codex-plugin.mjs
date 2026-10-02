#!/usr/bin/env node
// Builds release/codex-marketplace/: a local, git-backed Codex plugin
// marketplace containing Knowledge Escrow fully packaged for this machine
// (bundled MCP server + Node single-executable application + local
// embedding model), so a non-technical user can install it with
// `codex plugin marketplace add <path>` + `codex plugin add
// knowledge-escrow@knowledge-escrow` and nothing else — no Node, Docker,
// Ollama, or API keys required on their machine.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'plugins', 'codex', 'knowledge-escrow');
const RELEASE_DIR = path.join(REPO_ROOT, 'release', 'codex-marketplace');
// Codex's `plugin add` clones the plugin's source path with `git clone`, so
// that path must itself be a git repository, not merely a subdirectory of
// one (verified empirically: a "./plugins/knowledge-escrow" source nested
// under the marketplace's own .git fails clone with "repository ... does
// not exist"). The proven shape (copied from the context-mode marketplace
// this task was briefed against) is a single-plugin marketplace where the
// plugin IS the marketplace root, source "./". So the release directory
// plays both roles.
const PLUGIN_OUT_DIR = RELEASE_DIR;
const VENDOR_MODEL_DIR = path.join(REPO_ROOT, 'vendor', 'models', 'potion-base-8M');
const BUNDLE_TMP_DIR = path.join(REPO_ROOT, '.build-tmp', 'codex-plugin');

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

function section(title) {
  console.log(`\n== ${title} ==`);
}

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...options });
}

function sizeOf(targetPath) {
  if (!existsSync(targetPath)) return 0;
  const stat = statSync(targetPath);
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of execFileSync('find', [targetPath, '-type', 'f'], { encoding: 'utf8' }).split('\n')) {
    if (!entry) continue;
    total += statSync(entry).size;
  }
  return total;
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function main() {
  section('1. TypeScript build + local model');
  run('npm', ['run', 'build']);
  run('node', ['scripts/fetch-local-model.mjs']);

  section('2. esbuild bundle (src/cli.ts -> server/escrow.cjs)');
  rmSync(BUNDLE_TMP_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_TMP_DIR, { recursive: true });
  const bundlePath = path.join(BUNDLE_TMP_DIR, 'escrow.cjs');
  const esbuildBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
  run(esbuildBin, [
    'src/cli.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${bundlePath}`,
    // esbuild drops import.meta.url to {} in a CJS bundle. Both uses in this
    // codebase (src/version.ts reading package.json) already fall back to
    // 'unknown' on failure, but we recover the real behavior anyway by
    // rewriting it to the bundle's own real on-disk file:// URL at runtime.
    '--define:import.meta.url=import_meta_url',
    "--banner:js=const import_meta_url = require('url').pathToFileURL(__filename).href;",
    // src/version.ts reads this at runtime; the bundled SEA has no
    // package.json on disk to read for its version, so bake the real one in.
    `--define:__ESCROW_VERSION__=${JSON.stringify(pkg.version)}`,
    // Optional native peer dep of pg that this plugin never loads (no
    // POSTGRES_URL in its env). Left external so esbuild doesn't fail trying
    // to bundle a native .node addon; it is never actually required at
    // runtime in the plugin's configuration.
    '--external:pg-native',
    '--log-level=warning'
  ]);

  section('3. Node single-executable application');
  const arch = os.arch() === 'x64' ? 'x86_64' : os.arch() === 'arm64' ? 'arm64' : os.arch();
  if (os.platform() !== 'darwin') {
    console.warn(`platform ${os.platform()} is not darwin; SEA build is only proven on macOS. Continuing anyway.`);
  }
  const seaConfigPath = path.join(BUNDLE_TMP_DIR, 'sea-config.json');
  const seaBlobPath = path.join(BUNDLE_TMP_DIR, 'sea-prep.blob');
  // Node's SEA blob embeds `main` as given (used for Error.stack filenames in
  // the running SEA), so an absolute path here bakes this machine's build
  // directory into the shipped binary (verified via `strings` on a prior
  // build: the full /Users/<you>/.../.build-tmp/codex-plugin/escrow.cjs path
  // was present). Write the config with `main`/`output` relative and run
  // `--experimental-sea-config` with cwd set to BUNDLE_TMP_DIR so Node
  // resolves and embeds only the relative "escrow.cjs" name.
  writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: 'escrow.cjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true })
  );
  run('node', ['--experimental-sea-config', seaConfigPath], { cwd: BUNDLE_TMP_DIR });
  const seaBinName = `escrow-darwin-${arch}`;
  const seaBinPath = path.join(BUNDLE_TMP_DIR, seaBinName);
  cpSync(process.execPath, seaBinPath);
  try {
    run('codesign', ['--remove-signature', seaBinPath]);
  } catch (error) {
    console.warn(`codesign --remove-signature failed (continuing): ${error.message}`);
  }
  run('npx', [
    '-y',
    'postject',
    seaBinPath,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name',
    'NODE_SEA'
  ]);
  run('codesign', ['--sign', '-', seaBinPath]);
  chmodSync(seaBinPath, 0o755);
  console.log(`cross-arch note: only ${seaBinName} is built here (the host's own OS/arch). ` +
    'bin/escrow falls back to any Node 22.13+ on PATH, or the Codex runtime\'s vendored Node, on other machines.');

  section('4. Assemble plugin directory');
  rmSync(PLUGIN_OUT_DIR, { recursive: true, force: true });
  mkdirSync(PLUGIN_OUT_DIR, { recursive: true });
  cpSync(TEMPLATE_DIR, PLUGIN_OUT_DIR, { recursive: true });
  // plugin.json's version tracks package.json so a rebuild after a version
  // bump doesn't require hand-editing the template.
  const pluginJsonPath = path.join(PLUGIN_OUT_DIR, '.codex-plugin', 'plugin.json');
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
  pluginJson.version = pkg.version;
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`);

  mkdirSync(path.join(PLUGIN_OUT_DIR, 'server'), { recursive: true });
  cpSync(bundlePath, path.join(PLUGIN_OUT_DIR, 'server', 'escrow.cjs'));
  cpSync(seaBinPath, path.join(PLUGIN_OUT_DIR, 'bin', seaBinName));
  chmodSync(path.join(PLUGIN_OUT_DIR, 'bin', seaBinName), 0o755);
  chmodSync(path.join(PLUGIN_OUT_DIR, 'bin', 'escrow'), 0o755);
  mkdirSync(path.join(PLUGIN_OUT_DIR, 'models'), { recursive: true });
  cpSync(VENDOR_MODEL_DIR, path.join(PLUGIN_OUT_DIR, 'models', 'potion-base-8M'), { recursive: true });

  section('5. Write marketplace manifest');
  mkdirSync(path.join(RELEASE_DIR, '.agents', 'plugins'), { recursive: true });
  const marketplace = {
    name: 'knowledge-escrow',
    interface: { displayName: 'Knowledge Escrow' },
    plugins: [
      {
        name: 'knowledge-escrow',
        source: { source: 'url', url: './' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity'
      }
    ]
  };
  writeFileSync(
    path.join(RELEASE_DIR, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify(marketplace, null, 2)}\n`
  );

  section('6. git init + commit (idempotent)');
  // `codex plugin marketplace add` requires the marketplace root to be a git
  // repo. Re-initializing from scratch on every rebuild (rather than reusing
  // an existing .git) keeps this directory's history from growing without
  // bound across rebuilds of a 100+MB binary; it is gitignored output, not
  // a tracked repo anyone needs history in. (50/50 call, logged.)
  rmSync(path.join(RELEASE_DIR, '.git'), { recursive: true, force: true });
  run('git', ['init', '--quiet'], { cwd: RELEASE_DIR });
  run('git', ['add', '-A'], { cwd: RELEASE_DIR });
  run('git', ['commit', '--quiet', '-m', `Knowledge Escrow ${pkg.version} (${seaBinName})`], {
    cwd: RELEASE_DIR,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Knowledge Escrow Build',
      GIT_AUTHOR_EMAIL: 'build@local',
      GIT_COMMITTER_NAME: 'Knowledge Escrow Build',
      GIT_COMMITTER_EMAIL: 'build@local'
    }
  });

  section('Summary');
  const sizes = {
    'SEA binary': sizeOf(path.join(PLUGIN_OUT_DIR, 'bin', seaBinName)),
    'Bundled server (cjs)': sizeOf(path.join(PLUGIN_OUT_DIR, 'server', 'escrow.cjs')),
    'Local embedding model': sizeOf(path.join(PLUGIN_OUT_DIR, 'models')),
    'Total plugin dir': sizeOf(PLUGIN_OUT_DIR),
    'Total marketplace dir': sizeOf(RELEASE_DIR)
  };
  for (const [label, bytes] of Object.entries(sizes)) {
    console.log(`${label.padEnd(24)} ${human(bytes)}`);
  }
  console.log(`\nmarketplace path: ${RELEASE_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
