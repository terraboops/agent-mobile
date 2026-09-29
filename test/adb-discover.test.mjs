/**
 * adb-discover.test — prove the endpoint discovery without a phone.
 *
 * Wireless debugging picks a RANDOM port that changes every time the toggle is cycled, so an
 * armed verify holding a hand-supplied host:port only completes if a human reads a number off a
 * screen — and a stale number fails quietly, leaving the run looking patient rather than stuck.
 *
 * Two paths, because neither covers both cases, and the test has to show both:
 *   mDNS  exact and instant, but LINK-LOCAL — it does not cross Tailscale, so it is blind to a
 *         remote phone. Exercised by parsing real `adb mdns services` output.
 *   scan  the only option when the phone is remote, which is the normal case here. Exercised
 *         against a REAL listener this test stands up on loopback — the discovery genuinely
 *         finds a socket nobody told it about, which is the whole claim.
 *
 * Run: npm run adb-discover
 */
import { createServer } from 'node:net';
import { parseMdnsServices, pickAdbEndpoints, scanPorts, discover, DEFAULT_SCAN_RANGES,
         parseTailscalePeer, classifyConnect , describeDiscovery } from './lib/adb-discover.mjs';

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* ---- 1. parse real `adb mdns services` output -------------------------------------------- */
{
  const out = [
    'List of discovered mdns services',
    'adb-39091FDJH004TF-vWDsdX\t_adb-tls-connect._tcp\t192.168.1.42:37129',
    'adb-39091FDJH004TF-pairing\t_adb-tls-pairing._tcp\t192.168.1.42:41003',
  ].join('\n');
  const svc = parseMdnsServices(out);
  ok('mdns: both services parsed', svc.length === 2, JSON.stringify(svc));
  ok('mdns: the header line is not a service', !svc.some((s) => /List of/.test(s.name)));
  ok('mdns: host and port split correctly',
    svc[0].host === '192.168.1.42' && svc[0].port === 37129, JSON.stringify(svc[0]));

  const picks = pickAdbEndpoints(svc);
  ok('mdns: the CONNECT service is kept ahead of the pairing one',
    picks[0].type === '_adb-tls-connect._tcp', JSON.stringify(picks[0]));

  /* THE ORDER IN THE FIXTURE ABOVE IS THE CONNECT SERVICE FIRST, so the assertion on it passes
   * whether or not pickAdbEndpoints prefers anything — a stable sort leaves an already-correct
   * list alone. Deleting the connect/pairing tie-break entirely left that assertion green.
   * Found by mutation, not by reading.
   *
   * Android advertises both records and the order it advertises them in is not ours to choose,
   * so the case that matters is the one where pairing comes first. Connecting to the pairing
   * port fails in a way that reads like the phone refusing this host rather than the wrong
   * record having been picked, which is an expensive thing to debug from a phone screen. */
  const reversed = parseMdnsServices([
    'List of discovered mdns services',
    'adb-39091FDJH004TF-pairing\t_adb-tls-pairing._tcp\t192.168.1.42:41003',
    'adb-39091FDJH004TF-vWDsdX\t_adb-tls-connect._tcp\t192.168.1.42:37129',
  ].join('\n'));
  ok('mdns: pairing listed first is still not the one chosen',
    reversed.length === 2 && reversed[0].type === '_adb-tls-pairing._tcp',
    'the reversed fixture did not parse in the order it was written, so the next assertion '
    + 'would prove nothing');
  ok('mdns: the CONNECT service is chosen, not the pairing one',
    pickAdbEndpoints(reversed)[0].type === '_adb-tls-connect._tcp',
    JSON.stringify(pickAdbEndpoints(reversed)[0]));
  ok('mdns: the pairing record is filtered out entirely, not merely outranked',
    !pickAdbEndpoints(reversed).some((p) => /pairing/.test(p.type)),
    'a pairing endpoint that survives into the list can still be reached for by a later caller');

  /* AND THE TIE-BREAK, which the two cases above do NOT exercise. The filter drops pairing
   * outright, so the sort never sees it — a mutation aimed at the comparator came back MISSED
   * because the claim it was aimed at is carried by the regex. What the comparator actually
   * decides is _adb-tls-connect._tcp against the plain _adb._tcp, both of which pass the
   * filter. Listed with the plain one first, so only the comparator can reorder it. */
  const mixed = parseMdnsServices([
    'adb-33250DLH2000CB-plain\t_adb._tcp\t192.168.1.42:5555',
    'adb-33250DLH2000CB-vWDsdX\t_adb-tls-connect._tcp\t192.168.1.42:37129',
  ].join('\n'));
  ok('mdns: both the plain and the TLS record survive the filter',
    mixed.length === 2 && pickAdbEndpoints(mixed).length === 2,
    JSON.stringify(mixed));
  ok('mdns: the TLS-connect record outranks the plain one',
    pickAdbEndpoints(mixed)[0].type === '_adb-tls-connect._tcp',
    'wireless debugging is TLS; picking the plain record first means connecting to a port that '
    + 'only exists after `adb tcpip`, which is not the mode this phone is in');
}
{
  /* The address is split on the LAST colon — IPv6 carries its own. */
  const svc = parseMdnsServices('adb-x\t_adb-tls-connect._tcp\t[fe80::1c0b:bd6c]:45678');
  ok('mdns: an IPv6 address is not mangled',
    svc.length === 1 && svc[0].host === 'fe80::1c0b:bd6c' && svc[0].port === 45678,
    JSON.stringify(svc));
}
{
  ok('mdns: empty output yields nothing', parseMdnsServices('List of discovered mdns services\n').length === 0);
  ok('mdns: daemon chatter is ignored',
    parseMdnsServices('* daemon started successfully\nList of discovered mdns services').length === 0);
  ok('mdns: a malformed line is skipped, not thrown on',
    parseMdnsServices('garbage without an address').length === 0);
  ok('mdns: a bad port is rejected',
    parseMdnsServices('adb-x\t_adb-tls-connect._tcp\t1.2.3.4:notaport').length === 0);
}
{
  /* A laptop can see several phones; prefer the one we are actually after. */
  const svc = parseMdnsServices([
    'adb-other\t_adb-tls-connect._tcp\t192.168.1.99:30001',
    'adb-ours\t_adb-tls-connect._tcp\t100.112.255.69:40002',
  ].join('\n'));
  const picks = pickAdbEndpoints(svc, { host: '100.112.255.69' });
  ok('mdns: the expected host wins when several phones are visible',
    picks[0].host === '100.112.255.69', JSON.stringify(picks[0]));
}

