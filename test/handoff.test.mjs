/**
 * handoff.test — the arming loop's decisions, which are the part that can be wrong forever.
 *
 * The loop itself spawns processes and needs a phone. What this checks is the schedule and the
 * verdict: a poller that asks the wrong question is exactly what this project already had —
 * a watcher polled mDNS for three and a half hours while the LAN address answered ECONNREFUSED
 * the entire time, and reported a generic line about toggles.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tickPlan, discoveryPlan, passPlan, usableEndpoint, handoffVerdict, subnetHosts,
         aliveFromProbe, foundVia, excludedHosts, endpointState, identityMatches,
         TICK_S, LAN_SWEEP_EVERY_S, TAILNET_SWEEP_EVERY_S }
  from './lib/handoff.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nhandoff — what the arming loop does while it waits\n');

const src = readFileSync(join(REPO, 'test/device-handoff.mjs'), 'utf8');

/* ---- the schedule reflects what each probe COSTS -------------------------------------------- */
ok('mDNS runs every tick — it is free', tickPlan({}).mdns && tickPlan({ elapsedS: 999 }).mdns);

/* THE CABLE. USB is the only path that works with wireless debugging OFF, it costs nothing, and
 * the first version of this loop did not look at all — six hours of sweeping a network while a
 * cable would have answered instantly. */
ok('the USB path is checked on every tick', discoveryPlan({}).tiers.includes('usb'),
  'the one path that does not need the toggle at all');
ok('and mDNS with it', discoveryPlan({}).tiers.includes('mdns'));
ok('the subnet sweep is on a cadence, not every tick',
  !discoveryPlan({ elapsedS: 5, last: { subnet: 0 } }).tiers.includes('subnet'));
ok('the subnet sweep runs when due',
  discoveryPlan({ elapsedS: 999, last: { subnet: 0 } }).tiers.includes('subnet'));
ok('the host sweep only runs when there are live hosts to aim at',
  !discoveryPlan({ elapsedS: 9999, last: { subnet: 9999 }, liveHosts: [] }).tiers.includes('hosts'),
  '254 x 35000 probes is nine million; a handful x 35000 is a minute, and the difference is '
  + 'knowing which hosts answered');
ok('and does when there are',
  discoveryPlan({ elapsedS: 9999, last: { subnet: 9999 }, liveHosts: ['192.168.10.53'] })
    .tiers.includes('hosts'));
ok('the slow tailnet sweep never shares a tick with a faster one',
  (() => { const t = discoveryPlan({ elapsedS: 99999, last: {}, liveHosts: ['x'] }).tiers;
           return !(t.includes('tailnet') && (t.includes('subnet') || t.includes('hosts'))); })());
ok('a /24 is 254 hosts, not 256', subnetHosts('192.168.10.55').length === 254,
  'network and broadcast addresses are not hosts');
ok('subnetHosts covers the address it was given',
  subnetHosts('192.168.10.55').includes('192.168.10.53'));
ok('subnetHosts rejects junk',
  subnetHosts('') === null && subnetHosts('192.168.10') === null && subnetHosts('999.1.1.1') === null);

/* WHICH PATH FOUND IT is as important as whether. */
ok('usb says the network was irrelevant', /cable is in/.test(foundVia('usb', 'X').note));
ok('mdns says the phone is advertising on this segment',
  /advertising/.test(foundVia('mdns', 'x:1').note));
ok('a subnet find warns the address may have moved',
  /may have moved/.test(foundVia('subnet', 'x:1').note),
  'mDNS not advertising while a sweep finds it is a different situation from mDNS working');
ok('a tailnet find says the phone is NOT on this network',
  /NOT on this network/.test(foundVia('tailnet', 'x:1').note),
  'that is the case the remote-path claim needs, and it must not be silently equated with a '
  + 'LAN find');
ok('every path carries a distinct note',
  new Set(['usb', 'mdns', 'subnet', 'hosts', 'tailnet'].map((t) => foundVia(t, 'x:1').note)).size === 5);
ok('a host that answered is alive, refused or open',
  aliveFromProbe('ECONNREFUSED') && aliveFromProbe('open') && !aliveFromProbe(null)
  && !aliveFromProbe('ETIMEDOUT'),
  'refused means the host answered and nothing is on that port; a timeout means nothing was '
  + 'there to answer');
ok('the LAN sweep does NOT run every tick',
  !tickPlan({ elapsedS: 5, lastLanSweepS: 0, hasLan: true }).lanSweep,
  'a 60s sweep every 20s would never finish a cycle');
