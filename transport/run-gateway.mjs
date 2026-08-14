// run-gateway.mjs — launch the mock agent gateway on a fixed port (default 8123).
// Used by the JVM interop test and for on-device testing (phone -> this port).
//
// A tiny localhost HTTP control server (127.0.0.1:8124) toggles the partition
// simulation flag for on-device tests:  curl http://127.0.0.1:8124/dead
import { createServer } from 'node:http';
import { startWsGateway } from './ws-gateway.js';

const port = Number(process.env.PORT || 8123);
const gw = await startWsGateway({ port });
console.log(`LISTENING ${gw.port}`); // stdout: consumed by the JVM interop test

const ctl = createServer((req, res) => {
  res.setHeader('content-type', 'text/plain');
  if (req.url && req.url.startsWith('/dead')) {
    if (req.url.includes('on=1')) gw.setDead(true);
    else if (req.url.includes('off=1')) gw.setDead(false);
    else gw.setDead(!gw.state.dead);
    res.end(`DEAD=${gw.state.dead}\n`);
  } else if (req.url && req.url.startsWith('/loopback')) {
    if (req.url.includes('on=1')) gw.setLoopback(true);
    else if (req.url.includes('off=1')) gw.setLoopback(false);
    else gw.setLoopback(!gw.state.loopback);
    res.end(`LOOPBACK=${gw.state.loopback}\n`);
  } else if (req.url && req.url.startsWith('/state')) {
    res.end(`DEAD=${gw.state.dead} LOOPBACK=${gw.state.loopback}\n`);
  } else { res.end('use /dead?on=1 | /dead?off=1 | /loopback?on=1 | /state\n'); }
});
ctl.listen(8124, '127.0.0.1', () => console.log('CTL 8124'));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
// keep alive
await new Promise(() => {});
