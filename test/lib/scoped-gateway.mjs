/**
 * scoped-gateway — a throwaway Hermes instance, so mutation testing never touches production.
 *
 * WHY. Two mutation entries (e2e-voice, e2e-voice-render) edit adapter.py, which is imported INTO
 * the gateway process. Reloading it means restarting that process, and the live one serves Terra's
 * Telegram, her phone bridge and every cron job on this machine — restarting it killed in-flight
 * cron work mid-write and dropped conversations. Those two entries were therefore reported as
 * NOT RUN. This file is what makes them runnable: a second Hermes with its own HERMES_HOME, its
 * own ports, its own copy of the plugin, started and stopped by the test.
 *
 * THE DANGEROUS PART, named first. A Hermes home carries credentials. Copying Terra's .env would
 * give the scoped instance her TELEGRAM_BOT_TOKEN, and a second process holding the same bot token
 * CONNECTS AS THAT BOT and starts consuming her messages — a far worse failure than the restarts
 * this replaces. So the scoped .env is built by ALLOWLIST, never by copying: only the keys the
 * agent needs to answer and speak. writeScopedEnv() refuses to emit anything matching a platform
 * or relay credential, and assertScopedSafe() re-checks the written file before every start.
 *
 * WHAT IS SHARED, deliberately: the repo (the sidecar imports it by absolute path) and the Hermes
 * program itself. Nothing writable by the live gateway is shared — not the home, not the plugin
 * copy, not the ports, not the sqlite db, not the sidecar identity.
 *
 * Ports: 8124 / 8791, one above the live 8123 / 8790.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
         openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const LIVE_HOME = join(homedir(), '.hermes');
export const PROFILES_ROOT = join(LIVE_HOME, 'profiles');
/**
 * The scoped home is a real Hermes PROFILE, not an arbitrary directory, and that detail is what
 * lets this work without overriding a safety guard.
 *
 * My first attempt put it at ~/.hermes-agentmob-scoped. `hermes gateway run` refused, because
 * get_default_hermes_root() returns HERMES_HOME *directly* when it points outside ~/.hermes ("that
 * IS the root", for Docker-style deployments) — so _profile_suffix() computed "", the instance
 * inherited the DEFAULT launchd label ai.hermes.gateway, and the supervision guard correctly saw
 * the live service running. The offered escape was --force, which would have silenced a guard
 * whose stated purpose is preventing multi-writer SQLite corruption on Terra's machine.
 *
 * Under <root>/profiles/<name>, _profile_suffix() returns the profile name, the plist becomes
 * ai.hermes.gateway-agentmobtest.plist, which is not installed — so service_installed is false and
 * the guard returns early of its own accord. The supported path, and no flag needed.
 */
export const SCOPED_PROFILE = 'agentmobtest';
export const SCOPED_HOME = join(PROFILES_ROOT, SCOPED_PROFILE);
export const SCOPED_PORT = 8124;
export const SCOPED_SIDECAR_PORT = 8791;
export const SCOPED_PLUGIN = join(SCOPED_HOME, 'plugins', 'agentmob');
export const SCOPED_ADAPTER = join(SCOPED_PLUGIN, 'adapter.py');
export const SCOPED_SIDECAR = join(SCOPED_PLUGIN, 'sidecar', 'index.mjs');
export const SCOPED_WS_URL = `ws://127.0.0.1:${SCOPED_PORT}`;

/**
 * Credentials the scoped agent legitimately needs: a model to answer with, and speech.
 * An ALLOWLIST, because the failure modes of a denylist are silent and expensive — a new
 * connector token in .env would be copied by default and the instance would join that service.
 */
const ENV_ALLOW = [
  'FIREWORKS_API_KEY',      // the default model provider
  'OPENAI_API_KEY',         // STT fallback, if local whisper is unavailable
];

/** Anything matching these must never reach the scoped home, allowlisted or not. */
const ENV_FORBID = /TELEGRAM|DISCORD|WHATSAPP|WEIXIN|SLACK|SIGNAL|MATRIX|RELAY|WEBHOOK|GATEWAY_TOKEN|BOT_TOKEN/i;

/**
 * Refuse to operate on the live home, whatever the caller passed.
 *
 * A profile at <root>/profiles/<name> IS under ~/.hermes, so a blanket "not under the live home"
 * rule would reject the only layout that works. The distinction that matters is not the path
 * prefix but whether the target is the live ROOT — the config.yaml, .env, kanban.db and gateway
 * socket the production gateway reads and writes. A profile directory shares none of them.
 */