ok('but it does run once its cadence is due',
  tickPlan({ elapsedS: LAN_SWEEP_EVERY_S + 1, lastLanSweepS: 0, hasLan: true }).lanSweep);
ok('the LAN sweep is skipped when there is no LAN address',
  !tickPlan({ elapsedS: 99999, lastLanSweepS: 0, hasLan: false }).lanSweep,
  'tailscale reports no direct endpoint, so there is nothing to sweep');
ok('the TAILNET sweep is rarer than the LAN one',
  TAILNET_SWEEP_EVERY_S > LAN_SWEEP_EVERY_S,
  'a closed port on the TUN times out rather than refusing, so it costs minutes for the same '
  + 'answer the LAN gives in seconds');
ok('the two sweeps never run on the same tick',
  (() => { const p = tickPlan({ elapsedS: 99999, lastLanSweepS: 0, lastTailnetSweepS: 0,
                                hasLan: true });
           return !(p.lanSweep && p.tailnetSweep); })(),
  'the slow one would be queued behind the fast one for the same information');
ok('with a LAN path available the slow sweep gives way to the fast one',
  (() => { const p = tickPlan({ elapsedS: 99999, lastLanSweepS: 0, lastTailnetSweepS: 0,
                                hasLan: true });
           return p.lanSweep && !p.tailnetSweep; })());
ok('without one, the slow sweep is all there is',
  (() => { const p = tickPlan({ elapsedS: 99999, lastTailnetSweepS: 0, hasLan: false });
           return p.tailnetSweep; })());
ok('every plan says WHY, so the log is not a wall of identical lines',
  typeof tickPlan({}).why === 'string' && tickPlan({}).why.length > 8);
ok('the tick is not a hot spin', TICK_S >= 10, `${TICK_S}s`);

/* ---- what runs when it finds something ------------------------------------------------------
 * TWO passes. The full sweep negotiates WebRTC, whose downlink is paced, so it exercises the
 * easy side of stop-control. The bug the flush was written for only shows on the WS fallback. */
const plan = passPlan({ apk: 'x.apk' });
ok('the full sweep runs first', plan[0].name === 'full sweep');
ok('and a WS-fallback Stop pass runs after it', plan.length === 2 && /WS-fallback/.test(plan[1].name),
  'a handoff that ran the full sweep alone would report a pass over the case stop-control was '
  + 'supposed to settle');
ok('the WS pass actually passes --ws-fallback',
  plan[1].args.includes('--ws-fallback'), JSON.stringify(plan[1].args));
ok('and scopes itself to the stop phase',
  plan[1].args.includes('--only') && plan[1].args.includes('stop'), JSON.stringify(plan[1].args));
ok('both passes carry the APK that was staged',
  plan.every((p) => p.env.AGENTMOB_APK === 'x.apk'),
  'the passes would install the debug build while the release one was the staged artifact');
ok('--no-ws leaves just the full sweep',
  passPlan({ apk: 'x.apk', wsFallback: false }).length === 1);
ok('each pass explains itself', plan.every((p) => typeof p.why === 'string' && p.why.length > 20));

/* ---- endpoints ------------------------------------------------------------------------------ */
ok('a host:port is usable', usableEndpoint('192.168.10.53:37129'));
ok('an IPv6 literal is usable', usableEndpoint('[fd7a::1]:41641'));
ok('a bare host is NOT usable', !usableEndpoint('192.168.10.53'),
  'adb connect needs the port, and the wireless-debugging one is randomised per toggle');
ok('junk is not usable',
  !usableEndpoint('') && !usableEndpoint(null) && !usableEndpoint('nope') && !usableEndpoint('1.2.3.4:0'));
ok('a port above the range is not usable', !usableEndpoint('1.2.3.4:70000'));

/* ---- AN OPEN PORT IS NOT A PHONE -------------------------------------------------------------
 *
 * The first tiered run found 192.168.10.55:49152 — this Mac, running rapportd — and began
 * installing an APK against it. Two mistakes at once: the sweep included its own address, and a
 * port being open was taken as proof adb was behind it. The second is the dangerous one: on a
 * network with another Android exposing adb over 5555, an unguarded handoff installs this app
 * on a stranger's phone and runs a mute test on it. */
ok('the sweep never includes this machine',
  excludedHosts({ selfLan: '192.168.10.55' }).has('192.168.10.55'),
  'it swept its own address and found a local service');
ok('nor loopback', excludedHosts({}).has('127.0.0.1'));
ok('the runner applies the exclusion',
  /excludedHosts\(\{ selfLan \}\)/.test(src) && /!skip\.has\(h\)/.test(src));

