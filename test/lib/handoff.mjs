/**
 * handoff — decide, each tick, what it is worth doing to find the phone, and what to run when
 * it appears.
 *
 * WHY THE DECISION IS ITS OWN MODULE. The runner around it is a loop that spawns processes and
 * cannot be unit-tested without a phone. What CAN be checked here is the part that gets it
 * wrong: how often to probe what, and whether an endpoint is worth acting on. A poller that
 * asks the wrong question forever is the failure this project already had — a watcher polled
 * mDNS for three and a half hours while the LAN address was answering ECONNREFUSED the whole
 * time, and printed a generic line about toggles.
 *
 * THE THREE PROBES COST WILDLY DIFFERENT AMOUNTS, which is the whole reason for a schedule:
 *
 *   mdns        instant, and useless here — it is link-local multicast and this Mac does not
 *               see the phone's segment (measured: empty every time, while the LAN IP answers)
 *   lan sweep   ~60s for the full wireless-debugging range, because a closed port on a
 *               reachable host REFUSES instantly. Informative and affordable.
 *   tailnet     minutes, because a closed port on the userspace TUN times out silently. The
 *               same information, far slower, and a timeout proves nothing anyway.
 *
 * So: mDNS every tick (free), the LAN sweep on a slow cadence, the tailnet sweep rarely.
 */

/**
 * DISCOVERY IS TIERED, because "is the phone there" has five answers with five prices and a
 * loop that only knows one of them is a loop that waits six hours saying "nothing open".
 *
 * That is not hypothetical: the first armed run polled ONE remembered address, logged
 * `nothing open on 192.168.10.53` for its whole life, and would have missed the phone entirely
 * if DHCP had moved it — while the handset sat on the same /24 answering pings.
 *
 *   usb       `adb devices` with no network at all. Instant, and the ONLY path that works when
 *             wireless debugging is off but the cable is in. It was not checked at all.
 *   mdns      instant. The designed mechanism for Android 11 wireless debugging, and it works
 *             here — this Mac is on 192.168.10.0/24 with the phone. Empty means the phone is
 *             not advertising, i.e. the toggle is off.
 *   subnet    254 hosts x port 5555. Seconds, because a closed port on a live host REFUSES
 *             instantly and a dead address times out. It also yields WHICH HOSTS ARE ALIVE,
 *             which is what makes the next tier affordable.
 *   hosts     the full wireless-debug range, but only against hosts the subnet tier found
 *             alive. 254 x 35000 would be nine million probes. MEASURED on this network, one
 *             host takes ~50s — so 11 live hosts is nine minutes, not the "a minute" this
 *             comment used to claim. That is why the tier takes a few hosts per tick, in an
 *             order that puts the likely phone first, and logs each one.
 *   tailnet   the 100.x address, full range. Minutes, because a closed port on the userspace
 *             TUN times out rather than refusing — the same answer, far slower.
 */
export const TIERS = ['usb', 'mdns', 'subnet', 'hosts', 'tailnet'];

export const TICK_S = 20;
export const LAN_SWEEP_EVERY_S = 300;
export const TAILNET_SWEEP_EVERY_S = 1800;

/**
 * What to do on this tick.
 * @param {{elapsedS:number, lastLanSweepS:number, lastTailnetSweepS:number, hasLan:boolean}} st
 * @returns {{mdns:boolean, lanSweep:boolean, tailnetSweep:boolean, why:string}}
 */
export function tickPlan({ elapsedS = 0, lastLanSweepS = -Infinity,
                           lastTailnetSweepS = -Infinity, hasLan = false } = {}) {
  const lanSweep = hasLan && (elapsedS - lastLanSweepS) >= LAN_SWEEP_EVERY_S;
  /* Only when the LAN path is unavailable is the slow sweep worth its cost — if the phone has a
   * reachable LAN address, sweeping the tailnet is the same answer for a hundred times the
   * wall-clock. */
  const tailnetSweep = !lanSweep && (elapsedS - lastTailnetSweepS) >= TAILNET_SWEEP_EVERY_S;
  return {
    mdns: true,
    lanSweep,
    tailnetSweep,
    why: lanSweep ? 'LAN sweep due (refusals are instant, so this is the cheap informative one)'
      : tailnetSweep ? 'tailnet sweep due (slow: closed ports time out rather than refusing)'
      : 'mDNS only this tick',
  };
}

export const SUBNET_SWEEP_EVERY_S = 120;
export const HOST_SWEEP_EVERY_S = 60;
/* Per TICK, because a full-range sweep is ~50s per host and doing eleven in one pass is nine
 * minutes during which the cheap tiers — including USB and mDNS, either of which could answer
 * instantly — do not run at all. */
export const HOSTS_PER_TICK = 2;

/**
 * Which hosts to sweep next, likeliest first.
 *
 * The phone's address is known from `tailscale status` when it is active, and sweeping it first
 * turns discovery from "up to nine minutes" into "fifty seconds". Hosts already swept go to the
 * back rather than being dropped: DHCP moves, and the phone may not be where it was.
 */
