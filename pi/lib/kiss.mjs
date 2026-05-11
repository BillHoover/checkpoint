// KISS-over-TCP client for talking to Direwolf (or any KISS-capable TNC daemon).
//
// KISS frame structure on the wire:
//
//   FEND  [type byte]  [escaped payload bytes...]  FEND
//
//   FEND  = 0xC0   frame delimiter
//   FESC  = 0xDB   escape
//   TFEND = 0xDC   transposed FEND
//   TFESC = 0xDD   transposed FESC
//
// Escaping applies to the payload only: 0xC0 -> 0xDB 0xDC, 0xDB -> 0xDB 0xDD.
//
// Type byte: high nibble = TNC port (we always use 0), low nibble = command:
//   0 = data frame   (the only one we send / receive)
//   1 = TXDELAY
//   2 = persistence
//   ...etc. Not relevant for the bridge.
//
// We auto-reconnect on disconnect. Direwolf restarting mid-event must not kill
// the bridge.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { decodeFrame } from './ax25.mjs';

const FEND = 0xc0;
const FESC = 0xdb;
const TFEND = 0xdc;
const TFESC = 0xdd;

const CMD_DATA = 0x00;

function escape(buf) {
  // Pessimistic allocation: worst case every byte is escaped (doubled).
  const out = Buffer.alloc(buf.length * 2);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === FEND) {
      out[n++] = FESC;
      out[n++] = TFEND;
    } else if (b === FESC) {
      out[n++] = FESC;
      out[n++] = TFESC;
    } else {
      out[n++] = b;
    }
  }
  return out.slice(0, n);
}

function unescape(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === FESC && i + 1 < buf.length) {
      const next = buf[++i];
      if (next === TFEND) out[n++] = FEND;
      else if (next === TFESC) out[n++] = FESC;
      else {
        // Malformed escape — pass both bytes through and let the AX.25
        // decoder reject the frame if it cares.
        out[n++] = b;
        out[n++] = next;
      }
    } else {
      out[n++] = b;
    }
  }
  return out.slice(0, n);
}

/**
 * Wrap an AX.25 frame buffer in a KISS data frame ready to write to the TNC.
 */
export function buildKissDataFrame(ax25Buf) {
  const escaped = escape(ax25Buf);
  const out = Buffer.alloc(escaped.length + 3);
  out[0] = FEND;
  out[1] = CMD_DATA; // port 0, command 0 (data)
  escaped.copy(out, 2);
  out[2 + escaped.length] = FEND;
  return out;
}

export class KissClient extends EventEmitter {
  constructor({ host, port, reconnectMs = 3000, logger = console }) {
    super();
    this.host = host;
    this.port = port;
    this.reconnectMs = reconnectMs;
    this.logger = logger;
    this.socket = null;
    this.connected = false;
    this.shuttingDown = false;
    this._rxBuf = Buffer.alloc(0);
    this._inFrame = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this.shuttingDown = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  _connect() {
    if (this.shuttingDown) return;
    this.logger.log?.(`[kiss] connecting to ${this.host}:${this.port}`);
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    this._rxBuf = Buffer.alloc(0);
    this._inFrame = false;

    sock.on('connect', () => {
      this.connected = true;
      this.logger.log?.(`[kiss] connected`);
      this.emit('open');
    });

    sock.on('data', (chunk) => this._onData(chunk));

    sock.on('close', () => {
      this.connected = false;
      this.logger.log?.(`[kiss] disconnected`);
      this.emit('close');
      if (!this.shuttingDown) {
        setTimeout(() => this._connect(), this.reconnectMs);
      }
    });

    sock.on('error', (err) => {
      this.logger.log?.(`[kiss] socket error: ${err.message}`);
      this.emit('error', err);
      // 'close' will fire after this and trigger reconnect.
    });
  }

  /**
   * Send an AX.25 frame (Buffer). Returns true if it was written, false if
   * the link is currently down.
   */
  sendAx25(ax25Buf) {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.write(buildKissDataFrame(ax25Buf));
      return true;
    } catch (err) {
      this.logger.log?.(`[kiss] write failed: ${err.message}`);
      return false;
    }
  }

  _onData(chunk) {
    // Treat the stream as a sequence of FEND-delimited KISS frames. KISS allows
    // back-to-back FENDs (the second opens the next frame) and we tolerate that.
    let buf = Buffer.concat([this._rxBuf, chunk]);
    let start = -1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== FEND) continue;
      if (start < 0) {
        start = i + 1;
      } else {
        const slice = buf.slice(start, i);
        if (slice.length > 0) this._handleKissFrame(slice);
        start = i + 1;
      }
    }
    if (start >= 0) {
      // Keep the tail (might be a partial frame in progress).
      this._rxBuf = buf.slice(start);
    } else {
      this._rxBuf = buf;
    }
    // Guard against runaway buffering if direwolf sends garbage.
    if (this._rxBuf.length > 65536) {
      this.logger.log?.(`[kiss] rx buffer overflow, dropping`);
      this._rxBuf = Buffer.alloc(0);
    }
  }

  _handleKissFrame(slice) {
    if (slice.length < 2) return; // need at least type + 1 payload byte
    const typeByte = slice[0];
    const port = (typeByte >> 4) & 0x0f;
    const cmd = typeByte & 0x0f;
    if (cmd !== CMD_DATA) return; // ignore non-data (param) frames silently
    const payload = unescape(slice.slice(1));
    let decoded;
    try {
      decoded = decodeFrame(payload);
    } catch (err) {
      this.emit('parseError', { err, raw: payload, port });
      return;
    }
    this.emit('frame', { port, ax25: decoded, raw: payload });
  }
}