const DEVICES = ['List of devices attached',
  '192.168.10.53:37129\tdevice product:panther model:Pixel_7',
  '192.168.10.99:5555\tunauthorized',
  '192.168.10.98:5555\toffline'].join('\n');
ok('a listed, ready endpoint is present and ready',
  endpointState(DEVICES, '192.168.10.53:37129').ready === true);
ok('an UNAUTHORIZED endpoint is present but not ready',
  (() => { const st = endpointState(DEVICES, '192.168.10.99:5555');
           return st.present && !st.ready && st.state === 'unauthorized'; })(),
  'the phone is there and showing a prompt — a real finding with its own instruction, but not '
  + 'something to install onto');
ok('an OFFLINE endpoint is not ready',
  !endpointState(DEVICES, '192.168.10.98:5555').ready);
ok('an endpoint adb never listed is NOT present',
  !endpointState(DEVICES, '192.168.10.55:49152').present,
  'this is the exact false positive: a socket answered, adb never saw a device');
ok('an empty device list confirms nothing',
  !endpointState('List of devices attached', 'x:1').present && !endpointState('', 'x:1').present);
ok('a prefix of another entry is not a match',
  !endpointState('List of devices attached\n192.168.10.530:5555\tdevice', '192.168.10.53').present,
  'string containment would match a different address');

ok('the right model is accepted',
  identityMatches({ model: 'Pixel 7', serial: 'X' }).ok);
ok('ANOTHER Android on the segment is refused',
  !identityMatches({ model: 'SM-G991B', serial: 'Y' }).ok,
  'installing onto it is not a test failure, it is somebody else\'s phone with our app on it');
ok('and the refusal says why',
  /refusing to install on a device this run did not mean to touch/
    .test(identityMatches({ model: 'SM-G991B' }).why));
ok('a device that reports no model is refused, not assumed',
  !identityMatches({ model: '' }).ok && /cannot be identified/.test(identityMatches({ model: '' }).why));
ok('an explicit serial overrides the model check',
  identityMatches({ model: 'whatever', serial: 'ABC', expectSerial: 'ABC' }).ok
  && !identityMatches({ model: 'Pixel 7', serial: 'ABC', expectSerial: 'ZZZ' }).ok,
  'the serial is the exact answer when the model is ambiguous');
