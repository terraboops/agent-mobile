/**
 * adb-discover — find the phone's wireless-debugging endpoint without being told the port.
 *
 * Android picks a RANDOM port for wireless debugging, and it changes every time the toggle is
 * cycled. An armed verify holding a hand-supplied host:port therefore only ever closes if a
 * human reads a number off a screen — and a stale number is worse than none, because
 * `adb connect` to a dead port fails quietly and the run just sits there looking patient.
 *
 * Two discovery paths, because neither covers both cases:
 *
 *   mDNS   `adb mdns services` lists `_adb-tls-connect._tcp` with the exact host and port.
 *          Instant and precise — but mDNS is LINK-LOCAL MULTICAST. It does not traverse
 *          Tailscale, so it only works when the phone is on the same network as this Mac.
 *
 *   scan   A bounded TCP sweep of the tailnet address. The only option when the phone is
 *          remote, which is the normal case here — the Pixel reaches this Mac over DERP.
 *
 * mDNS is tried first because it is exact and costs nothing; the scan is the fallback.
 */

/**
 * Parse `adb mdns services`.
 *
 * Real output looks like:
 *   List of discovered mdns services
 *   adb-39091FDJH004TF-vWDsdX	_adb-tls-connect._tcp	192.168.1.42:37129
 *
 * Columns are tab-separated in practice but whitespace-aligned in some builds, and IPv6 hosts
 * carry their own colons — so the address is split on the LAST colon, never the first.
 */
export function parseMdnsServices(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^List of discovered/i.test(line) || /^\*/.test(line)) continue;
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 3) continue;
    const [name, type, addr] = [parts[0], parts[1], parts[parts.length - 1]];
    const cut = addr.lastIndexOf(':');
    if (cut <= 0) continue;
    const host = addr.slice(0, cut).replace(/^\[|\]$/g, '');
    const port = Number(addr.slice(cut + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    out.push({ name, type, host, port });
  }
  return out;
}

/** Endpoints adb can actually connect to, best first. */
export function pickAdbEndpoints(services, { host } = {}) {
  const usable = services.filter((s) => /_adb(-tls-connect)?\._tcp/.test(s.type));
  /* When a specific host is expected, prefer it — a laptop may see several phones. */
  const scored = usable.map((s) => ({ ...s, score: host && s.host === host ? 0 : 1 }));
  scored.sort((a, b) => a.score - b.score
    || (/_adb-tls-connect/.test(b.type) ? 1 : 0) - (/_adb-tls-connect/.test(a.type) ? 1 : 0));
  return scored.map(({ score, ...s }) => s);
}

/**
 * Sweep a host for open TCP ports.
 * @returns {Promise<number[]>} open ports, ascending
 */
export async function scanPorts(host, ranges, { concurrency = 400, timeoutMs = 2500,
                                                connect, signal } = {}) {
  const { createConnection } = connect ? { createConnection: connect }
                                       : await import('node:net');
  const ports = [];
  for (const [lo, hi] of ranges) for (let p = lo; p <= hi; p++) ports.push(p);

  const open = [];
  let idx = 0;
  const worker = async () => {
    while (idx < ports.length) {
      if (signal && signal.aborted) return;
      const port = ports[idx++];
      const hit = await new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        let sock;
        try { sock = createConnection({ host, port }); } catch { return finish(false); }
        const kill = () => { try { sock.destroy(); } catch {} };
        sock.setTimeout && sock.setTimeout(timeoutMs);
        sock.on('connect', () => { kill(); finish(true); });
        sock.on('timeout', () => { kill(); finish(false); });
        sock.on('error', () => { kill(); finish(false); });
      });
      if (hit) open.push(port);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  return open.sort((a, b) => a - b);
}

/**
 * The peer's LAN address, read out of `tailscale status`.
 *
 * WHY THIS EXISTS. device-verify scanned only the tailnet address (100.x) and reported "nothing is
 * listening" from a timeout. But when the phone and this Mac are on the same LAN, Tailscale says
 * so — the status line carries `active; direct 192.168.10.53:38864` — and the LAN path answers
 * very differently: a closed port there returns CONNECTION REFUSED, which proves the host is up
 * and adbd is not, where a tailnet timeout proves nothing at all. Scanning only the tailnet threw
 * away the one measurement that distinguishes "phone off" from "toggle off".
 *
 * A line looks like:
 *   100.112.255.69   pixel-7   terra@   android   active; direct 192.168.10.53:38864, tx 564 rx 124
 * or, when relayed, `active; relay "tor"` — with no LAN address to extract, which is correct:
 * a relayed peer is not on this LAN.
 */
export function parseTailscalePeer(stdout, tailnetIp) {
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(String(tailnetIp))) continue;
    const online = /\bactive\b/.test(line) || /\bidle\b/.test(line);
    const direct = /\bdirect\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(line);
    const relay = /\brelay\s+"?([\w-]+)"?/.exec(line);
    return {
      found: true,
      online,
      offline: /\boffline\b/.test(line),
      lan: direct ? direct[1] : null,
      relay: relay ? relay[1] : null,
      line,
    };
  }
  return { found: false, online: false, offline: false, lan: null, relay: null, line: '' };
}