export function hostSweepOrder(liveHosts, { preferred = null, swept = new Set() } = {}) {
  const hosts = (liveHosts || []).map((h) => (typeof h === 'string' ? h : h.host)).filter(Boolean);
  const rank = (h) => (h === preferred ? 0 : swept.has(h) ? 2 : 1);
  return [...hosts].sort((a, b) => rank(a) - rank(b) || hosts.indexOf(a) - hosts.indexOf(b));
}

/**
 * Which discovery tiers to run this tick.
 *
 * usb and mdns every time — they cost nothing and one of them is the only path that works with
 * the toggle off. The sweeps are priced apart so the slow ones cannot crowd out the fast ones.
 *
 * @returns {{tiers: string[], why: string}}
 */
export function discoveryPlan({ elapsedS = 0, last = {}, liveHosts = [], hasTailnet = true } = {}) {
  const due = (tier, every) => (elapsedS - (last[tier] ?? -Infinity)) >= every;
  const tiers = ['usb', 'mdns'];
  if (due('subnet', SUBNET_SWEEP_EVERY_S)) tiers.push('subnet');
  /* Only worth the minute when the cheap tier has found something to aim it at. */
  else if (liveHosts.length && due('hosts', HOST_SWEEP_EVERY_S)) tiers.push('hosts');
  /* And the slowest only when nothing faster is scheduled, so it never queues in front. */
  else if (hasTailnet && due('tailnet', TAILNET_SWEEP_EVERY_S)) tiers.push('tailnet');
  return {
    tiers,
    why: tiers.includes('subnet') ? 'subnet sweep due (254 hosts, one port — refusals are instant)'
      : tiers.includes('hosts') ? `host sweep due (${liveHosts.length} live host(s) to aim at)`
      : tiers.includes('tailnet') ? 'tailnet sweep due (slow: closed ports time out)'
      : 'usb and mDNS only this tick',
  };
}

/**
 * Is a host alive, from one TCP probe?
 *
 * REFUSED is the answer that matters. A closed port on a live host sends RST instantly; a
 * dead address times out. So one probe against a port nothing uses tells you the host exists,
 * in milliseconds, and that is what makes the expensive tier affordable — measured on this
 * network: 254 addresses, 12 live hosts, 3.6 seconds.
 */
export function aliveFromProbe(result) {
  if (result === 'open') return true;
  if (result === 'ECONNREFUSED' || result === 'refused') return true;
  return false;
}

/** The /24 an address sits on, as a list of host addresses. Null for anything unparseable. */
export function subnetHosts(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(addr || '').trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  const out = [];
  for (let i = 1; i <= 254; i++) out.push(`${o[0]}.${o[1]}.${o[2]}.${i}`);
  return out;
}

/**
 * A found endpoint, with the path that found it.
 *
 * WHICH PATH MATTERS AS MUCH AS WHETHER. usb means the cable is in and the network is
 * irrelevant; mdns means the phone is advertising on this segment; subnet means it answered a
 * sweep, so DHCP may have moved it since anyone last looked; tailnet means it is not on this
 * network at all, which is the case the remote-path claim needs. A run that says only "found"
 * throws that away.
 */
export function foundVia(tier, endpoint, detail = '') {
  const notes = {
    usb: 'over USB — the cable is in, so wireless debugging need not be on at all',
    mdns: 'via mDNS — the phone is advertising wireless debugging on this segment',
    subnet: 'by sweeping the local /24 — mDNS did not advertise it, so the address may have moved',
    hosts: 'by sweeping a live host found on the /24',
    tailnet: 'at the tailnet address — the phone is NOT on this network, which is the case the '
           + 'remote-path claim needs',
  };
  return { tier, endpoint, note: notes[tier] || `via ${tier}`, detail };
}

/** Is this endpoint worth handing to `adb connect`? */
export function usableEndpoint(ep) {
  const m = /^\[?([0-9a-fA-F:.]+)\]?:(\d{1,5})$/.exec(String(ep || '').trim());
  if (!m) return false;
  const port = Number(m[2]);
  return port > 0 && port <= 65535;
}

/**
 * The passes to run once a device is there, in order.
 *
 * TWO passes, not one, and the second is the point. The full sweep negotiates WebRTC, whose
 * downlink is PACED — so it exercises the easy side of stop-control. The bug the flush was
 * written for only appears on the WS fallback, which BURSTS a reply. A handoff that ran the
 * full sweep alone would report a pass over the case it was supposed to settle.
 */
export function passPlan({ apk = null, wsFallback = true } = {}) {
  const env = apk ? { AGENTMOB_APK: apk } : {};
  const passes = [
    { name: 'full sweep', args: ['--wait', '120'], env,
      why: 'install, launch, handshake, WebRTC, surface, speak, mute, stop — over the paced '
         + 'downlink, which is what a phone negotiates' },
  ];
  if (wsFallback) {
    passes.push({ name: 'WS-fallback stop', args: ['--wait', '120', '--ws-fallback', '--only', 'stop'],
      env,
      why: 'the same Stop over the BURST downlink, where the whole remainder of a reply is '
         + 'already on the phone — the case stop-control\'s flush exists for, and the one the '
         + 'full sweep cannot reach' });
  }
  return passes;
}

