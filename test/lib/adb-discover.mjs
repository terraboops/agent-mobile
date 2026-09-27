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

/** Ports worth sweeping: adb tcpip's fixed 5555, then the ephemeral range wireless debugging uses. */
export const DEFAULT_SCAN_RANGES = [[5555, 5555], [30000, 49999], [50000, 65535]];

/**
 * Find an endpoint, mDNS first then scan.
 * @returns {Promise<{endpoint: string|null, via: string, tried: string[], services: object[]}>}
 */
export async function discover({ host, runMdns, scan, ranges = DEFAULT_SCAN_RANGES,
                                 log = () => {} } = {}) {
  const tried = [];

  tried.push('mdns');
  let services = [];
  try {
    services = parseMdnsServices(await runMdns());
  } catch (e) {
    log(`mdns lookup failed (${e && e.message || e}) — falling back to a scan`);
  }
  const picks = pickAdbEndpoints(services, { host });
  if (picks.length) {
    const p = picks[0];
    log(`found ${p.type} at ${p.host}:${p.port} via mDNS`);
    return { endpoint: `${p.host}:${p.port}`, via: 'mdns', tried, services };
  }
  if (!host) {
    log('no mDNS service and no host to scan — nothing to discover');
    return { endpoint: null, via: 'none', tried, services };
  }

  /* mDNS is link-local, so a remote phone is invisible to it. That is not an error. */
  log(`no mDNS service (expected when the phone is remote — mDNS does not cross Tailscale); `
    + `scanning ${host}`);
  tried.push('scan');
  const open = await scan(host, ranges);
  if (open.length) {
    log(`found an open port at ${host}:${open[0]}`);
    return { endpoint: `${host}:${open[0]}`, via: 'scan', tried, services, open };
  }
  return { endpoint: null, via: 'none', tried, services, open: [] };
}