ok('the runner checks adb BEFORE running anything',
  /endpointState\(adb\(\['devices'/.test(src) && src.indexOf('endpointState(') < src.indexOf('if (confirmed)'),
  'the passes would run against whatever answered');
ok('the runner checks the identity before running anything',
  /identityMatches\(\{ model/.test(src) && src.indexOf('identityMatches(') < src.indexOf('if (confirmed)'));
/* AND KEEPS LOOKING. The confirmation lived AFTER the loop, so the first candidate ended the
 * run whatever it was: an arming run died after 39 seconds because a Plex server on
 * 192.168.10.54:32400 answered a sweep. "Continuing to look" was printed by a branch that could
 * not continue. A six-hour waiter that gives up on the first open port is worse than none. */
ok('a rejected candidate does NOT end the run',
  /found = null;\s*\/\/ keep arming/.test(src),
  'the loop exited on the first thing that answered a sweep');
ok('the confirmation happens inside the arming loop',
  src.indexOf('CANDIDATE ${cand}') < src.indexOf('const endpoint = confirmed;'),
  'confirming after the loop means the loop can only ever consider one candidate');
ok('a rejected endpoint is remembered and not re-offered',
  /rejected\.add\(cand\)/.test(src) && /!rejected\.has\(e\)/.test(src),
  'the same Plex port would be found again on every sweep');
ok('the loop runs until a CONFIRMED device, not until any candidate',
  /while \(Date\.now\(\) < deadline && !confirmed\)/.test(src));
ok('UNAUTHORIZED is described as a phone with a prompt',
  /Allow wireless debugging/.test(src) && /UNAUTHORIZED/.test(src));
ok('but an OFFLINE socket is not described as one',
  /answered TCP but does not speak adb/.test(src),
  'adb marks a random service offline after connecting to it; calling that an authorization '
  + 'prompt sends someone to look at a phone that is not involved');

ok('an unconfirmed candidate runs NO passes',
  /if \(confirmed\) \{/.test(src) && /let confirmed = null;/.test(src),
  'a candidate and a confirmed device must not take the same path');
ok('and the verdict is computed from the CONFIRMED device, not the candidate',
  /handoffVerdict\(\{ found: !!confirmed/.test(src),
  'a rejected candidate would otherwise report as a device that was found');
ok('a rejected candidate is disconnected again',
  /adb\(\['disconnect', cand\]/.test(src),
  'leaving a stranger\'s device attached to this adb server is not tidy');

/* ---- THE VERDICT, which must not read like a pass -------------------------------------------- */
const armedNothing = handoffVerdict({ found: false, elapsedS: 3600 });
ok('finding nothing is reported as finding nothing', armedNothing.armed === true);
ok('and says so in words that cannot be read as a pass',
  /NOT a device pass/.test(armedNothing.note), armedNothing.note);
ok('it names the reason, not just the outcome',
  /Wireless debugging/.test(armedNothing.note), armedNothing.note);
const arrived = handoffVerdict({ found: true, ranPasses: 2, elapsedS: 120 });
ok('a handoff that ran passes does NOT claim they succeeded',
  /Read each report for its own verdict/.test(arrived.note),
  'the handoff spawns the passes; their verdicts are theirs: ' + arrived.note);
ok('and it is not still armed', arrived.armed === false);

/* ---- the runner uses them --------------------------------------------------------------------- */
ok('the runner drives discoveryPlan rather than a schedule of its own',
  /discoveryPlan\(/.test(src));
/* REMEMBERING the LAN address, caught on the first tick of the first armed run. tailscale only
 * carries `direct 192.168.10.53:38864` while the peer is active; once the phone idles the row
 * goes to `-` and the parse returns lan: null. The address is still reachable — ECONNREFUSED on
 * 5555, which only a host that answered can produce — so falling back to the tailnet sweep
 * spends minutes on the answer the LAN gives in seconds. Exactly the ask-the-wrong-question
 * failure the schedule exists to avoid, reintroduced by a null. */
ok('the runner keeps the last LAN address it saw',
  /lastKnownLan/.test(src) && /if \(peer\.lan\) lastKnownLan = peer\.lan;/.test(src),
  'an idle phone drops the direct endpoint from tailscale status and the loop would fall back '
  + 'to the slow sweep against a LAN path that is fine');
/* And then stopped depending on it. The remembered address was a patch on a loop that polled
 * ONE host; sweeping this Mac's own /24 does not need to know the phone's address at all, which
 * is the difference between finding it after a DHCP change and logging "nothing open" for six
 * hours. The memory is kept only to seed the sweep's subnet. */
ok('discovery does not depend on knowing the phone\'s address',
  /subnetHosts\(selfLan\)/.test(src),
  'a loop that polls one remembered IP misses a phone whose lease moved — which is what the '
  + 'first armed version did');
ok('the sweep aims at THIS machine\'s subnet',
  /const selfLan = lastKnownLan \|\| /.test(src));
ok('--lan seeds it for a cold start',
  /flag\('--lan'/.test(src) && /AGENTMOB_PHONE_LAN/.test(src),
  'a fresh arming run against an already-idle phone would have nothing to remember');
ok('the log says which subnet it swept and how many answered',
  /addresses on/.test(src) && /alive/.test(src),
  'a sweep that found 11 live hosts and one that found none are different situations, and '
  + '"nothing open" alone cannot tell them apart');
ok('the runner records which PATH found the phone',
  /foundVia\(/.test(src) && /foundVia: found \?/.test(src),
  'usb, mdns, a subnet sweep and the tailnet address mean four different things about where '
  + 'the phone is');
ok('it runs the passes from passPlan', /passPlan\(/.test(src));
ok('it checks the endpoint before handing it to adb',
  /!usableEndpoint\(cand\)/.test(src)
  && src.indexOf('!usableEndpoint(cand)') < src.indexOf("adb(['connect', cand]"),
  'adb connect on a malformed target fails in a way that reads like the phone refusing');
ok('it stops its adb server on every exit path',
  /SIGINT[\s\S]{0,200}stopAdb\(\)/.test(src) && /process\.on\('exit', stopAdb\)/.test(src),
  'an armed loop that leaves a server behind is the thing that needed a manual kill-server once');
ok('it exits non-zero when no device ever appeared',
  /process\.exit\(confirmed \?/.test(src) && /: 3\)/.test(src),
  'exit 0 would make "nothing happened" indistinguishable from "everything passed"');
ok('it writes what it did to a file of its own',
  /device-handoff\.json/.test(src),
  'and not over device-verify.json, which is the passes\' own evidence');

console.log(`\n  This checks the loop's decisions. Whether the phone appears is the phone's`);
console.log('  business, and every acceptance item still waits on it.');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
