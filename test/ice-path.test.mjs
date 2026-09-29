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
import { isTailnetAddr, classifyIcePath, sidecarCgnatRange, classifyTailnetPath,
         isPrivateAddr } from './lib/ice-path.mjs';
import { REPO } from './lib/apk-facts.mjs';
import { parseTailscalePeer } from './lib/adb-discover.mjs';

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

/* ---- what is UNDERNEATH the tailnet address ------------------------------------------------
 * The assertions above settle which candidate pair carried the media. They say nothing about
 * where those packets actually went: Tailscale will set up a DIRECT path to a LAN-local
 * endpoint, and then 100.x traffic never leaves the subnet. Measured on this machine while
 * writing this — `direct 192.168.10.53:38864` — so a device run here would report "ICE over the
 * Tailscale TUN" truthfully and prove nothing about reaching this Mac from elsewhere. */
const peerDirectLan = { found: true, online: true, offline: false, lan: '192.168.10.53',
                        relay: null, line: '' };
const peerDirectPub = { ...peerDirectLan, lan: '108.175.227.79' };
const peerRelay = { ...peerDirectLan, lan: null, relay: 'tor' };
const peerOffline = { found: true, online: false, offline: true, lan: null, relay: null, line: '' };
const peerMissing = { found: false, online: false, offline: false, lan: null, relay: null, line: '' };

ok('tailnet path: a direct LAN path does NOT exercise the remote case',
  classifyTailnetPath(peerDirectLan).kind === 'direct-lan'
  && classifyTailnetPath(peerDirectLan).exercisesRemote === false,
  JSON.stringify(classifyTailnetPath(peerDirectLan)));
ok('tailnet path: and says how to exercise it',
  /mobile data/.test(classifyTailnetPath(peerDirectLan).note),
  'the operator is told the run was weak but not what would make it strong');
ok('tailnet path: a direct PUBLIC endpoint does exercise it',
  classifyTailnetPath(peerDirectPub).kind === 'direct-remote'
  && classifyTailnetPath(peerDirectPub).exercisesRemote === true,
  JSON.stringify(classifyTailnetPath(peerDirectPub)));
ok('tailnet path: a DERP relay exercises it too',
  classifyTailnetPath(peerRelay).kind === 'relay'
  && classifyTailnetPath(peerRelay).exercisesRemote === true,
  JSON.stringify(classifyTailnetPath(peerRelay)));
ok('tailnet path: an offline peer is not reported as remote',
  classifyTailnetPath(peerOffline).kind === 'offline'
  && classifyTailnetPath(peerOffline).exercisesRemote === false);
ok('tailnet path: a peer that is not in the status output is unknown, not remote',
  classifyTailnetPath(peerMissing).kind === 'unknown'
  && classifyTailnetPath(peerMissing).exercisesRemote === false,
  'absent read as remote would claim a path nobody observed');
ok('tailnet path: an active peer with neither endpoint nor relay is unknown',
  classifyTailnetPath({ found: true, online: true, lan: null, relay: null }).kind === 'unknown');

/* the private-address test the classification turns on, at its edges */
for (const a of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.10.53', '127.0.0.1',
                 '169.254.1.1']) {
  ok(`private: ${a}`, isPrivateAddr(a));
}
for (const a of ['172.15.0.1', '172.32.0.1', '108.175.227.79', '8.8.8.8']) {
  ok(`public: ${a}`, !isPrivateAddr(a));
}
/* Named literally rather than built in the loop above, because this one is the hinge: if a
 * tailnet address reads as private, EVERY path classifies as local, the remote case can never
 * be reported as exercised, and the stage becomes a permanent red that people route around. */
ok('a tailnet address is not a LAN address', !isPrivateAddr('100.112.255.69'),
  'treating 100.64/10 as private classifies every tailnet path as local');

/* THE FIRST OCTET, which nothing asserted until a dead-predicate sweep removed it and every
 * test still passed. The boundary cases above all vary the SECOND octet (172.15 / 172.32), so
 * dropping `o[0] === 172` left `o[1] >= 16 && o[1] <= 31` matching any address at all with a
 * second octet in that range — including 100.20.x.x, a TAILNET address, which would then
 * classify as direct-lan and report a remote path as local. The check was live; the coverage
 * was not, and those look identical from a green run. */
