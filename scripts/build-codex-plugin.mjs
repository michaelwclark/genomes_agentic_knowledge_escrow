#!/usr/bin/env node
// Builds the Knowledge Escrow Codex plugin, fully packaged (bundled MCP
// server + Node single-executable application + local embedding model), so a
// non-technical user needs no Node, Docker, Ollama, or API keys.
//
// Two modes:
//   node scripts/build-codex-plugin.mjs            # local marketplace for this host
//     -> release/codex-marketplace/ (a git repo Codex can `marketplace add`)
//   node scripts/build-codex-plugin.mjs --release  # release assets for GitHub
//     -> release/dist/knowledge-escrow-<version>-darwin-<arm64|x64>.tar.gz + SHA256SUMS
//     (staged plugin dirs land in release/stage/<arch>/ for scrub-checking)
//
// Options: --arch arm64|x64|both   (release default: both; local default: host)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const LOCAL_MARKETPLACE_DIR = path.join(REPO_ROOT, 'release', 'codex-marketplace');
const STAGE_ROOT = path.join(REPO_ROOT, 'release', 'stage');
const DIST_DIR = path.join(REPO_ROOT, 'release', 'dist');
const VENDOR_MODEL_DIR = path.join(REPO_ROOT, 'vendor', 'models', 'potion-base-8M');
const BUNDLE_TMP_DIR = path.join(REPO_ROOT, '.build-tmp', 'codex-plugin');
const NODE_CACHE_DIR = path.join(REPO_ROOT, '.build-tmp', 'node-cache');
// Pinned so the SEA injection is reproducible; bump deliberately.
const POSTJECT_VERSION = '1.0.0-alpha.6';

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// Node's own naming (arm64 | x64) is the tarball/release naming. The SEA file
// names keep `uname -m` spelling (arm64 | x86_64) because bin/escrow looks the
// binary up with `uname -m`.
const UNAME_ARCH = { arm64: 'arm64', x64: 'x86_64' };

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
  return readdirSync(targetPath, { withFileTypes: true }).reduce(
    (total, entry) => total + sizeOf(path.join(targetPath, entry.name)),
    0
  );
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: build-codex-plugin.mjs [--release] [--arch arm64|x64|both]');
    process.exit(0);
  }
  const release = argv.includes('--release');
  const archIndex = argv.indexOf('--arch');
  const archValue = archIndex >= 0 ? argv[archIndex + 1] : undefined;
  if (archValue && !['arm64', 'x64', 'both'].includes(archValue)) {
    throw new Error(`--arch must be arm64, x64, or both (got "${archValue}")`);
  }
  const hostArch = os.arch() === 'x64' ? 'x64' : 'arm64';
  let arches = [hostArch];
  if (archValue === 'arm64' || archValue === 'x64') arches = [archValue];
  else if (archValue === 'both' || (release && !archValue)) arches = ['arm64', 'x64'];
  return { release, arches, hostArch };
}

