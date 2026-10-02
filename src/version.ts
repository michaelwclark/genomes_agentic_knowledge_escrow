import { readFileSync } from 'node:fs';

// The bundled Codex-plugin build (scripts/build-codex-plugin.mjs) injects the
// real package.json version at bundle time via an esbuild `--define`, since
// the bundled single-executable application has no package.json on disk
// next to it to read at runtime. `typeof` guards the reference so `tsc` and
// `vitest` builds, which never set this define, see a plain `undefined`
// instead of a ReferenceError.
declare const __ESCROW_VERSION__: string | undefined;

export const SERVICE_VERSION = readVersion();

function readVersion(): string {
  if (typeof __ESCROW_VERSION__ === 'string' && __ESCROW_VERSION__) {
    return __ESCROW_VERSION__;
  }
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
