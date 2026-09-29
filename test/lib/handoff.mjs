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
