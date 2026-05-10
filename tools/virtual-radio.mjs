// Virtual radio relay for testing Checkpoint's radio sync without an actual radio.
//
// Open two (or more) browser tabs of the Checkpoint app, each with a small client
// shim that opens ws://localhost:8765/ and sends/receives radio frames. The relay
// rebroadcasts every frame to all OTHER connected clients, optionally dropping or
// delaying messages to mimic an unreliable RF link.
//
// Usage:
//   node tools/virtual-radio.mjs                # default: lossless, no latency
//   PORT=9000 LOSS=0.1 LATENCY_MS=500 node tools/virtual-radio.mjs
//
// Env knobs:
//   PORT        listening port           (default 8765)
//   LOSS        per-message drop prob    (default 0,    range 0..1)
//   LATENCY_MS  per-message delay ms     (default 0)
//   JITTER_MS   uniform +/- jitter ms    (default 0)
//
// Frames are passed through opaque — the relay does not parse them. This keeps
// the simulator transport-agnostic; whatever printable-ASCII line the app sends
// is what its peers receive.

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8765);
const LOSS = Math.max(0, Math.min(1, Number(process.env.LOSS ?? 0)));
const LATENCY_MS = Math.max(0, Number(process.env.LATENCY_MS ?? 0));
const JITTER_MS = Math.max(0, Number(process.env.JITTER_MS ?? 0));

const wss = new WebSocketServer({ port: PORT });
let nextId = 1;

console.log(`virtual-radio relay listening on ws://localhost:${PORT}/`);
console.log(`  loss=${LOSS}  latency=${LATENCY_MS}ms  jitter=±${JITTER_MS}ms`);
console.log(`  open the Checkpoint app in two tabs and connect each to this URL.`);

wss.on('connection', (ws, req) => {
  ws.id = nextId++;
  ws.label = `#${ws.id} ${req.socket.remoteAddress}`;
  console.log(`[connect] ${ws.label}  (${wss.clients.size} total)`);

  ws.on('message', (data) => {
    const msg = data.toString('utf8');
    const display = msg.length > 80 ? msg.slice(0, 77) + '...' : msg;

    if (Math.random() < LOSS) {
      console.log(`[drop  ] from ${ws.label}: ${display}`);
      return;
    }

    const delay = LATENCY_MS + (Math.random() * 2 - 1) * JITTER_MS;
    const send = () => {
      let delivered = 0;
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === client.OPEN) {
          client.send(msg);
          delivered++;
        }
      }
      console.log(`[relay ] from ${ws.label} -> ${delivered} peer(s): ${display}`);
    };
    if (delay <= 0) send();
    else setTimeout(send, delay);
  });

  ws.on('close', () => {
    console.log(`[close ] ${ws.label}  (${wss.clients.size - 1} remaining)`);
  });

  ws.on('error', (err) => {
    console.error(`[error ] ${ws.label}: ${err.message}`);
  });
});

process.on('SIGINT', () => {
  console.log('\nshutting down');
  wss.close(() => process.exit(0));
});
