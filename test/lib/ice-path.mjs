/**
 * ice-path — was the media carried over the Tailscale TUN, or over the LAN?
 *
 * WHY THIS IS ITS OWN MODULE. `device-verify` reads the sidecar's nominated-pair line and has
 * to decide which of the two happened. That decision was a regex inlined in device-verify, which
 * cannot run without a handset — so the one piece of logic in that stage that a Mac CAN check
 * was sitting in the one file a Mac cannot execute. An assertion nobody can run is not coverage,
 * and the stage would have been trusted on the strength of having been read.
 *
 * WHY THE RANGE MATTERS AT ALL. Tailscale allocates from 100.64.0.0/10, the CGNAT range. The
 * boundaries are the whole content of the predicate: 100.63.x is NOT in it and 100.128.x is NOT
 * in it, while everything from 100.64 to 100.127 is. The sidecar carries the same range for
 * gathering its host candidate (index.mjs, `tailnetAddresses`), so the two are checked against
 * each other by the suite rather than left to drift — a phone can only nominate an address the
 * sidecar first advertised, so a disagreement makes one of them silently unreachable.
 *
 * WHAT IT IS NOT. Being in the range does not prove the packets crossed Tailscale's relays or
 * came from another network; it proves the nominated pair used the tailnet interface rather
 * than the local one. That is the distinction device-verify needs, and it is all this claims.
 */

/** 100.64.0.0/10 — Tailscale's CGNAT allocation. */
export function isTailnetAddr(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || '').trim());
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/**
 * Classify a nominated pair's remote address.
 * @returns {{via:'tailnet'|'lan'|'unknown', host:string|null, note:string}}
 */
export function classifyIcePath(remote) {
  /* The sidecar logs `remote=<host>:<port> (<type>)`; take the host off whatever shape arrives,
   * splitting on the LAST colon so an IPv6 literal does not lose half of itself. */
  const raw = String(remote || '').trim().replace(/\s*\(.*$/, '');
  if (!raw) return { via: 'unknown', host: null, note: 'no nominated pair was logged' };
  const host = raw.includes(':') ? raw.slice(0, raw.lastIndexOf(':')).replace(/^\[|\]$/g, '') : raw;
  if (isTailnetAddr(host)) {
    return { via: 'tailnet', host,
             note: `${host} is in 100.64.0.0/10, so the media took the tailnet path` };
  }
  return { via: 'lan', host,
           note: `${host} is not a tailnet address — same-network run, so the remote-phone claim `
               + 'is NOT exercised. Re-run with the phone off this Wi-Fi to prove it.' };
}

/** The range the SIDECAR gathers from, read out of its source. Kept honest by the suite. */
export function sidecarCgnatRange(src) {
  const m = /o\[0\]\s*===\s*(\d+)\s*&&\s*o\[1\]\s*>=\s*(\d+)\s*&&\s*o\[1\]\s*<=\s*(\d+)/.exec(String(src || ''));
  return m ? { first: Number(m[1]), lo: Number(m[2]), hi: Number(m[3]) } : null;
}
