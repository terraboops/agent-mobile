/**
 * adb-state.test — every way reaching the phone can fail must be DISTINGUISHABLE.
 *
 * device-verify's wait loop kept only `device` lines and dropped everything else, so a phone
 * sitting there showing an "Allow wireless debugging?" prompt was reported as "no device after
 * N seconds" — sending you to check the network when the fix was a tap on the screen. Silence
 * and mislabelling are the same bug here: the tool reports a state that is not the real one.
 *
 * These are pure functions over real `adb devices -l` output, so every state is exercised
 * without a phone. The assertions check that each message is (a) correct and (b) DIFFERENT from
 * the others — a shared "something went wrong" string would pass a naive test and still leave
 * you guessing.
 *
 * Run: npm run adb-state
 */
import { classifyDevices, stateLabel, describeBlocked, connectErrorOf } from './lib/adb-state.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const H = 'List of devices attached';

/* ---- classification --------------------------------------------------------------------- */
{
  const c = classifyDevices(`${H}\n1A2B3C4D\tdevice product:panther model:Pixel_7\n`);
  ok('ready: a normal device is ready', c.ready.length === 1 && c.ready[0] === '1A2B3C4D');
  ok('ready: nothing lands in another bucket',
    !c.unauthorized.length && !c.offline.length && !c.other.length);
}
{
  const c = classifyDevices(`${H}\n100.112.255.69:40123\tunauthorized\n`);
  ok('unauthorized: bucketed as unauthorized', c.unauthorized.length === 1);
  ok('unauthorized: NOT counted as ready', c.ready.length === 0);
}
{
  const c = classifyDevices(`${H}\n100.112.255.69:40123\toffline\n`);
  ok('offline: bucketed as offline', c.offline.length === 1 && !c.ready.length);
}
{
  const c = classifyDevices(`${H}\nabc\tauthorizing\n`);
  ok('authorizing: bucketed as authorizing', c.authorizing.length === 1 && !c.ready.length);
}
{
  /* "no permissions" has a space in it — a naive split on whitespace mis-reads it. */
  const c = classifyDevices(`${H}\nabc\tno permissions; see [http://x]\n`);
  ok('no permissions: parsed as an "other" state, not dropped',
    c.other.length === 1 && c.other[0].state === 'no permissions', JSON.stringify(c.other));
}
{
  const c = classifyDevices(`* daemon not running; starting now at tcp:5037\n* daemon started successfully\n${H}\n\n`);
  ok('daemon chatter: produces no phantom devices',
    !c.ready.length && !c.unauthorized.length && !c.offline.length && !c.other.length);
}
{
  const c = classifyDevices(`${H}\nAAA\tdevice\nBBB\tunauthorized\n`);
  ok('mixed: the ready one is still found', c.ready.length === 1 && c.ready[0] === 'AAA');
  ok('mixed: the unauthorized one is still reported', c.unauthorized.length === 1);
}

/* ---- the messages must differ, and must name the next action ---------------------------- */
const msg = (stdout, extra = {}) => describeBlocked({
  classified: classifyDevices(stdout), waitedS: 30, ...extra,
});

const mUnauth = msg(`${H}\nX\tunauthorized\n`);
const mOffline = msg(`${H}\nX\toffline\n`);
const mAuthing = msg(`${H}\nX\tauthorizing\n`);
const mOther = msg(`${H}\nX\tno permissions\n`);
const mNone = msg(H);
const mNoneConn = msg(H, { connectTarget: '100.112.255.69:5555', connectError: 'failed to connect' });
const mOffTailnet = msg(H, { connectTarget: '100.112.255.69:5555',
  tailnet: { checked: true, reachable: false, note: 'last seen 2h ago' } });
const mOnTailnet = msg(H, { connectTarget: '100.112.255.69:5555',
  tailnet: { checked: true, reachable: true, note: 'pong' }, connectError: 'Connection refused' });

ok('unauthorized message names the on-phone prompt',
  /Allow wireless debugging/i.test(mUnauth) && /UNAUTHORIZED/.test(mUnauth), mUnauth);
ok('unauthorized message says a human must tap it', /tap allow/i.test(mUnauth), mUnauth);
ok('offline message says toggle wireless debugging', /OFFLINE/.test(mOffline) && /toggle/i.test(mOffline), mOffline);
ok('authorizing message is its own state', /AUTHORIZING/.test(mAuthing), mAuthing);
ok('other state is named verbatim', /no permissions/.test(mOther), mOther);
ok('no-device message suggests enabling wireless debugging', /Wireless debugging/i.test(mNone), mNone);

/* The distinction that matters tonight: phone off the tailnet vs port shut. */
ok('off-tailnet message says the phone is not reachable, not "no device"',
  /NOT REACHABLE on the tailnet/.test(mOffTailnet) && /last seen 2h ago/.test(mOffTailnet), mOffTailnet);
ok('on-tailnet-but-closed says wireless debugging is OFF',
  /IS reachable/.test(mOnTailnet) && /Wireless debugging is OFF/.test(mOnTailnet), mOnTailnet);
ok('the two network cases do not share a message', mOffTailnet !== mOnTailnet);

/* No two states may produce the same words — that is what "distinguishable" means. */
const all = { mUnauth, mOffline, mAuthing, mOther, mNone, mNoneConn, mOffTailnet, mOnTailnet };
const seen = new Map();
let dup = null;
for (const [k, v] of Object.entries(all)) {
  if (seen.has(v)) dup = `${seen.get(v)} and ${k}`;
  seen.set(v, k);
}
ok('every failure state produces a DIFFERENT message', !dup, dup || '');
ok('no message is the old catch-all "no device after N seconds" for a present device',
  ![mUnauth, mOffline, mAuthing, mOther].some((m) => /^no device/.test(m)));

/* ---- state labels drive "only print real changes" --------------------------------------- */
ok('label: ready', stateLabel(classifyDevices(`${H}\nX\tdevice\n`)) === 'ready:X');
ok('label: unauthorized', stateLabel(classifyDevices(`${H}\nX\tunauthorized\n`)) === 'unauthorized:X');
ok('label: none', stateLabel(classifyDevices(H)) === 'none');
ok('label: none carries the connect error so a change in it is noticed',
  stateLabel(classifyDevices(H), { connectError: 'refused' }) === 'none:refused');
ok('label: a steady state is stable (no spurious "changes")',
  stateLabel(classifyDevices(`${H}\nX\toffline\n`)) === stateLabel(classifyDevices(`${H}\nX\toffline\n`)));

/* ---- adb connect output ------------------------------------------------------------------ */
ok('connect: success is not an error', connectErrorOf('connected to 100.1.2.3:5555', '') === null);
ok('connect: already connected is not an error', connectErrorOf('already connected to 100.1.2.3:5555', '') === null);
ok('connect: refusal is surfaced verbatim',
  /Connection refused/.test(connectErrorOf('', 'failed to connect to 100.1.2.3:5555: Connection refused') || ''));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