/**
 * Classify one TCP connect attempt. The distinction is the whole diagnostic value:
 *   refused  -> the host answered and nothing is on that port (adbd is not running)
 *   timeout  -> nothing answered; says nothing about the host
 */
export function classifyConnect(stderrOrStdout) {
  const t = String(stderrOrStdout || '');
  if (/refused/i.test(t)) return 'refused';
  if (/timed out|timeout/i.test(t)) return 'timeout';
  if (/no route to host|unreachable/i.test(t)) return 'unreachable';
  if (/connected to/i.test(t)) return 'connected';
  return 'unknown';
}

/** Ports worth sweeping: adb tcpip's fixed 5555, then the ephemeral range wireless debugging uses. */
export const DEFAULT_SCAN_RANGES = [[5555, 5555], [30000, 49999], [50000, 65535]];

/**
 * Find an endpoint, mDNS first then scan.
 * @returns {Promise<{endpoint: string|null, via: string, tried: string[], services: object[]}>}
 */
export async function discover({ host, hosts, runMdns, scan, ranges = DEFAULT_SCAN_RANGES,
                                 log = () => {} } = {}) {
  const tried = [];
  /* `hosts` supersedes `host`: the phone can be reachable at a tailnet address AND a LAN one, and
   * only sweeping both tells them apart. Order matters — LAN first, because it answers fastest
   * and its refusals are informative. */
  const targets = (hosts && hosts.length ? hosts : [host]).filter(Boolean)
    .filter((h, i, a) => a.indexOf(h) === i);

  tried.push('mdns');
  let services = [];
  try {
    services = parseMdnsServices(await runMdns());
  } catch (e) {
    log(`mdns lookup failed (${e && e.message || e}) — falling back to a scan`);
  }
  const picks = pickAdbEndpoints(services, { host: targets[0] });
  if (picks.length) {
    const p = picks[0];
    log(`found ${p.type} at ${p.host}:${p.port} via mDNS`);
    return { endpoint: `${p.host}:${p.port}`, via: 'mdns', tried, services };
  }
  if (!targets.length) {
    log('no mDNS service and no host to scan — nothing to discover');
    return { endpoint: null, via: 'none', tried, services };
  }

  /* mDNS is link-local, so a remote phone is invisible to it. That is not an error. */
  log('no mDNS service (expected when the phone is remote — mDNS does not cross Tailscale)');
  tried.push('scan');
  const scanned = {};
  let didScan = false;
  for (const h of targets) {
    /* A scan callback may return null to mean "SKIPPED, not empty".
     *
     * device-verify sweeps on a slower cadence than it polls mDNS, so most passes deliberately do
     * not scan. This used to log "scanning <ip>" before calling, and "nothing open on <ip>"
     * after — on every pass, including the ones where no packet was sent. An armed run therefore
     * printed a thousand lines claiming sweeps it never performed, and "nothing open" is a
     * MEASUREMENT: reporting one that was never taken is the same defect as any other check that
     * says it did something it did not.
     *
     * null and [] are different answers and the log now distinguishes them. */
    const open = await scan(h, ranges);
    if (open === null || open === undefined) {
      scanned[h] = null;
      log(`sweep of ${h} skipped this pass (slower cadence — mDNS is still being polled)`);
      continue;
    }
    didScan = true;
    scanned[h] = open;
    log(`scanned ${h}`);
    if (open.length) {
      log(`found an open port at ${h}:${open[0]}`);
      /* didScan belongs on THIS return too. It was only on the final one, so a successful
       * discovery reported `didScan: undefined` — the caller could not tell a real sweep from a
       * skipped one precisely when it had found something. Caught by discover-live. */
      return { endpoint: `${h}:${open[0]}`, via: 'scan', tried, services, open, scanned,
               didScan: true };
    }
    log(`nothing open on ${h}`);
  }
  if (!didScan) tried[tried.indexOf('scan')] = 'scan-skipped';
  return { endpoint: null, via: 'none', tried, services, open: [], scanned, didScan };
}

/**
 * The verdict for a SUCCESSFUL discovery — the first line anyone reads when the toggle lands.
 *
 * WHY IT IS A FUNCTION. It was built inline in device-verify, which cannot run without a
 * handset, so the one line that will be read before any other had nothing standing over it. The
 * two failure verdicts next door (describeBlocked) have had assertions since they were written;
 * this one did not, and I claimed the opposite about both before checking.
 *
 * HOW it was found matters as much as WHERE. `mdns` means the phone answered a link-local
 * multicast, so it is on this LAN; `scan` means the port was swept out of an ephemeral range and
 * the phone may be anywhere on the tailnet. Reporting only the endpoint loses that, and the two
 * have different implications for the tailnet-path claim the ICE stage makes later.
 */
export function describeDiscovery({ endpoint, via, host } = {}) {
  if (!endpoint) return null;
  const how = via === 'mdns'
    ? 'mDNS — the phone answered a link-local query, so it is on this LAN'
    : via === 'scan'
      ? `a bounded TCP sweep of ${host || 'the known addresses'} — mDNS did not answer, which is `
        + 'expected when the phone is remote'
      : `${via || 'an unknown method'}`;
  return `${endpoint} via ${how}. No port was supplied by hand: Android randomises it on every `
       + 'toggle, so a number read off the phone screen is stale as soon as it is cycled.';
}
