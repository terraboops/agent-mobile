/**
 * ice-path.test — the tailnet-vs-LAN decision device-verify makes on the handset.
 *
 * The stage it feeds can only run with a phone attached. This is the half that can be checked
 * here, and it is the half most likely to be wrong: a range predicate whose whole content is
 * where it stops.
 *
 * BOUNDARIES ARE THE TEST. 100.64.0.0/10 runs 100.64 -> 100.127. The two addresses either side
 * are the ones an off-by-one gets wrong, and this host sits at 100.125 — inside the range but
 * above the halfway point, so a `<= 100` or a `<= 126` would still look plausible against a
 * casual read and would classify real traffic as LAN.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTailnetAddr, classifyIcePath, sidecarCgnatRange } from './lib/ice-path.mjs';
import { REPO } from './lib/apk-facts.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nice-path — which interface carried the media\n');

/* ---- the range, at its edges -------------------------------------------------------------- */
ok('100.64.0.1 is tailnet (the first address in the range)', isTailnetAddr('100.64.0.1'));
ok('100.127.255.254 is tailnet (the last)', isTailnetAddr('100.127.255.254'));
ok('this host at 100.125.53.51 is tailnet', isTailnetAddr('100.125.53.51'));
ok('100.63.255.255 is NOT tailnet (one below)', !isTailnetAddr('100.63.255.255'),
  'the range starts at 100.64; 100.63 is ordinary public space');
ok('100.128.0.1 is NOT tailnet (one above)', !isTailnetAddr('100.128.0.1'),
  'the range ends at 100.127');

/* ---- addresses that are emphatically not it ----------------------------------------------- */
ok('a LAN address is not tailnet', !isTailnetAddr('192.168.10.53'));
ok('this Mac\'s own LAN address is not tailnet', !isTailnetAddr('192.168.10.55'),
  'this is the address werift reports as the local candidate — misclassifying it would make '
  + 'every same-network run look like a tailnet run, which is the exact confusion this exists '
  + 'to prevent');
ok('loopback is not tailnet', !isTailnetAddr('127.0.0.1'));
ok('a different 100.x block is not tailnet', !isTailnetAddr('100.200.1.1'));

/* ---- junk in, false out (never a throw, never a true) -------------------------------------- */
for (const junk of [null, undefined, '', '  ', 'not-an-ip', '100.64', '100.64.0',
                    '100.64.0.1.2', '999.999.999.999', '100.300.0.1', 'fe80::1']) {
  ok(`rejects ${JSON.stringify(junk)}`, isTailnetAddr(junk) === false);
}

/* ---- parsing what the sidecar actually logs ------------------------------------------------ */
ok('reads the host out of the sidecar\'s pair line',
  classifyIcePath('100.125.53.51:52975 (host)').via === 'tailnet');
ok('and keeps the host itself',
  classifyIcePath('100.125.53.51:52975 (host)').host === '100.125.53.51');
ok('a LAN pair is classified LAN, not tailnet',
  classifyIcePath('192.168.10.53:38864 (host)').via === 'lan');
ok('the LAN note says the remote-phone claim was not exercised',
  /NOT exercised/.test(classifyIcePath('192.168.10.53:38864 (host)').note),
  'a same-network run that reads as a pass is worse than no run');
ok('a bare host with no port still classifies', classifyIcePath('100.125.53.51').via === 'tailnet');
ok('an IPv6 literal keeps its colons', classifyIcePath('[fd7a::1]:41641').host === 'fd7a::1',
  'splitting on the FIRST colon would leave "[fd7a"');
ok('nothing logged is unknown, not lan', classifyIcePath('').via === 'unknown',
  'reporting "LAN" for a pair that was never observed would be a measurement nobody took');
ok('unknown carries no host', classifyIcePath(null).host === null);

/* ---- the sidecar must gather from the SAME range it will be nominated on -------------------- */
const SC = join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs');
let src = '';
try { src = readFileSync(SC, 'utf8'); } catch { /* reported below */ }
const scSrc = src;
const range = sidecarCgnatRange(src);
ok('the sidecar\'s CGNAT range was found in its source', !!range,
  `could not parse a range out of ${SC} — if tailnetAddresses() was rewritten, this drift check `
  + 'is now blind and must be re-pointed');
if (range) {
  ok(`the sidecar gathers from the same range this classifies (100.${range.lo}-${range.hi})`,
    range.first === 100 && range.lo === 64 && range.hi === 127,
    `sidecar gathers 100.${range.lo}-${range.hi} but this module accepts 100.64-127 — a phone `
    + 'can only nominate an address the sidecar advertised, so a disagreement leaves one of '
    + 'them silently unreachable');
}

/* ---- the log line and the thing that reads it must agree ----------------------------------
 *
 * The device stage is two halves: the sidecar WRITES a line, device-verify READS it with a
 * regex. Only the second half lives in a file a Mac can run, and neither half is exercised
 * without a handset — so a rename on either side would go unnoticed until the ten minutes when
 * someone is standing over the phone, and would present as "ICE path: blocked", which is
 * indistinguishable from the honest no-pair case.
 *
 * Both sides are read out of source here and put together. */
const DV = join(REPO, 'test/device-verify.mjs');
let dvSrc = '';
try { dvSrc = readFileSync(DV, 'utf8'); } catch { /* reported below */ }
const reSrc = (/webrtc ICE pair \(\?:remote=\(\\S\+\)\|unknown\)/.exec(dvSrc) || [])[0];
ok('device-verify still reads the pair line with the expected pattern', !!reSrc,
  'the regex in device-verify no longer looks like the one this checks against — re-point this '
  + 'drift check, or the two halves can diverge unwatched');
const logsIt = /webrtc ICE pair remote=\$\{np\.remote\} local=/.test(scSrc);
ok('the sidecar still WRITES that line', logsIt,
  'the sidecar no longer logs `webrtc ICE pair remote=...` — device-verify would wait, find '
  + 'nothing, and report the path as unobserved on every run');
if (reSrc && logsIt) {
  /* Render what the sidecar produces and run the reader's own pattern over it. */
  const line = '[sidecar] webrtc ICE pair remote=100.125.53.51:52975 (host) '
             + 'local=100.125.53.51:62165 (host)';
  const m = /\[sidecar\] webrtc ICE pair (?:remote=(\S+)|unknown)/.exec(line);
  ok('the reader captures the remote endpoint out of a real line', m && m[1] === '100.125.53.51:52975',
    `captured ${m && m[1]}`);
  ok('and the classifier calls that the tailnet path', classifyIcePath(m && m[1]).via === 'tailnet');
  const un = /\[sidecar\] webrtc ICE pair (?:remote=(\S+)|unknown)/
    .exec('[sidecar] webrtc ICE pair unknown (werift did not expose a nominated pair)');
  ok('the UNKNOWN line matches too, so the run does not sit out the timeout', !!un,
    'matching only remote= made the no-pair case burn 20s reaching a conclusion already logged');
  ok('and it classifies as unknown, not lan', classifyIcePath(un && un[1]).via === 'unknown');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