export function assertNotLiveHome(home) {
  const r = resolve(home || '');
  const live = resolve(LIVE_HOME);
  if (!r) throw new Error('scoped-gateway: REFUSED — no home given');
  if (r === live) {
    throw new Error(
      `scoped-gateway: REFUSED — "${home}" is the live Hermes root (${LIVE_HOME}).\n`
      + '  Writing there would change the configuration of the gateway serving Telegram, the '
      + 'phone\n  bridge and cron. A scoped instance belongs in '
      + `${PROFILES_ROOT.replace(homedir(), '~')}/<name>.`);
  }
  if (r.startsWith(live + '/')) {
    /* Inside the live root, ONLY a direct profile directory is acceptable. */
    const rel = r.slice(live.length + 1).split('/');
    const ok = rel.length === 2 && rel[0] === 'profiles'
      && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rel[1]);
    if (!ok) {
      throw new Error(
        `scoped-gateway: REFUSED — "${home}" is inside the live Hermes root but is not a profile\n`
        + `  directory. Expected ${PROFILES_ROOT.replace(homedir(), '~')}/<name>.`);
    }
  }
  return true;
}

/** Minimal config: the agentmob platform and nothing else that reaches the network. */
function scopedConfigYaml(live, opts = {}) {
  const model = (live && live.model) || {};
  return `# GENERATED by test/lib/scoped-gateway.mjs — a throwaway instance for mutation testing.
# Not Terra's config. Every platform connector is absent ON PURPOSE: this instance must not
# join Telegram, Discord, WhatsApp or any relay. Only the agentmob surface is enabled, on its
# own ports, so a mutated adapter can be loaded without restarting the production gateway.
_config_version: 40

model:
  default: ${model.default || 'accounts/fireworks/models/deepseek-v4p1-flash'}
  provider: ${model.provider || 'fireworks'}

# The surface under test. Ports one above the live pair so the two can never collide.
platforms:
  agentmob:
    enabled: true
    extra:
      port: ${SCOPED_PORT}
      sidecar_port: ${SCOPED_SIDECAR_PORT}
      bind: 127.0.0.1${opts.allowedClients ? `
      # Client allowlist under test. Set ONLY here, never in the live config: pinning the wrong
      # id on production would lock the handset out of its own gateway.
      allowed_clients: "${opts.allowedClients}"` : ''}
    home_channel:
      platform: agentmob
      chat_id: agentmobile-scoped
      name: Agent Mobile (scoped)

plugins:
  enabled:
    - agentmob-platform
  entries:
    agentmob-platform:
      allow_tool_override: true

# Speech is part of what e2e-voice asserts, so it stays. Everything else is off: no MCP servers
# (each is an outbound connection), no memory (writes a profile), no telemetry, no updates.
tts:
  provider: edge
  edge:
    voice: en-CA-ClaraNeural
  use_gateway: false
stt:
  enabled: true
  language: en
  local:
    model: base

mcp_servers: {}
memory:
  memory_enabled: false
  user_profile_enabled: false
telemetry:
  shared_metrics:
    enabled: false
updates:
  pre_update_backup: false
`;
}

/** Build the scoped .env by allowlist and verify nothing forbidden slipped in. */
export function writeScopedEnv(home = SCOPED_HOME, liveEnvPath = join(LIVE_HOME, '.env')) {
  assertNotLiveHome(home);
  const src = existsSync(liveEnvPath) ? readFileSync(liveEnvPath, 'utf8') : '';
  const want = new Map();
  for (const line of src.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (!ENV_ALLOW.includes(k)) continue;
    if (ENV_FORBID.test(k)) continue;         // belt and braces: allowlist AND denylist
    if (!v.trim()) continue;
    want.set(k, v);
  }
  const body =
`# GENERATED by test/lib/scoped-gateway.mjs — ALLOWLISTED credentials only.
# Terra's .env is NOT copied here. A second process holding her TELEGRAM_BOT_TOKEN would connect
# as that bot and consume her messages, which is worse than the gateway restarts this replaces.
# Only what the scoped agent needs to answer and speak: ${ENV_ALLOW.join(', ')}.
${[...want].map(([k, v]) => `${k}=${v}`).join('\n')}
`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.env'), body, { mode: 0o600 });
  return { keys: [...want.keys()], missing: ENV_ALLOW.filter((k) => !want.has(k)) };
}

/**
 * Re-check the written home before every start. Cheap, and the thing it prevents is expensive.
 * Throws on anything that could make the scoped instance act as Terra's gateway.
 */