/* ---- 2. the SCAN finds a real listener nobody told it about ------------------------------- */
let server, realPort;
await new Promise((resolve) => {
  server = createServer(() => {});
  server.listen(0, '127.0.0.1', () => { realPort = server.address().port; resolve(); });
});
console.log(`\n  stood up a stand-in endpoint on 127.0.0.1:${realPort} (nothing was told this port)\n`);
{
  const found = await scanPorts('127.0.0.1', [[realPort - 3, realPort + 3]], { timeoutMs: 800 });
  ok('scan: finds the open port', found.includes(realPort), `found [${found}]`);
  /* A fake socket WITHOUT setTimeout, which is the only case that guard is for. Every existing
 * scan test uses a stub that happens to have one, so dropping `sock.setTimeout &&` — which
 * would throw — changed nothing. Found by removing it and watching the suite pass. */
{
  const { EventEmitter } = await import('node:events');
  const bare = () => { const e = new EventEmitter(); e.destroy = () => {};
                       setTimeout(() => e.emit('error', new Error('refused')), 1); return e; };
  const open = await scanPorts('x', [[1, 3]], { connect: bare, timeoutMs: 50 });
  ok('scan: a socket with no setTimeout does not crash the sweep', Array.isArray(open),
    'the guard exists for exactly this and nothing exercised it');
}

ok('scan: does not invent closed ones', found.length >= 1 && found.length <= 3, `found [${found}]`);
}
{
  const found = await scanPorts('127.0.0.1', [[realPort + 10, realPort + 20]], { timeoutMs: 800 });
  ok('scan: reports nothing when nothing listens', found.length === 0, `found [${found}]`);
}

