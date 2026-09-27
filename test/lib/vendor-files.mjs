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

export const VENDOR_DIR = join(REPO, 'vendor/hermes-plugin');

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