export function assertScopedSafe(home = SCOPED_HOME) {
  assertNotLiveHome(home);
  const envPath = join(home, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(\S.*)$/.exec(line);
      if (m && ENV_FORBID.test(m[1])) {
        throw new Error(`scoped-gateway: REFUSED — ${home}/.env contains ${m[1]}. `
          + 'A scoped instance must not hold a platform or relay credential.');
      }
    }
  }
  const cfgPath = join(home, 'config.yaml');
  if (existsSync(cfgPath)) {
    const cfg = readFileSync(cfgPath, 'utf8');
    for (const p of ['telegram:', 'discord:', 'whatsapp:', 'weixin:', 'slack:']) {
      if (cfg.includes(p)) {
        throw new Error(`scoped-gateway: REFUSED — ${home}/config.yaml configures ${p}`);
      }
    }
    if (!cfg.includes(`port: ${SCOPED_PORT}`)) {
      throw new Error(`scoped-gateway: REFUSED — ${home}/config.yaml does not pin the scoped `
        + `port ${SCOPED_PORT}; it could collide with the live sidecar on 8123.`);
    }
  }
  if (SCOPED_PORT === 8123 || SCOPED_SIDECAR_PORT === 8790) {
    throw new Error('scoped-gateway: REFUSED — the scoped ports are the live ports');
  }
  return true;
}

/**
 * Register the profile with Hermes, so the layout and the launchd label are the supported ones.
 *
 * Deliberately NOT --clone: cloning copies .env, which carries TELEGRAM_BOT_TOKEN. A second
 * process holding that token connects as Terra's bot and starts consuming her messages. The
 * scoped .env is built by allowlist instead (writeScopedEnv).
 */
export function ensureScopedProfile({ log = () => {} } = {}) {
  if (existsSync(join(SCOPED_HOME, 'config.yaml'))) return { created: false };
  const r = spawnSync('hermes', ['profile', 'create', SCOPED_PROFILE,
    '--no-alias', '--no-skills',
    '--description', 'Throwaway instance for agentmob mutation testing. Not for use.'],
    { encoding: 'utf8', env: { ...process.env, HERMES_HOME: LIVE_HOME } });
  if (r.status !== 0 && !existsSync(SCOPED_HOME)) {
    throw new Error(`scoped-gateway: could not create profile ${SCOPED_PROFILE}: `
      + `${(r.stderr || r.stdout || '').slice(-400)}`);
  }
  log(`profile ${SCOPED_PROFILE} ready (no --clone, so no credentials were copied)`);
  return { created: true };
}