/** Bundles src/cli.ts into one CJS file and writes the platform-independent SEA blob. */
function buildBundleAndBlob() {
  section('1. TypeScript build + local model');
  run('npm', ['run', 'build']);
  run('node', ['scripts/fetch-local-model.mjs']);

  section('2. esbuild bundle (src/cli.ts -> server/escrow.cjs)');
  rmSync(BUNDLE_TMP_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_TMP_DIR, { recursive: true });
  const bundlePath = path.join(BUNDLE_TMP_DIR, 'escrow.cjs');
  run(path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild'), [
    'src/cli.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${bundlePath}`,
    // esbuild drops import.meta.url to {} in a CJS bundle; rewrite it to the
    // bundle's own on-disk file:// URL at runtime.
    '--define:import.meta.url=import_meta_url',
    "--banner:js=const import_meta_url = require('url').pathToFileURL(__filename).href;",
    // The SEA has no package.json on disk, so bake the real version in
    // (read by src/version.ts).
    `--define:__ESCROW_VERSION__=${JSON.stringify(pkg.version)}`,
    // Optional native peer dep of pg that this plugin never loads.
    '--external:pg-native',
    '--log-level=warning'
  ]);

  section('3. SEA blob');
  // `main` is embedded as given (it shows up in Error.stack filenames), so use
  // a relative path with cwd set to the bundle dir to avoid baking this
  // machine's build path into the shipped binary.
  writeFileSync(
    path.join(BUNDLE_TMP_DIR, 'sea-config.json'),
    JSON.stringify({ main: 'escrow.cjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true })
  );
  run('node', ['--experimental-sea-config', 'sea-config.json'], { cwd: BUNDLE_TMP_DIR });
  return { bundlePath, blobPath: path.join(BUNDLE_TMP_DIR, 'sea-prep.blob') };
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response;
}

/** Returns a Node binary for `arch`: this process's own when it matches, else the official download. */
async function nodeBinaryFor(arch, hostArch) {
  if (arch === hostArch) return process.execPath;
  // The blob was generated by exactly this Node version, so inject it into the
  // same version for the other arch.
  const version = process.version;
  const base = `https://nodejs.org/dist/${version}`;
  const tarName = `node-${version}-darwin-${arch}.tar.gz`;
  const extracted = path.join(NODE_CACHE_DIR, `node-${version}-darwin-${arch}`, 'bin', 'node');
  if (existsSync(extracted)) return extracted;

  mkdirSync(NODE_CACHE_DIR, { recursive: true });
  const sums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${tarName}`));
  if (!line) throw new Error(`${tarName} not listed in ${base}/SHASUMS256.txt`);
  const expected = line.trim().split(/\s+/)[0];
  const tarPath = path.join(NODE_CACHE_DIR, tarName);
  writeFileSync(tarPath, Buffer.from(await (await fetchOk(`${base}/${tarName}`)).arrayBuffer()));
  const actual = sha256File(tarPath);
  if (actual !== expected) {
    rmSync(tarPath, { force: true });
    throw new Error(`checksum mismatch for ${tarName}: expected ${expected}, got ${actual}`);
  }
  console.log(`verified ${tarName} against SHASUMS256.txt`);
  run('tar', ['-xzf', tarPath, '-C', NODE_CACHE_DIR]);
  rmSync(tarPath, { force: true });
  return extracted;
}

/** Injects the blob into a copy of `nodeBinary` and ad-hoc signs it. */
function buildSea(nodeBinary, blobPath, seaPath) {
  cpSync(nodeBinary, seaPath);
  try {
    run('codesign', ['--remove-signature', seaPath]);
  } catch (error) {
    console.warn(`codesign --remove-signature failed (continuing): ${error.message}`);
  }
  run('npx', [
    '-y',
    `postject@${POSTJECT_VERSION}`,
    seaPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name',
    'NODE_SEA'
  ]);
  run('codesign', ['--sign', '-', seaPath]);
  chmodSync(seaPath, 0o755);
}

function canRunX64() {
  try {
    execFileSync('arch', ['-x86_64', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs the SEA under an empty environment (via Rosetta for a foreign x64 build); throws on a wrong result. */
function verifySea(seaPath, arch, hostArch) {
  if (arch !== hostArch && !(arch === 'x64' && canRunX64())) {
    return 'unverified (this arch cannot be executed on the build host)';
  }
  const launcher = arch !== hostArch ? ['arch', '-x86_64', seaPath] : [seaPath];
  const exec = (extraArgs, input) =>
    execFileSync('env', ['-i', ...launcher, ...extraArgs], { encoding: 'utf8', input }).trim();
  const version = exec(['version']);
  if (version !== pkg.version) throw new Error(`${path.basename(seaPath)} reported version "${version}", expected "${pkg.version}"`);
  const hook = JSON.parse(exec(['hook', 'session-start', '--harness', 'codex'], '{}'));
  if (!hook.hookSpecificOutput?.additionalContext) throw new Error('SEA session-start hook output invalid');
  return 'verified (version + hook session-start under env -i)';
}

/** Assembles one plugin directory containing the given SEA binaries. */
function assemblePlugin(outDir, bundlePath, seaBinaries) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(TEMPLATE_DIR, outDir, { recursive: true });
  // plugin.json's version tracks package.json so a version bump needs no hand edit.
  const pluginJsonPath = path.join(outDir, '.codex-plugin', 'plugin.json');
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
  pluginJson.version = pkg.version;
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`);

  mkdirSync(path.join(outDir, 'server'), { recursive: true });
  cpSync(bundlePath, path.join(outDir, 'server', 'escrow.cjs'));
  for (const [name, sourcePath] of Object.entries(seaBinaries)) {
    cpSync(sourcePath, path.join(outDir, 'bin', name));
    chmodSync(path.join(outDir, 'bin', name), 0o755);
  }
  chmodSync(path.join(outDir, 'bin', 'escrow'), 0o755);
  chmodSync(path.join(outDir, 'bin', 'escrow-hook'), 0o755);
  mkdirSync(path.join(outDir, 'models'), { recursive: true });
  cpSync(VENDOR_MODEL_DIR, path.join(outDir, 'models', 'potion-base-8M'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'LICENSE'), path.join(outDir, 'LICENSE'));

  mkdirSync(path.join(outDir, '.agents', 'plugins'), { recursive: true });
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
  writeFileSync(path.join(outDir, '.agents', 'plugins', 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
}

function gitInitAndCommit(dir, message) {
  // Codex's `plugin add` clones the plugin source with `git clone`, so the
  // plugin dir must itself be a git repo. Re-initialising on each rebuild keeps
  // history from accumulating copies of a 100+MB binary.
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  run('git', ['init', '--quiet'], { cwd: dir });
  run('git', ['add', '-A'], { cwd: dir });
  run('git', ['commit', '--quiet', '-m', message], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Knowledge Escrow Build',
      GIT_AUTHOR_EMAIL: 'build@local',
      GIT_COMMITTER_NAME: 'Knowledge Escrow Build',
      GIT_COMMITTER_EMAIL: 'build@local'
    }
  });
}