/** A line that cannot be mistaken for a device verification when no device ever appeared. */
export function handoffVerdict({ found = false, ranPasses = 0, elapsedS = 0 } = {}) {
  if (!found) {
    return { armed: true, note: `no adb target after ${Math.round(elapsedS)}s — nothing was run. `
      + 'Wireless debugging is still off on the phone; this is the arming loop reporting that '
      + 'it found nothing, NOT a device pass with no failures.' };
  }
  return { armed: false, note: `device appeared after ${Math.round(elapsedS)}s; ran ${ranPasses} `
    + `pass(es). Read each report for its own verdict — this line only says they were run.` };
}

/* ---- AN OPEN PORT IS NOT A PHONE -------------------------------------------------------------
 *
 * The first tiered run found `192.168.10.55:49152` — this Mac, running rapportd — and started
 * installing an APK against it. Two mistakes in one: the sweep included its own address, and a
 * port being open was treated as proof that adb was behind it.
 *
 * The second is the dangerous one. On a network with another Android device exposing adb over
 * 5555, an unguarded handoff installs this app on a stranger's phone and runs a mute test on it.
 * A sweep hit is a CANDIDATE. What makes it a device is adb saying so, and what makes it the
 * RIGHT device is the model and serial.
 */

/** Addresses the sweep must never treat as the phone. */
export function excludedHosts({ selfLan = null, extra = [] } = {}) {
  return new Set([selfLan, '127.0.0.1', '0.0.0.0', ...extra].filter(Boolean));
}

/**
 * Does `adb devices -l` actually show this endpoint as a usable device?
 *
 * `unauthorized` counts as FOUND — the phone is there and showing a prompt, which is a real
 * finding with its own instruction — but not as ready to install onto.
 *
 * @returns {{present: boolean, ready: boolean, state: string|null}}
 */
export function endpointState(devicesOut, endpoint) {
  const want = String(endpoint || '').trim();
  for (const raw of String(devicesOut || '').split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || !line.startsWith(want + '\t') && !line.startsWith(want + ' ')) continue;
    const state = (line.slice(want.length).trim().split(/\s+/)[0] || '').toLowerCase();
    return { present: true, ready: state === 'device', state };
  }
  return { present: false, ready: false, state: null };
}

/**
 * Is this the phone we meant?
 *
 * `getprop ro.product.model` / `ro.serialno`. A sweep can reach any Android on the segment, and
 * "an Android answered" is not "the Pixel answered" — installing onto the wrong one is not a
 * test failure, it is somebody else's phone with our app on it.
 */
export function identityMatches({ model = '', serial = '', expectModel = 'Pixel',
                                  expectSerial = null } = {}) {
  const m = String(model || '').trim();
  const s = String(serial || '').trim();
  if (expectSerial) {
    return { ok: s === expectSerial, why: s === expectSerial
      ? `serial ${s} matches`
      : `serial ${s || '(none)'} is not the expected ${expectSerial} — this is a different device` };
  }
  if (!m) return { ok: false, why: 'the device reported no model, so it cannot be identified' };
  const ok = m.toLowerCase().includes(String(expectModel).toLowerCase());
  return { ok, why: ok ? `model ${m} matches ${expectModel}`
    : `model ${m} is not a ${expectModel} — refusing to install on a device this run did not `
      + 'mean to touch' };
}

/**
 * This machine's own LAN address, from the OS.
 *
 * WHY NOT A FLAG OR tailscale. The runner had ONE variable doing two jobs: "this machine's
 * address, to derive the subnet and to exclude" and "the phone's last known LAN address, to
 * sweep first". tailscale reports the PHONE's address, so the moment the peer went active the
 * variable became 192.168.10.53 — and the exclusion then removed THE PHONE from discovery while
 * happily sweeping this Mac. Watched in a live run: `swept 192.168.10.55 full range`.
 *
 * The OS knows which address is ours and cannot be confused about it.
 */
export function ownLanAddress(interfaces) {
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      const family = a.family === 4 || a.family === 'IPv4';
      if (!family || a.internal) continue;
      /* isPrivateAddr already excludes 169.254 — it admits only 10/8, 172.16/12 and
       * 192.168/16 — so a separate link-local test here would be dead code that reads as
       * the guarantee. A mutation aimed at one came back MISSED, which is how it was
       * found; the third time this project has shipped a guard that cannot fire. */
      if (isPrivateAddr(a.address)) return a.address;
    }
  }
  return null;
}

/** RFC1918, reused from the ICE side of the house rather than written twice. */
function isPrivateAddr(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || '').trim());
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}
