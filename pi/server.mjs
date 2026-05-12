// Checkpoint Pi bridge server.
//
// Responsibilities:
//   1. Serve the existing Checkpoint PWA assets over HTTPS, from this Pi.
//   2. Expose a small JSON/SSE API that the in-browser PWA uses to:
//        - feature-detect that a bridge is present  (GET  /api/health)
//        - send a CKPT/1 frame out over RF          (POST /api/tx)
//        - subscribe to inbound CKPT/1 frames       (GET  /api/rx, SSE)
//   3. Talk to Direwolf's KISS-over-TCP interface to actually move bytes on
//      and off the radio.
//
// The bridge does not own any rider state. The PWA on each EUD remains the
// source of truth; the bridge is a stateless radio I/O appliance.

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import url from 'node:url';
import { load as loadConfig } from './lib/config.mjs';
import { KissClient } from './lib/kiss.mjs';
import { encodeUI, fmtAddr } from './lib/ax25.mjs';
import { wrapCkptFrame, unwrapCkptFrame } from './lib/aprs.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'config.json');

const cfg = loadConfig(CONFIG_PATH);

const log = (...args) => console.log(new Date().toISOString(), ...args);

log(`[bridge] starting as ${fmtAddr({ callsign: cfg.station.callsign, ssid: cfg.station.ssid })}`);
log(`[bridge] static root: ${cfg.static.root}`);
log(`[bridge] HTTPS on ${cfg.https.host}:${cfg.https.port}`);
log(`[bridge] KISS to ${cfg.kiss.host}:${cfg.kiss.port}`);

// ---- KISS / radio side ----

const kiss = new KissClient({
  host: cfg.kiss.host,
  port: cfg.kiss.port,
  reconnectMs: cfg.kiss.reconnectMs,
  logger: { log },
});

const sseClients = new Set();
let rxCount = 0;
let txCount = 0;
let lastKissError = null;

kiss.on('open', () => {
  lastKissError = null;
});
kiss.on('error', (err) => {
  lastKissError = err.message;
});

kiss.on('frame', ({ ax25 }) => {
  const frame = unwrapCkptFrame(ax25.info, { addressee: cfg.aprs.addressee });
  if (!frame) return;
  // Drop echoes of our own transmissions (digipeaters reflect them back).
  if (ax25.src.callsign === cfg.station.callsign && ax25.src.ssid === cfg.station.ssid) {
    return;
  }
  rxCount++;
  const event = {
    frame,
    src: fmtAddr(ax25.src),
    receivedAt: Date.now(),
  };
  log(`[bridge] rx <${event.src}> ${frame}`);
  broadcastSse(event);
});

kiss.start();

function broadcastSse(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // Client disconnected mid-write; cleanup happens on the 'close' event.
    }
  }
}

// ---- HTTPS / PWA side ----

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const httpsOpts = {
  cert: fs.readFileSync(cfg.https.certFile),
  key: fs.readFileSync(cfg.https.keyFile),
};

const server = https.createServer(httpsOpts, (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  } catch {
    res.statusCode = 400;
    return res.end('bad request');
  }

  if (pathname === '/api/health') return handleHealth(req, res);
  if (pathname === '/api/tx') return handleTx(req, res);
  if (pathname === '/api/rx') return handleRx(req, res);

  return handleStatic(pathname, req, res);
});

server.listen(cfg.https.port, cfg.https.host, () => {
  log(`[bridge] listening on https://${cfg.https.host}:${cfg.https.port}/`);
});

// ---- API handlers ----

function handleHealth(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  jsonResponse(res, 200, {
    ok: true,
    bridge: 'checkpoint-pi-bridge',
    station: fmtAddr({ callsign: cfg.station.callsign, ssid: cfg.station.ssid }),
    kissConnected: kiss.connected,
    kissError: lastKissError,
    counters: { rx: rxCount, tx: txCount },
  });
}

function handleTx(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  readJsonBody(req, 16 * 1024)
    .then((body) => {
      if (!body || typeof body.frame !== 'string') {
        return jsonResponse(res, 400, { ok: false, error: 'expected { frame: string }' });
      }
      const frame = body.frame.trim();
      if (!frame.startsWith('CKPT/')) {
        return jsonResponse(res, 400, { ok: false, error: 'frame must start with CKPT/' });
      }
      if (frame.length > 67) {
        return jsonResponse(res, 400, {
          ok: false,
          error: `frame exceeds 67-char APRS limit (${frame.length})`,
        });
      }
      if (!kiss.connected) {
        return jsonResponse(res, 503, {
          ok: false,
          error: 'KISS link to direwolf is down',
        });
      }
      const info = wrapCkptFrame(frame, { addressee: cfg.aprs.addressee });
      const ax25 = encodeUI({
        destCall: cfg.aprs.destination,
        destSsid: cfg.aprs.destinationSsid,
        srcCall: cfg.station.callsign,
        srcSsid: cfg.station.ssid,
        digipath: cfg.aprs.digipath,
        info,
      });
      const sent = kiss.sendAx25(ax25);
      if (!sent) {
        return jsonResponse(res, 503, { ok: false, error: 'KISS write failed' });
      }
      txCount++;
      log(`[bridge] tx ${frame}`);
      jsonResponse(res, 200, { ok: true, sentAt: Date.now() });
    })
    .catch((err) => {
      jsonResponse(res, 400, { ok: false, error: err.message });
    });
}

function handleRx(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      /* ignore */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
}

// ---- Static file handler ----

function handleStatic(pathname, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(res, 'GET, HEAD');
  }
  let resolved = pathname;
  if (resolved.endsWith('/')) resolved += 'index.html';
  const filePath = path.resolve(cfg.static.root, '.' + resolved);
  const rel = path.relative(cfg.static.root, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', STATIC_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', data.length);
      return res.end();
    }
    res.end(data);
  });
}

// ---- helpers ----

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('Allow', allow);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('method not allowed');
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('invalid JSON body: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

// ---- shutdown ----

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[bridge] ${signal} received, shutting down`);
  kiss.stop();
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  // Hard-exit if close hangs for any reason.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
