/**
 * vendor-files — which parts of the installed Hermes plugin this repo mirrors.
 *
 * `~/.hermes/plugins/agentmob` is GITIGNORED, so every fix made there lives on one Mac and a
 * restore of that directory silently reverts it. The vendored copies under vendor/hermes-plugin
 * are the comparison source for the drift check: they do not install anything and nothing ever
 * writes into the plugin directory.
 *
 * EXCLUDED ON PURPOSE:
 *   sidecar/.identity.json — the sidecar's PERSISTENT SERVER KEYPAIR, private key included.
 *     The phone PINS that public key on first pairing, so the file is both a secret and live
 *     state. It must never enter git.
 *   sidecar/node_modules   — dependencies, not our source.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Overridable so the drift check can be pointed at a COPY of the installed tree. */
export const PLUGIN_DIR = process.env.AGENTMOB_PLUGIN_DIR
  || join(homedir(), '.hermes/plugins/agentmob');

/** Overridable so the soundness test can build a throwaway vendor tree. */
export const VENDOR_DIR = process.env.AGENTMOB_VENDOR_DIR || join(REPO, 'vendor/hermes-plugin');

/** Paths are relative to both trees. */
export const FILES = [
  'adapter.py',
  '__init__.py',
  'sidecar/index.mjs',
  'sidecar/webrtc-media.mjs',
  'sidecar/wire.mjs',
  'sidecar/package.json',
  'tests/test_adapter_dispatch.py',
  'tests/test_adapter_surface_visibility.py',
];

/** Never vendor these, whatever else changes. */
export const FORBIDDEN = [/(^|\/)\.identity\.json$/, /(^|\/)node_modules(\/|$)/, /\.env$/];

export function isForbidden(rel) {
  return FORBIDDEN.some((re) => re.test(rel));
}


/**
 * Does this file actually PARSE?
 *
 * The drift check compares hashes, which proves the installed plugin matches what the repo
 * vendored — sameness. It says nothing about whether either one runs. A vendored file that is
 * corrupt matches its own hash perfectly, so a restore from it would reinstate something broken
 * and the check would pass the whole way through. Sameness is not soundness.
 *
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
export async function syntaxCheck(absPath) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile } = await import('node:fs/promises');
  const run = promisify(execFile);

  if (/\.m?js$/.test(absPath)) {
    try { await run(process.execPath, ['--check', absPath]); return { ok: true, error: null }; }
    catch (e) { return { ok: false, error: firstLine(e.stderr || e.message) }; }
  }
  if (/\.py$/.test(absPath)) {
    // The gateway's own interpreter, not whatever `python3` resolves to — a file can compile
    // under one version and not another, and the one that matters is the one that loads it.
    const py = process.env.AGENTMOB_PY
      || join(process.env.HOME || '', '.hermes/hermes-agent/venv/bin/python');
    try { await run(py, ['-m', 'py_compile', absPath]); return { ok: true, error: null }; }
    catch (e) { return { ok: false, error: firstLine(e.stderr || e.message) }; }
  }
  if (/\.json$/.test(absPath)) {
    try { JSON.parse(await readFile(absPath, 'utf8')); return { ok: true, error: null }; }
    catch (e) { return { ok: false, error: firstLine(e.message) }; }
  }
  return { ok: true, error: null };   // nothing to parse
}

function firstLine(text) {
  return String(text || '').split('\n').filter((l) => l.trim())
    .slice(-2).join(' ').slice(0, 200);
}
