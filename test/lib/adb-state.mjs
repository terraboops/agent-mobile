/**
 * adb-state — turn `adb devices -l` into a state you can act on.
 *
 * device-verify used to keep only the lines whose state was exactly `device` and drop the rest,
 * so every other outcome collapsed into "no device after N seconds". The most important one it
 * threw away is `unauthorized`: that means the phone is sitting there showing an
 * "Allow wireless debugging?" dialog, waiting for a tap. Reporting that as "no device" sends
 * you to check the wrong thing entirely — it is the one failure that a person standing next to
 * the phone could fix in two seconds.
 *
 * Pure functions, so the states can be tested without a phone. See adb-state.test.mjs.
 */

/** adb's own device states, and what each one actually means for us. */
export const STATES = {
  device: 'ready',
  unauthorized: 'unauthorized',
  offline: 'offline',
  authorizing: 'authorizing',
  connecting: 'authorizing',
  recovery: 'other',
  sideload: 'other',
  bootloader: 'other',
  host: 'other',
  rescue: 'other',
  'no permissions': 'other',
};

/**
 * Parse `adb devices` / `adb devices -l` output.
 * @returns {{ready:string[],unauthorized:string[],offline:string[],authorizing:string[],other:{serial:string,state:string}[]}}
 */
export function classifyDevices(stdout) {
  const out = { ready: [], unauthorized: [], offline: [], authorizing: [], other: [] };
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^List of devices/i.test(line)) continue;
    if (/^\*/.test(line)) continue;                 // "* daemon started successfully *"
    if (/^adb(\.exe)?:/i.test(line)) continue;      // error chatter
    /* "no permissions" contains a space, so match the known states rather than splitting. */
    const m = line.match(/^(\S+)\s+(no permissions|[a-z]+)\b/);
    if (!m) continue;
    const [, serial, state] = m;
    const bucket = STATES[state];
    if (bucket === 'ready') out.ready.push(serial);
    else if (bucket === 'unauthorized') out.unauthorized.push(serial);
    else if (bucket === 'offline') out.offline.push(serial);
    else if (bucket === 'authorizing') out.authorizing.push(serial);
    else out.other.push({ serial, state });
  }
  return out;
}

/** A short, stable label for the current observation — used to print only real CHANGES. */
export function stateLabel(c, { connectError } = {}) {
  if (c.ready.length) return `ready:${c.ready.join(',')}`;
  if (c.unauthorized.length) return `unauthorized:${c.unauthorized.join(',')}`;
  if (c.authorizing.length) return `authorizing:${c.authorizing.join(',')}`;
  if (c.offline.length) return `offline:${c.offline.join(',')}`;
  if (c.other.length) return `other:${c.other.map((o) => o.state).join(',')}`;
  return connectError ? `none:${connectError}` : 'none';
}

/**
 * Why we are still waiting, in words that name the next action.
 * Every branch has to be distinguishable — that is the whole point of this module.
 */
export function describeBlocked({ classified, connectTarget, connectError, tailnet, waitedS }) {
  const c = classified;
  const waited = waitedS ? ` after ${waitedS}s` : '';

  if (c.unauthorized.length) {
    return `device ${c.unauthorized[0]} is UNAUTHORIZED${waited} — the phone is showing an `
      + `"Allow wireless debugging?" prompt. Tap Allow (and "Always allow from this computer") `
      + `on the Pixel; nothing here can answer it for you.`;
  }
  if (c.authorizing.length) {
    return `device ${c.authorizing[0]} is still AUTHORIZING${waited} — adb is mid-handshake; `
      + `if it sticks, revoke USB debugging authorisations on the phone and re-pair.`;
  }
  if (c.offline.length) {
    return `device ${c.offline[0]} is OFFLINE${waited} — adb can see it but it is not `
      + `responding. Toggle Wireless debugging off/on on the phone, then re-run.`;
  }
  if (c.other.length) {
    const o = c.other[0];
    return `device ${o.serial} is in state "${o.state}"${waited} — not usable for install/shell.`;
  }

  /* Nothing at all. Distinguish "the phone is not on the network" from "the port is shut". */
  if (connectTarget) {
    if (tailnet && tailnet.checked && !tailnet.reachable) {
      return `no device${waited}: the phone is NOT REACHABLE on the tailnet `
        + `(${tailnet.note || 'tailscale ping failed'}). It is powered off, asleep, or off the `
        + `tailnet — adb cannot reach it until Tailscale on the phone is up again.`;
    }
    if (tailnet && tailnet.checked && tailnet.reachable) {
      return `no device${waited}: the phone IS reachable on the tailnet but nothing is `
        + `listening on ${connectTarget}`
        + (connectError ? ` (${connectError})` : '')
        + ` — Wireless debugging is OFF. Turn it on: Settings > System > Developer options > `
        + `Wireless debugging. That is the ONLY step needed — the port is discovered here, so `
        + `nothing has to be read off the screen.`;
    }
    return `no device${waited} (adb connect ${connectTarget}${connectError ? `: ${connectError}` : ''}).`;
  }
  return `no device${waited}. Plug in USB, or turn on Settings > System > Developer options > `
    + `Wireless debugging — the port is discovered, so it does not need to be supplied.`;
}

/** Tidy adb connect's own message so it can be shown inline. */
export function connectErrorOf(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  if (/^connected to/im.test(text) || /already connected/im.test(text)) return null;
  const m = text.match(/^(failed to connect[^\n]*|cannot connect[^\n]*|.*Connection refused[^\n]*)$/im);
  return m ? m[1].trim() : (text.trim().split('\n').filter(Boolean)[0] || null);
}