/** Create (or refresh) the scoped home: config, env, and its OWN copy of the plugin. */
export function setupScopedHome({ home = SCOPED_HOME, log = () => {}, allowedClients = null,
                                  configOnly = false } = {}) {
  assertNotLiveHome(home);
  if (home === SCOPED_HOME) ensureScopedProfile({ log });
  mkdirSync(join(home, 'plugins'), { recursive: true });

  let live = {};
  try {
    /* Only the model stanza is read across, so the scoped agent answers with the same provider.
     * Parsed with a crude scan rather than a yaml dep — two scalar fields. */
    const raw = readFileSync(join(LIVE_HOME, 'config.yaml'), 'utf8');
    const seg = raw.slice(raw.indexOf('\nmodel:'));
    const d = /\n\s+default:\s*(\S+)/.exec(seg);
    const p = /\n\s+provider:\s*(\S+)/.exec(seg);
    live.model = { default: d && d[1], provider: p && p[1] };
  } catch { /* fall back to the built-in defaults */ }

  writeFileSync(join(home, 'config.yaml'), scopedConfigYaml(live, { allowedClients }),
    { mode: 0o600 });
  log(allowedClients ? `allowlist pinned to "${allowedClients}"`
                     : 'no allowlist (pairing mode — any client accepted)');
  const envInfo = writeScopedEnv(home);
  log(`config + env written (${envInfo.keys.join(', ') || 'no credentials found'}`
    + `${envInfo.missing.length ? `; missing: ${envInfo.missing.join(', ')}` : ''})`);

  /* configOnly re-writes config + env and leaves the plugin copy ALONE.
   *
   * A caller that changes only configuration between runs — identity-pin flips the allowlist
   * three times — must not re-rsync the plugin, because that would overwrite any mutation
   * applied to the scoped copy with the pristine live file and record a false MISS. It would
   * also mean the only way to make a scoped mutation "work" is to mutate the LIVE plugin and let
   * the copy propagate it, which is exactly the thing the scoped instance exists to avoid. */
  if (configOnly) {
    log('config only — plugin copy left as-is');
    assertScopedSafe(home);
    return home;
  }

  /* The plugin copy is what mutations edit, so the LIVE plugin is never touched by these entries
   * at all — strictly safer than the previous arrangement, which mutated the live adapter and
   * relied on a restore.
   *
   * Excluded: .identity.json (never copy a private key; the sidecar generates its own on first
   * run, giving the scoped instance a distinct identity), __pycache__ (stale bytecode has
   * produced false MISSES here before) and .git. */
  const src = join(LIVE_HOME, 'plugins', 'agentmob') + '/';
  const dst = join(home, 'plugins', 'agentmob') + '/';
  const r = spawnSync('rsync', ['-a', '--delete',
    '--exclude', '.identity.json', '--exclude', '__pycache__', '--exclude', '.git',
    src, dst], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`scoped-gateway: plugin copy failed: ${r.stderr || r.status}`);
  /* The scoped sidecar generates its OWN identity on first run, so this file legitimately exists
   * from the second setup onwards — my first version of this check treated any presence as a leak
   * and failed on a perfectly correct home. What must never be true is that it is a COPY of the
   * live key, so compare the bytes rather than the existence. */
  const liveId = join(LIVE_HOME, 'plugins', 'agentmob', 'sidecar', '.identity.json');
  const scopedId = join(dst, 'sidecar', '.identity.json');
  if (existsSync(scopedId) && existsSync(liveId)
      && readFileSync(scopedId, 'utf8') === readFileSync(liveId, 'utf8')) {
    throw new Error('scoped-gateway: REFUSED — the scoped sidecar identity is byte-identical to '
      + 'the live one. A private key must not be duplicated; delete '
      + scopedId.replace(homedir(), '~') + ' and let the scoped sidecar generate its own.');
  }
  log(`plugin copied to ${dst.replace(homedir(), '~')} (identity excluded)`);

  /* The agentmob SKILLS, without which the agent cannot render.
   *
   * The profile is created --no-skills on purpose: Terra's skill library is hers, it is large, and
   * most of it reaches services this instance must not touch. But rendering is not a tool call —
   * the agent produces a {"__ui__": ...} envelope because a skill tells it how, and with no skills
   * at all e2e-voice-render got a spoken reply and no render, failing on a capability the scoped
   * instance simply had not been given. So: the agentmob skills, by exact prefix, and nothing else.
   */
  const skillSrc = join(LIVE_HOME, 'skills', 'integrations');
  const skillDst = join(home, 'skills', 'integrations');
  let copied = [];
  if (existsSync(skillSrc)) {
    mkdirSync(skillDst, { recursive: true });
    for (const name of readdirSync(skillSrc)) {
      if (!name.startsWith('agentmob-')) continue;
      const sr = spawnSync('rsync', ['-a', '--delete', '--exclude', '.git',
        join(skillSrc, name) + '/', join(skillDst, name) + '/'], { encoding: 'utf8' });
      if (sr.status === 0) copied.push(name);
    }
  }
  log(`skills: ${copied.length ? copied.join(', ') : 'none found'}`);
  assertScopedSafe(home);
  return home;
}

export function portListening(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout || '').includes('LISTEN');
}

/**
 * The LIVE gateway's pid, so a caller can prove it was untouched.
 *
 * Read from ~/.hermes/gateway.pid, not from ps. A `ps | grep hermes.*gateway | head -1` matched
 * the SCOPED instance the moment one was running and reported it as the live pid — which would
 * have turned the "production gateway unchanged" claim into a coin flip. The live root's pidfile
 * names exactly one process and cannot be confused with a profile's.
 */
export function liveGatewayPid() {
  try {
    const raw = readFileSync(join(LIVE_HOME, 'gateway.pid'), 'utf8');
    /* The file may be JSON ({"pid":...}) or a bare number depending on version. */
    const m = /"pid"\s*:\s*(\d+)/.exec(raw) || /^\s*(\d+)/.exec(raw);
    const pid = m ? Number(m[1]) : null;
    return pid && pidAlive(pid) ? pid : null;
  } catch { return null; }
}

let current = null;

/**
 * Start the scoped gateway in the foreground, as OUR child process.
 *
 * No launchd, no label, nothing for the guard in gateway-scope.mjs to refuse: stopping it is a
 * signal to a pid we own. `hermes gateway run` is the documented foreground mode.
 */