async function main() {
  const { release, arches, hostArch } = parseArgs(process.argv.slice(2));
  const { bundlePath, blobPath } = buildBundleAndBlob();

  section(`4. SEA binaries (${arches.join(', ')})`);
  const seaByArch = {};
  const verification = {};
  for (const arch of arches) {
    const seaName = `escrow-darwin-${UNAME_ARCH[arch]}`;
    const seaPath = path.join(BUNDLE_TMP_DIR, seaName);
    buildSea(await nodeBinaryFor(arch, hostArch), blobPath, seaPath);
    verification[arch] = verifySea(seaPath, arch, hostArch);
    seaByArch[arch] = { seaName, seaPath };
  }

  if (!release) {
    section('5. Local marketplace');
    const [arch] = arches;
    assemblePlugin(LOCAL_MARKETPLACE_DIR, bundlePath, { [seaByArch[arch].seaName]: seaByArch[arch].seaPath });
    gitInitAndCommit(LOCAL_MARKETPLACE_DIR, `Knowledge Escrow ${pkg.version} (${seaByArch[arch].seaName})`);
    console.log(`SEA ${arch}: ${verification[arch]}`);
    console.log(`marketplace path: ${LOCAL_MARKETPLACE_DIR}  (${human(sizeOf(LOCAL_MARKETPLACE_DIR))})`);
    return;
  }

  section('5. Release tarballs');
  rmSync(STAGE_ROOT, { recursive: true, force: true });
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  const sums = [];
  for (const arch of arches) {
    const stageDir = path.join(STAGE_ROOT, arch);
    assemblePlugin(stageDir, bundlePath, { [seaByArch[arch].seaName]: seaByArch[arch].seaPath });
    const tarName = `knowledge-escrow-${pkg.version}-darwin-${arch}.tar.gz`;
    // COPYFILE_DISABLE keeps AppleDouble (._*) entries out of the archive; the
    // installer commits the unpacked tree, so stray metadata files would leak in.
    run('tar', ['--no-xattrs', '-czf', path.join(DIST_DIR, tarName), '-C', stageDir, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    });
    sums.push(`${sha256File(path.join(DIST_DIR, tarName))}  ${tarName}`);
  }
  writeFileSync(path.join(DIST_DIR, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  section('Summary');
  for (const arch of arches) {
    const tarName = `knowledge-escrow-${pkg.version}-darwin-${arch}.tar.gz`;
    console.log(`${tarName}  ${human(sizeOf(path.join(DIST_DIR, tarName)))}  SEA ${verification[arch]}`);
  }
  console.log(`\nSHA256SUMS:\n${sums.join('\n')}`);
  console.log(`\nstaged plugin dirs (for scrub-check): ${STAGE_ROOT}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