/* ---- 3. discover(): mDNS wins when it can see the phone ----------------------------------- */
{
  const log = [];
  let scanRan = false;
  const r = await discover({
    host: '100.112.255.69',
    runMdns: async () => 'List of discovered mdns services\n'
      + 'adb-p\t_adb-tls-connect._tcp\t100.112.255.69:44444',
    /* RECORD the call rather than throwing.
     *
     * This used to `throw` to prove the scan is not run when mDNS answered — which works, right
     * up until mDNS discovery itself breaks. Then discover() falls through to the scan path, the
     * throw escapes as an unhandled rejection, and the suite DIES instead of failing an
     * assertion. The mutation harness recorded that as CAUGHT with no named claim: caught by a
     * stack trace, not by a check. A flag gives the same guarantee and still fails by name. */
    scan: async () => { scanRan = true; return []; },
    log: (m) => log.push(m),
  });
  ok('discover: uses the mDNS endpoint', r.endpoint === '100.112.255.69:44444', String(r.endpoint));
  ok('discover: does not run the scan when mDNS answered', scanRan === false,
    'the scan ran even though mDNS returned an endpoint — on a remote phone that is a 35,000 '
    + 'port sweep nobody needed');
  ok('discover: reports how it found it', r.via === 'mdns', r.via);
  ok('discover: does not scan unnecessarily', !r.tried.includes('scan'), String(r.tried));
}

/* ---- 4. discover(): falls back to the scan when mDNS is blind (the REMOTE case) ------------
 * This is the case that matters here. The Pixel reaches this Mac over DERP, and mDNS is
 * link-local multicast, so it will never appear in `adb mdns services`. */
{
  const log = [];
  const r = await discover({
    host: '127.0.0.1',
    runMdns: async () => 'List of discovered mdns services\n',        // blind, as when remote
    scan: (h, ranges) => scanPorts(h, [[realPort - 2, realPort + 2]], { timeoutMs: 800 }),
    log: (m) => log.push(m),
  });
  ok('discover: falls back to the scan', r.via === 'scan', r.via);
  ok('discover: finds the endpoint by scanning', r.endpoint === `127.0.0.1:${realPort}`,
    String(r.endpoint));
  ok('discover: explains that mDNS being blind is EXPECTED when remote',
    log.some((m) => /does not cross Tailscale/.test(m)), log.join(' | '));
  ok('discover: both paths are recorded', r.tried.join(',') === 'mdns,scan', String(r.tried));
}

/* ---- 5. discover(): nothing found is reported, not thrown --------------------------------- */
{
  const r = await discover({
    host: '127.0.0.1',
    runMdns: async () => '',
    scan: async () => [],
    log: () => {},
  });
  ok('discover: reports no endpoint rather than throwing', r.endpoint === null, String(r.endpoint));
  ok('discover: says it tried both', r.tried.join(',') === 'mdns,scan', String(r.tried));
}
{
  /* adb itself failing must not abort discovery — the scan is still worth a try. */
  const r = await discover({
    host: '127.0.0.1',
    runMdns: async () => { throw new Error('adb: mdns unavailable'); },
    scan: (h) => scanPorts(h, [[realPort - 1, realPort + 1]], { timeoutMs: 800 }),
    log: () => {},
  });
  ok('discover: an mDNS failure falls through to the scan',
    r.endpoint === `127.0.0.1:${realPort}`, String(r.endpoint));
}

/* ---- 6. the ranges cover what Android actually uses --------------------------------------- */
{
  const covers = (p) => DEFAULT_SCAN_RANGES.some(([lo, hi]) => p >= lo && p <= hi);
  ok('ranges: cover adb tcpip 5555', covers(5555));
  ok('ranges: cover the observed wireless-debugging band (37129)', covers(37129));
  ok('ranges: cover high ephemeral ports (61000)', covers(61000));
  ok('ranges: do not sweep the whole low range for nothing', !covers(80) && !covers(8123));
}

