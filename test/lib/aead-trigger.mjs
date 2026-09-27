/**
 * aead-trigger — make the agent speak, without a human and without the phone's microphone.
 *
 * The device run needs the agent to say something so the speaking pill and the Stop truncation
 * can be observed. The obvious route does not work: `hermes send -t agentmob` cannot reach the
 * platform out-of-process — it prints "No live adapter for platform 'agentmob'" and EXITS 0, so
 * checking its status reports success for a command that did nothing.
 *
 * What does work is the route the phone itself uses: a TYPED TURN over an authenticated AEAD
 * connection. The sidecar relays it to the agent exactly as it relays one from the handset.
 *
 * ROUTING, which is the part that matters and is easy to get wrong:
 *
 *   The sidecar sends reply AUDIO to `conns[0]` — the FIRST connection in its set, not the one
 *   that asked. So a trigger client must connect AFTER the phone and disconnect once the turn
 *   is in, leaving the phone as the only connection and therefore the unambiguous target. If
 *   the trigger stayed connected and the phone happened to reconnect mid-run, the phone would
 *   move to the back of the set and the reply would be spoken at the trigger instead.
 *
 * The TEXT reply is routed by pending id back to the sender, so it is lost when the trigger
 * disconnects. That is fine and deliberate: the device run wants the AUDIO on the handset, and
 * the audio path does not depend on that id.
 */
import { AgentStream } from '../../transport/ws-client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one typed turn, then get out of the way.
 *
 * @param {object} opts
 *   url            sidecar ws url (default the live one)
 *   text           what the agent should be asked
 *   disconnect     leave after sending, so conns[0] is the phone (default true)
 *   settleMs       how long to wait after the turn before disconnecting
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
export async function typedTurn({ url = 'ws://127.0.0.1:8123', text,
                                  disconnect = true, settleMs = 1500 } = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: 'no text to send' };
  let s;
  try {
    s = new AgentStream({ url, onPair: async () => true });
    await s.connect();
  } catch (e) {
    return { ok: false, error: `could not open an AEAD channel to ${url}: ${e && e.message || e}` };
  }
  try {
    /* A plain cmd string is a TYPED TURN to the agent, not an echo — the same thing the app
     * sends from its text path. Fire and forget: the reply comes back as audio to conns[0],
     * and waiting for a text reply here would just time out once we disconnect. */
    s.cmd(String(text)).catch(() => {});
    await sleep(settleMs);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: `turn failed: ${e && e.message || e}` };
  } finally {
    if (disconnect) { try { s.close?.(); } catch {} }
  }
}