export function startScoped({ home = SCOPED_HOME, timeoutMs = 180000, log = () => {} } = {}) {
  assertScopedSafe(home);
  if (portListening(SCOPED_PORT)) {
    log(`something is already listening on ${SCOPED_PORT}; reusing it`);
    return { ok: true, pid: null, reused: true };
  }
  const logPath = join(home, 'scoped-gateway.log');
  const fd = openSync(logPath, 'a');
  const child = spawn('hermes', ['gateway', 'run', '-v'], {
    env: { ...process.env, HERMES_HOME: home, HERMES_QUIET: '1',
           /* Belt and braces: kanban_db already resolves the board per profile, but pinning it
            * means even a change in that resolution cannot reach the live board. */
           HERMES_KANBAN_DB: join(home, 'kanban.db'),
           /* Do not let the outer session's identity leak into the scoped agent's context. */
           HERMES_SESSION_KEY: '', HERMES_SESSION_CHAT_ID: '', HERMES_SESSION_PLATFORM: '',
           HERMES_CRON_SESSION: '', _HERMES_GATEWAY: '' },
    detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  current = { pid: child.pid, home, logPath };
  log(`started pid ${child.pid}, log ${logPath.replace(homedir(), '~')}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (portListening(SCOPED_PORT)) {
      spawnSync('sleep', ['4']);   // let the sidecar finish binding
      const leaks = liveFilesHeldBy(child.pid);
      if (leaks.length) {
        /* Stopping rather than warning: a scoped instance writing the live root's state is the one
         * outcome this file exists to prevent, and a line in a log is not a control. */
        stopScoped({ log });
        return { ok: false, pid: child.pid, logPath,
                 note: `the scoped gateway holds LIVE state open: ${leaks.join(', ')}` };
      }
      return { ok: true, pid: child.pid, logPath };
    }
    /* If the process died, stop waiting and hand back the tail of its log — a silent 180s wait
     * that ends in "not listening" tells you nothing about why. */
    if (!pidAlive(child.pid)) {
      return { ok: false, pid: child.pid, logPath, note: 'the scoped gateway exited',
               tail: logTail(logPath) };
    }
    spawnSync('sleep', ['2']);
  }
  return { ok: false, pid: child.pid, logPath,
           note: `nothing listening on ${SCOPED_PORT} after ${timeoutMs}ms`,
           tail: logTail(logPath) };
}

/**
 * Writable state the scoped process holds inside the LIVE home. Must be empty.
 *
 * Read from the running process rather than reasoned about from config: the config says the board
 * and socket are per-profile, and this is what checks whether the process agrees. Reads of shared
 * PROGRAM files are expected and fine; a .db / .sock / .lock / .env under the live root is not.
 */
export function liveFilesHeldBy(pid) {
  if (!pid) return [];
  const r = spawnSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' });
  const live = resolve(LIVE_HOME);
  return (r.stdout || '').split('\n')
    .filter((l) => l.startsWith('n')).map((l) => l.slice(1))
    /* Anything under a profile directory is the scoped instance's own state, not the live root's. */
    .filter((f) => f.startsWith(live + '/') && !f.startsWith(resolve(PROFILES_ROOT) + '/'))
    .filter((f) => /\.(db|db-wal|db-shm|sock|lock|env)$|\/kanban/.test(f))
    .filter((v, i, a) => a.indexOf(v) === i);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function logTail(p, n = 40) {
  try { return readFileSync(p, 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; }
}

/** Stop the scoped gateway and its sidecar. Signals the GROUP: the sidecar is a grandchild. */
export function stopScoped({ log = () => {} } = {}) {
  const pid = current && current.pid;
  if (pid) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
      for (let i = 0; i < 10; i++) { if (!pidAlive(pid)) break; spawnSync('sleep', ['1']); }
      if (!pidAlive(pid)) break;
    }
    log(`stopped ${pid}`);
  }
  /* A sidecar on the scoped port can outlive its parent — that is the orphan case this project
   * already knows about. Reap it by port so the next run does not inherit a stale listener. */
  const r = spawnSync('bash', ['-c',
    `lsof -nP -iTCP:${SCOPED_PORT} -sTCP:LISTEN -t 2>/dev/null; `
    + `lsof -nP -iTCP:${SCOPED_SIDECAR_PORT} -sTCP:LISTEN -t 2>/dev/null`],
    { encoding: 'utf8' });
  for (const p of (r.stdout || '').split('\n').map((x) => Number(x.trim())).filter(Boolean)) {
    try { process.kill(p, 'SIGTERM'); } catch {}
  }
  current = null;
  return true;
}

export function scopedInfo() { return current; }