/* ---- 7. device-verify actually uses it ---------------------------------------------------- */
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./device-verify.mjs', import.meta.url), 'utf8');
  ok('device-verify imports the discovery', /from '\.\/lib\/adb-discover\.mjs'/.test(src));
  ok('device-verify calls discover()', /await discover\(\{/.test(src));
  ok('device-verify no longer REQUIRES a supplied target',
    /if \(!target && Date\.now\(\) - lastDiscover/.test(src),
    'it still only connects when --connect was given');
  ok('device-verify knows the phone host without a port',
    /AGENTMOB_PHONE_HOST/.test(src));
}

try { server.close(); } catch {}
/* ---- the LAN path -------------------------------------------------------------------------
 * These cases are REAL output, captured 2026-09-27 while the Pixel was on the tailnet. The bug
 * they encode: device-verify scanned only 100.112.255.69 and concluded "nothing is listening"
 * from a timeout. Tailscale knew the whole time that the phone was on this very LAN, and the LAN
 * path answers with CONNECTION REFUSED — which proves the phone is up and adbd is not, where a
 * tailnet timeout proves nothing. */
{
  const real = 'Logged in as terra@\n'
    + '100.125.53.51    macbook    terra@   macOS    -\n'
    + '100.112.255.69   pixel-7    terra@   android  active; direct 192.168.10.53:38864, tx 564 rx 124\n';
  const peer = parseTailscalePeer(real, '100.112.255.69');
  ok('the peer row is found by its tailnet address', peer.found, JSON.stringify(peer));
  ok('the direct LAN address is extracted', peer.lan === '192.168.10.53', peer.lan);
  ok('the peer reads as online', peer.online && !peer.offline);
  ok('a peer that is not in the status output reports not-found',
    parseTailscalePeer(real, '100.99.99.99').found === false);

  /* A relayed peer is NOT on this LAN, so there must be no address to scan — inventing one would
   * send the sweep at a stranger's machine. */
  const relayed = '100.112.255.69   pixel-7   terra@   android   active; relay "tor", tx 1 rx 1\n';
  const rp = parseTailscalePeer(relayed, '100.112.255.69');
  ok('a relayed peer yields no LAN address', rp.lan === null && rp.relay === 'tor', JSON.stringify(rp));

  const off = '100.112.255.69   pixel-7   terra@   android   offline\n';
  ok('an offline peer is reported offline', parseTailscalePeer(off, '100.112.255.69').offline);
}

/* The distinction that carries the diagnosis. */
ok('a refused connection is classified refused',
  classifyConnect("failed to connect to '192.168.10.53:5555': Connection refused") === 'refused');
ok('a timed-out connection is classified timeout',
  classifyConnect("failed to connect to '100.112.255.69:5555': Operation timed out") === 'timeout');
ok('a successful connection is classified connected',
  classifyConnect('connected to 192.168.10.53:37129') === 'connected');
ok('refused and timeout are not conflated',
  classifyConnect('Connection refused') !== classifyConnect('Operation timed out'),
  'treating them alike is what made a timeout read as proof that the phone was idle');

/* discover() must sweep BOTH addresses, in LAN-first order, not just the one it was given. */
{
  const seen = [];
  const res = await discover({
    hosts: ['192.168.10.53', '100.112.255.69'],
    runMdns: async () => 'List of discovered mdns services\n',
    scan: async (h) => { seen.push(h); return []; },
    ranges: [[1, 1]],
  });
  ok('both hosts are swept when the LAN path exists',
    seen.join(',') === '192.168.10.53,100.112.255.69', seen.join(','));
  ok('each swept host is reported', res.scanned && '192.168.10.53' in res.scanned
    && '100.112.255.69' in res.scanned);
  ok('no endpoint is invented when nothing is open', res.endpoint === null);
}
{
  const seen = [];
  await discover({ hosts: ['a', 'b'], runMdns: async () => '',
    scan: async (h) => { seen.push(h); return h === 'a' ? [5555] : []; }, ranges: [[1, 1]] });
  ok('sweeping stops at the first host that answers', seen.join(',') === 'a', seen.join(','));
}

/* ---- a skipped sweep must not be logged as a performed one ---------------------------------
 * device-verify polls mDNS often and sweeps rarely, so most passes deliberately send no packets.
 * discover() logged "scanning <ip>" before the call and "nothing open on <ip>" after, on EVERY
 * pass — so an armed run printed a thousand claims of sweeps it never ran. "nothing open" is a
 * measurement; reporting one that was never taken is the same defect as any other check that
 * says it did something it did not.
 *
 * null now means SKIPPED and [] means swept-and-empty, and the log tells them apart. */
{
  const lines = [];
  const res = await discover({
    hosts: ['10.0.0.1', '10.0.0.2'],
    runMdns: async () => '',
    scan: async () => null,                      // every host skipped
    ranges: [[1, 1]],
    log: (m) => lines.push(m),
  });
  ok('a skipped pass does not log "scanned <host>"', !lines.some((l) => /^scanned /.test(l)),
    lines.join(' | '));
  ok('a skipped pass does not report "nothing open" — a measurement nobody took',
    !lines.some((l) => /nothing open/.test(l)), lines.join(' | '));
  ok('each skipped host says so explicitly',
    lines.filter((l) => /skipped this pass/.test(l)).length === 2, lines.join(' | '));
  ok('the result records that no sweep happened', res.didScan === false);
  ok('skipped hosts are recorded as null, not as an empty result',
    res.scanned['10.0.0.1'] === null && res.scanned['10.0.0.2'] === null);
  ok('the tried list does not claim a scan was attempted',
    res.tried.includes('scan-skipped') && !res.tried.includes('scan'), res.tried.join(','));
}
{
  const lines = [];
  const res = await discover({
    hosts: ['10.0.0.1'], runMdns: async () => '',
    scan: async () => [],                        // genuinely swept, found nothing
    ranges: [[1, 1]], log: (m) => lines.push(m),
  });
  ok('a real sweep that finds nothing still reports it',
    lines.some((l) => /nothing open on 10\.0\.0\.1/.test(l)), lines.join(' | '));
  ok('the result records that a sweep did happen', res.didScan === true);
  ok('a swept host records an array, not null', Array.isArray(res.scanned['10.0.0.1']));
}
{
  /* Mixed: first host skipped, second swept and found something. */
  const lines = [];
  let n = 0;
  const res = await discover({
    hosts: ['a', 'b'], runMdns: async () => '',
    scan: async () => (n++ === 0 ? null : [5555]),
    ranges: [[1, 1]], log: (m) => lines.push(m),
  });
  ok('a skipped host does not prevent a later host from being found',
    res.endpoint === 'b:5555', String(res.endpoint));
  ok('mixed results are recorded per host', res.scanned.a === null && Array.isArray(res.scanned.b));
}

/* ---- the line anyone reads FIRST when the toggle lands --------------------------------------
 * The two failure verdicts next door have had assertions since they were written. This one was
 * built inline in device-verify — which cannot run without a handset — so the success line had
 * nothing standing over it at all. */
{
  const viaMdns = describeDiscovery({ endpoint: '192.168.10.53:37129', via: 'mdns' });
  const viaScan = describeDiscovery({ endpoint: '100.112.255.69:44123', via: 'scan',
                                      host: '100.112.255.69' });
  ok('discovery verdict: names the endpoint it found',
    /192\.168\.10\.53:37129/.test(viaMdns), viaMdns);
  ok('discovery verdict: says it was mDNS, and what that implies',
    /mDNS/.test(viaMdns) && /LAN/.test(viaMdns), viaMdns);
  ok('discovery verdict: a swept endpoint says it was SWEPT, naming the host',
    /sweep/.test(viaScan) && /100\.112\.255\.69/.test(viaScan), viaScan);
  /* SAME endpoint, two methods. Comparing viaMdns to viaScan whole compares two strings that
   * already differ in the address they carry — collapsing the method clause entirely still left
   * them unequal, and a mutation that did exactly that came back WRONG-CLAIM against this line.
   * The method is the variable under test, so it has to be the only one. */
  const sameEp = (via) => describeDiscovery({ endpoint: '1.2.3.4:5', via, host: '1.2.3.4' });
  ok('discovery verdict: the two methods do not share wording',
    sameEp('mdns') !== sameEp('scan'),
    'how it was found has different implications for the tailnet claim the ICE stage makes '
    + 'later — mDNS is link-local, a sweep is not: ' + sameEp('mdns'));
  ok('discovery verdict: mDNS wording does not claim a sweep happened',
    !/sweep/.test(viaMdns), viaMdns);
  ok('discovery verdict: sweep wording does not claim the phone is on this LAN',
    !/\bLAN\b/.test(viaScan), viaScan);
  ok('discovery verdict: says no port was supplied by hand',
    /No port was supplied by hand/.test(viaMdns) && /randomis/.test(viaMdns), viaMdns);
  ok('discovery verdict: no endpoint yields NO verdict, not an empty one',
    describeDiscovery({ endpoint: null, via: 'scan' }) === null
    && describeDiscovery({}) === null && describeDiscovery() === null,
    'an empty string would print as a blank stage detail, which reads as a success with no '
    + 'evidence behind it');
  ok('discovery verdict: an unexpected method is reported, not silently dropped',
    /somethingelse/.test(describeDiscovery({ endpoint: 'x:1', via: 'somethingelse' }) || ''),
    describeDiscovery({ endpoint: 'x:1', via: 'somethingelse' }));
}

/* And device-verify must actually use it rather than re-wording the same idea inline. */
{
  const { readFileSync: rf } = await import('node:fs');
  const dv = rf(new URL('./device-verify.mjs', import.meta.url), 'utf8');
  ok('device-verify reports discovery through the shared verdict',
    /describeDiscovery\(\{/.test(dv) && !/no port was supplied by hand`\)/.test(dv),
    'the stage builds its own wording again, so these assertions stand over nothing');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('ALL PASS');
