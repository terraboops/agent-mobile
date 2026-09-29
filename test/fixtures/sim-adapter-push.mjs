#!/usr/bin/env node
/**
 * sim-adapter-push — play the ADAPTER's one part in a reply: push TTS audio into the sidecar.
 *
 * The real adapter authenticates on the sidecar's ctl port and sends `{"type":"pcm","pcm_b64":…}`
 * (24 kHz s16 mono). From there the SIDECAR decides everything this harness exists to observe:
 * WebRTC or WS for the downlink, paced or burst, whether a Stop cuts it short. So nothing about
 * those decisions is scripted here — only the audio is.
 *
 *   node sim-adapter-push.mjs <ctlPort> [seconds]
 */
import { createConnection } from 'node:net';
const [ctl, secs = '3'] = process.argv.slice(2);
const rate = 24000, n = Math.round(Number(secs) * rate);
const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
const sock = createConnection({ host: '127.0.0.1', port: Number(ctl) }, () => {
  sock.write(`${process.env.AGENTMOB_SIDECAR_TOKEN || 'dev'}\n`);
  sock.write(JSON.stringify({ type: 'pcm', pcm_b64: pcm.toString('base64') }) + '\n');
  setTimeout(() => sock.end(), 500);
});
sock.on('error', (e) => { process.stderr.write(`sim-adapter-push: ${e.message}\n`); process.exit(1); });
sock.on('close', () => process.exit(0));
