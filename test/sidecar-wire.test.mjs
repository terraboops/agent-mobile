/**
 * sidecar-wire.test — the sidecar must not swallow sends to the phone either.
 *
 * The adapter's outbound path took four commits to stop losing messages silently. The sidecar
 * had the same lie one process over: every write to a phone socket was
 * `try { ws.send(...) } catch {}`.
 *
 * It is worse for the ack path. A lost status is a missing indicator; a lost ACK leaves the
 * PHONE waiting on a reply that will never arrive, so it sits through its timeout unable to
 * tell a slow host from a dead one — and the sidecar, which knows exactly what happened, says
 * nothing.
 *
 * Two failures hide behind that bare catch and they are not the same:
 *   socket not OPEN — expected and FREQUENT (status runs several times a second while
 *                     speaking), so it is rate-limited, not silenced
 *   send() threw    — the socket looked usable and the write failed anyway; never routine
 *
 * The distinction is the load-bearing part: logging every closed-socket status would bury the
 * log and get ignored, and silencing them is the bug being fixed. Both failure modes have to
 * be observable without either drowning the other.
 *
 * Run: npm run sidecar-wire
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WIRE = join(homedir(), '.hermes/plugins/agentmob/sidecar/wire.mjs');
if (!existsSync(WIRE)) {
  console.log(`skip: no wire.mjs at ${WIRE} — the sidecar predates this module`);
  process.exit(0);
}
const { sendFrame, wsState, WS_OPEN } = await import(WIRE);

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const mkLog = () => { const lines = []; const f = (m) => lines.push(String(m)); f.lines = lines; return f; };
const mkWs = (state, throws = false) => ({
  readyState: state,
  sent: [],
  send(b) { if (throws) throw new Error('canary: socket refused the write'); this.sent.push(b); },
});

/* ---- 1. the happy path ------------------------------------------------------------------- */
{
  const ws = mkWs(WS_OPEN);
  const log = mkLog();
  const rc = sendFrame({ ws }, Buffer.from('x'), 'status heard', log);
  ok('open socket: the frame is written', rc === true && ws.sent.length === 1);
  ok('open socket: nothing is logged on success', log.lines.length === 0, log.lines.join(' | '));
}

/* ---- 2. socket closed: reported, not swallowed -------------------------------------------- */
{
  const ws = mkWs(3);            // CLOSED
  const log = mkLog();
  const conn = { ws };
  const rc = sendFrame(conn, Buffer.from('x'), 'ack i=7', log);
  ok('closed socket: reports failure', rc === false);
  ok('closed socket: nothing was written', ws.sent.length === 0);
  ok('closed socket: it is LOGGED, not swallowed', log.lines.length === 1, log.lines.join(' | '));
  ok('closed socket: the log names the state', /CLOSED/.test(log.lines[0]), log.lines[0]);
  ok('closed socket: the log names what was lost', /ack i=7/.test(log.lines[0]), log.lines[0]);
}

/* ---- 3. an OPEN socket that throws is ALWAYS loud ----------------------------------------- */
{
  const ws = mkWs(WS_OPEN, true);
  const log = mkLog();
  const rc = sendFrame({ ws }, Buffer.from('x'), 'ack i=9', log);
  ok('throwing socket: reports failure', rc === false);
  ok('throwing socket: logged', log.lines.length === 1, log.lines.join(' | '));
  ok('throwing socket: the log says the socket was OPEN (this is not a disconnect)',
    /OPEN socket/.test(log.lines[0]), log.lines[0]);
  ok('throwing socket: carries the underlying error',
    /canary: socket refused the write/.test(log.lines[0]), log.lines[0]);
  ok('throwing socket: says the phone did not receive it',
    /did not receive/.test(log.lines[0]), log.lines[0]);
}

/* ---- 4. high-frequency traffic is rate-limited, NOT silenced ------------------------------ */
{
  const ws = mkWs(3);
  const log = mkLog();
  const conn = { ws };
  for (let i = 0; i < 120; i++) {
    sendFrame(conn, Buffer.from('x'), 'status level', log, { quietWhenClosed: true, everyNth: 50 });
  }
  ok('quiet mode: the FIRST drop is always reported (silence is the bug)',
    log.lines.length >= 1, 'nothing logged at all');
  ok('quiet mode: it does not log all 120', log.lines.length < 10,
    `${log.lines.length} lines for 120 drops`);
  ok('quiet mode: it keeps reporting periodically (a dead socket cannot look healthy)',
    log.lines.length >= 3, `${log.lines.length} lines — stopped reporting`);
  ok('quiet mode: later lines carry the running count',
    log.lines.some((l) => /undelivered on this connection/.test(l)), log.lines.join(' | '));
  ok('quiet mode: the count is accurate',
    log.lines.some((l) => /100 undelivered/.test(l)), log.lines.slice(-1)[0]);
}

/* ---- 5. an ack is NEVER quieted ----------------------------------------------------------- */
{
  const ws = mkWs(3);
  const log = mkLog();
  const conn = { ws };
  for (let i = 0; i < 5; i++) sendFrame(conn, Buffer.from('x'), `ack i=${i}`, log);
  ok('ack: every lost ack is reported (the phone is waiting on each one)',
    log.lines.length === 5, `${log.lines.length} lines for 5 lost acks`);
}

/* ---- 6. a missing socket must not throw --------------------------------------------------- */
{
  const log = mkLog();
  let threw = null;
  let rc;
  try { rc = sendFrame({ ws: null }, Buffer.from('x'), 'status', log); }
  catch (e) { threw = e; }
  ok('missing socket: does not throw', threw === null, String(threw));
  ok('missing socket: reports failure', rc === false);
  ok('missing socket: says the socket is missing', /missing/.test(log.lines[0] || ''), log.lines[0]);
}

/* ---- 7. state names --------------------------------------------------------------------- */
ok('wsState: CONNECTING', wsState({ readyState: 0 }) === 'CONNECTING');
ok('wsState: OPEN', wsState({ readyState: 1 }) === 'OPEN');
ok('wsState: CLOSING', wsState({ readyState: 2 }) === 'CLOSING');
ok('wsState: CLOSED', wsState({ readyState: 3 }) === 'CLOSED');
ok('wsState: missing', wsState(null) === 'missing');

/* ---- 8. the sidecar actually USES it (not just ships it) ---------------------------------- */
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(homedir(), '.hermes/plugins/agentmob/sidecar/index.mjs'), 'utf8');
  ok('index.mjs imports the helper', /from '\.\/wire\.mjs'/.test(src));
  ok('pushStatus routes through it',
    /function pushStatus[\s\S]{0,900}?sendFrame\(/.test(src),
    'pushStatus still writes to the socket directly');
  ok('the webrtc ack routes through it',
    /const ack = \(d\) => \{[\s\S]{0,500}?sendFrame\(/.test(src),
    'ack still writes to the socket directly');
  ok('no bare `catch {}` remains around a phone send in pushStatus/ack',
    !/conn\.ws\.send\(pack\(T\.cmd[\s\S]{0,80}?catch \{\}/.test(src));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
