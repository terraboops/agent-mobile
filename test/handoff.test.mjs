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
import { tickPlan, passPlan, usableEndpoint, handoffVerdict,
         TICK_S, LAN_SWEEP_EVERY_S, TAILNET_SWEEP_EVERY_S } from './lib/handoff.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('\nhandoff — what the arming loop does while it waits\n');

/* ---- the schedule reflects what each probe COSTS -------------------------------------------- */
ok('mDNS runs every tick — it is free', tickPlan({}).mdns && tickPlan({ elapsedS: 999 }).mdns);
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
const src = readFileSync(join(REPO, 'test/device-handoff.mjs'), 'utf8');
ok('the runner drives tickPlan rather than a schedule of its own', /tickPlan\(/.test(src));
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
ok('and uses it when tailscale has forgotten',
  /const lanAddr = peer\.lan \|\| lastKnownLan;/.test(src));
ok('--lan seeds it for a cold start',
  /flag\('--lan'/.test(src) && /AGENTMOB_PHONE_LAN/.test(src),
  'a fresh arming run against an already-idle phone would have nothing to remember');
ok('the log says when the address is remembered rather than reported',
  /last known — tailscale drops the direct endpoint/.test(src),
  'sweeping a remembered address and a reported one are different confidences');
ok('it runs the passes from passPlan', /passPlan\(/.test(src));
ok('it checks the endpoint before handing it to adb',
  /usableEndpoint\(endpoint\)/.test(src),
  'adb connect on a malformed target fails in a way that reads like the phone refusing');
ok('it stops its adb server on every exit path',
  /SIGINT[\s\S]{0,200}stopAdb\(\)/.test(src) && /process\.on\('exit', stopAdb\)/.test(src),
  'an armed loop that leaves a server behind is the thing that needed a manual kill-server once');
ok('it exits non-zero when no device ever appeared',
  /process\.exit\(endpoint \?/.test(src) && /: 3\)/.test(src),
  'exit 0 would make "nothing happened" indistinguishable from "everything passed"');
ok('it writes what it did to a file of its own',
  /device-handoff\.json/.test(src),
  'and not over device-verify.json, which is the passes\' own evidence');

console.log(`\n  This checks the loop's decisions. Whether the phone appears is the phone's`);
console.log('  business, and every acceptance item still waits on it.');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
