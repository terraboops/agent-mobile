// wire.mjs — the one place the sidecar writes to a phone socket.
//
// Every send used to be `try { ws.send(...) } catch {}`. That is the same lie the adapter's
// outbound path had: a message vanishes and nothing anywhere says so. It is worse here for the
// ack path, because a lost ack leaves the PHONE waiting on a reply that will never come — it
// sees a timeout and cannot tell a slow host from a dead one.
//
// Two failures live behind that bare catch and they are not the same:
//
//   socket not OPEN  — the phone is gone or mid-disconnect. Expected, and frequent: status
//                      pushes run several times a second while speaking, so logging every one
//                      would bury the log. Reported on the first drop per connection and
//                      periodically after, never silently.
//   send() threw     — the socket looked usable and the write still failed. Always unexpected,
//                      always logged.
//
// Kept in its own module so it can be tested without booting the whole sidecar; index.mjs is
// ~1900 lines of server and this is the part worth pinning down.

export const WS_OPEN = 1;

/** Human-readable socket state, for logs that have to explain themselves. */
export function wsState(ws) {
  if (!ws) return 'missing';
  switch (ws.readyState) {
    case 0: return 'CONNECTING';
    case 1: return 'OPEN';
    case 2: return 'CLOSING';
    case 3: return 'CLOSED';
    default: return `readyState=${ws.readyState}`;
  }
}

/**
 * Send one encrypted frame to a phone, reporting what actually happened.
 *
 * @param conn   the phone connection ({ ws, channel, ... })
 * @param frame  the already-packed bytes to write
 * @param what   short description for the log ('status', 'ack i=3', ...)
 * @param log    the sidecar's logger
 * @param opts   { quietWhenClosed } — true for high-frequency traffic (status/level), which
 *               still reports the first drop and then every Nth, so a permanently dead socket
 *               cannot look like a healthy one.
 * @returns true if the bytes reached the socket, false otherwise.
 */
export function sendFrame(conn, frame, what, log, opts = {}) {
  const ws = conn && conn.ws;
  if (!ws || ws.readyState !== WS_OPEN) {
    conn.__drops = (conn.__drops || 0) + 1;
    const n = conn.__drops;
    const nth = opts.everyNth || 50;
    if (!opts.quietWhenClosed || n === 1 || n % nth === 0) {
      log(`→ phone ${what} NOT SENT: socket is ${wsState(ws)}`
        + (n > 1 ? ` (${n} undelivered on this connection)` : ''));
    }
    return false;
  }
  try {
    ws.send(frame);
    return true;
  } catch (e) {
    // An OPEN socket that refuses a write is never routine. Say so every time.
    log(`→ phone ${what} FAILED on an OPEN socket: ${(e && e.message) || e}`
      + ' — the phone did not receive it');
    return false;
  }
}
