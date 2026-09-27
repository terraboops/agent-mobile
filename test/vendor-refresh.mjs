/**
 * vendor-refresh — copy the INSTALLED plugin files into vendor/, one direction only.
 *
 * This is the sanctioned way to record an intentional change to the Hermes plugin, so that
 * `npm run plugin-drift` goes green again for the right reason. Without it the only way to
 * silence the drift check would be to ignore it, which is how a check stops meaning anything.
 *
 * It is NOT an installer and never will be: it reads from ~/.hermes/plugins/agentmob and
 * writes only inside this repo. Nothing under the plugin directory is ever modified.
 *
 * Run: npm run vendor-refresh
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { PLUGIN_DIR, VENDOR_DIR, FILES, isForbidden } from './lib/vendor-files.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

console.log(`source : ${PLUGIN_DIR}   (read-only)`);
console.log(`target : ${VENDOR_DIR}\n`);

const manifest = { generated: new Date().toISOString(), source: PLUGIN_DIR, files: {} };
let copied = 0, missing = 0;

for (const rel of FILES) {
  if (isForbidden(rel)) { console.log(`  REFUSED ${rel} — never vendored (secret or state)`); continue; }
  const src = join(PLUGIN_DIR, rel);
  if (!existsSync(src)) { console.log(`  missing ${rel} (not installed)`); missing++; continue; }
  const buf = readFileSync(src);
  const dst = join(VENDOR_DIR, rel);
  mkdirSync(dirname(dst), { recursive: true });
  const before = existsSync(dst) ? sha(readFileSync(dst)) : null;
  writeFileSync(dst, buf);
  const h = sha(buf);
  manifest.files[rel] = { sha256: h, bytes: buf.length };
  console.log(`  ${before === h ? 'same    ' : 'updated '} ${rel}  ${h.slice(0, 12)}  ${buf.length}B`);
  if (before !== h) copied++;
}

writeFileSync(join(VENDOR_DIR, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n${copied} file(s) changed, ${missing} missing. Manifest written.`);
console.log('Nothing under the plugin directory was modified.');