for (const a of ['100.20.1.1', '8.20.0.1', '42.20.0.1']) {
  ok(`the 172.16/12 range does not admit ${a}`, !isPrivateAddr(a),
    'only the second octet was ever varied, so the first-octet test had nothing behind it');
}
for (const a of ['100.168.1.1', '8.168.0.1']) {
  ok(`the 192.168/16 range does not admit ${a}`, !isPrivateAddr(a));
}
for (const a of ['100.254.1.1', '8.254.0.1']) {
  ok(`the 169.254/16 range does not admit ${a}`, !isPrivateAddr(a));
}
for (const a of ['100.0.0.1', '11.0.0.1']) {
  ok(`10/8 does not admit ${a}`, !isPrivateAddr(a));
}
ok('private: junk is not private', !isPrivateAddr('') && !isPrivateAddr(null)
  && !isPrivateAddr('192.168.10') && !isPrivateAddr('999.1.1.1'));

/* ---- THROUGH THE REAL PARSER, not hand-built peer objects ----------------------------------
 * Everything above hands classifyTailnetPath a literal. That tests the classification and not
 * the join: parseTailscalePeer produces these objects, and if its shape and the classifier's
 * expectations ever drift, both suites stay green while the stage reports nonsense. These are
 * real `tailscale status` rows off this tailnet, one per shape the classifier claims to know. */
const ROWS = {
  lan:     '100.112.255.69   pixel-7           terra@          android  active; direct 192.168.10.53:38864, tx 2276 rx 1180',
  remote:  '100.111.36.9     grafana           tagged-devices  linux    active; direct 108.175.227.79:53081, tx 1012416 rx 4917668',
  relayed: '100.79.45.7      bc-prod           tagged-devices  linux    active; relay "tor", tx 587016 rx 3384056',
  idle:    '100.127.47.100   alertmanager      tagged-devices  linux    -',
};
const viaParser = (row, ip) => classifyTailnetPath(parseTailscalePeer(row, ip));
ok('real row: a same-LAN phone classifies direct-lan end to end',
  viaParser(ROWS.lan, '100.112.255.69').kind === 'direct-lan',
  JSON.stringify(viaParser(ROWS.lan, '100.112.255.69')));
ok('real row: and is NOT counted as exercising the remote case',
  viaParser(ROWS.lan, '100.112.255.69').exercisesRemote === false);
ok('real row: a public direct endpoint classifies direct-remote',
  viaParser(ROWS.remote, '100.111.36.9').kind === 'direct-remote'
  && viaParser(ROWS.remote, '100.111.36.9').exercisesRemote === true,
  JSON.stringify(viaParser(ROWS.remote, '100.111.36.9')));
ok('real row: a DERP-relayed peer classifies relay and counts as remote',
  viaParser(ROWS.relayed, '100.79.45.7').kind === 'relay'
  && viaParser(ROWS.relayed, '100.79.45.7').exercisesRemote === true,
  JSON.stringify(viaParser(ROWS.relayed, '100.79.45.7')));
ok('real row: the relay NAME survives the parse',
  viaParser(ROWS.relayed, '100.79.45.7').via === 'tor',
  'the DERP region is the one fact that says WHERE it relayed');
ok('real row: an idle peer with no path is not reported as remote',
  viaParser(ROWS.idle, '100.127.47.100').exercisesRemote === false,
  JSON.stringify(viaParser(ROWS.idle, '100.127.47.100')));
ok('real row: a peer absent from the output is unknown, not remote',
  viaParser(ROWS.lan, '100.99.99.99').kind === 'unknown'
  && viaParser(ROWS.lan, '100.99.99.99').exercisesRemote === false,
  'asking about an ip that is not in the status text must not inherit another row\'s verdict');
ok('real row: no two shapes share a verdict',
  new Set(['lan', 'remote', 'relayed', 'idle'].map((k) =>
    viaParser(ROWS[k], ROWS[k].split(/\s+/)[0]).kind)).size === 4,
  JSON.stringify(['lan', 'remote', 'relayed', 'idle'].map((k) =>
    viaParser(ROWS[k], ROWS[k].split(/\s+/)[0]).kind)));

/* and the wiring */
{
  const dv = readFileSync(join(REPO, 'test/device-verify.mjs'), 'utf8');
  ok('device-verify reports the tailnet path KIND, not only the ICE pair',
    /classifyTailnetPath\(/.test(dv) && /exercises the REMOTE case/.test(dv),
    'a same-network run would report the tailnet claim with nothing qualifying it');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
