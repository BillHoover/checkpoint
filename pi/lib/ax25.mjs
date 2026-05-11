// AX.25 v2.0 UI frame encoder/decoder.
//
// We only handle UI (unnumbered information) frames here — that's all APRS uses,
// and all the Checkpoint bridge ever needs. No I-frames, no S-frames, no DAMA.
//
// Wire layout of a UI frame, byte-for-byte:
//
//   [dest 7 bytes][src 7 bytes][digi1 7 bytes]...[digiN 7 bytes][0x03][0xF0][info...]
//
// Address subfield (7 bytes per address):
//   Bytes 0..5  : callsign ASCII (uppercase, space-padded to 6 chars), each byte
//                 shifted left by 1.
//   Byte 6 (SSID byte): bit pattern  C R R S S S S E
//     C  bit7 : command/response (dest=1, src=0) for src/dest; H-bit
//               (has-been-repeated) for digipeaters — 0 when we transmit.
//     RR bits6,5 : reserved, set to 11.
//     SSSS bits4..1 : SSID, 0..15.
//     E  bit0 : extension — 0 = more addresses follow, 1 = this is the last.
//
// References: AX.25 v2.0 spec §2.2; direwolf source ax25_pad.c for cross-checks.

const CALLSIGN_PAD = 6;
const ADDR_BYTES = 7;
const UI_CONTROL = 0x03;
const PID_NO_L3 = 0xf0;

const RR_BITS = 0b01100000; // reserved RR set to 11

function encodeCallsign(callsign) {
  // Accepts "AJ6UU" or "AJ6UU-2"; returns { call: "AJ6UU", ssid: 2 }.
  // Used by the higher-level helpers below.
  const m = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/i.exec(callsign);
  if (!m) throw new Error(`bad callsign: ${callsign}`);
  const ssid = m[2] ? Number(m[2]) : 0;
  if (ssid < 0 || ssid > 15) throw new Error(`bad ssid in ${callsign}`);
  return { call: m[1].toUpperCase(), ssid };
}

function writeAddress(out, off, call, ssid, { c, h, last }) {
  if (!/^[A-Z0-9]{1,6}$/.test(call)) throw new Error(`bad callsign: ${call}`);
  const padded = call.padEnd(CALLSIGN_PAD, ' ');
  for (let i = 0; i < CALLSIGN_PAD; i++) {
    out[off + i] = (padded.charCodeAt(i) << 1) & 0xff;
  }
  // SSID byte
  let byte = RR_BITS | ((ssid & 0x0f) << 1);
  if (c) byte |= 0x80; // command bit (dest) — also reused as H-bit on digis
  if (h) byte |= 0x80; // has-been-repeated (digipeater)
  if (last) byte |= 0x01;
  out[off + CALLSIGN_PAD] = byte & 0xff;
  return off + ADDR_BYTES;
}

function readAddress(buf, off) {
  if (off + ADDR_BYTES > buf.length) throw new Error('address truncated');
  let call = '';
  for (let i = 0; i < CALLSIGN_PAD; i++) {
    const ch = (buf[off + i] >> 1) & 0x7f;
    if (ch !== 0x20) call += String.fromCharCode(ch);
  }
  const ssidByte = buf[off + CALLSIGN_PAD];
  return {
    callsign: call,
    ssid: (ssidByte >> 1) & 0x0f,
    cOrH: (ssidByte & 0x80) !== 0,
    last: (ssidByte & 0x01) !== 0,
  };
}

/**
 * Build a complete AX.25 UI frame as a Buffer.
 *
 * @param {object} opts
 * @param {string} opts.destCall    e.g. "APCKPT"
 * @param {number} opts.destSsid    0..15
 * @param {string} opts.srcCall     e.g. "AJ6UU"
 * @param {number} opts.srcSsid     0..15
 * @param {string[]} [opts.digipath] e.g. ["WIDE1-1", "WIDE2-1"]
 * @param {Buffer|Uint8Array|string} opts.info  info field payload
 * @param {number} [opts.pid=0xF0]  protocol identifier
 */
export function encodeUI(opts) {
  const digis = (opts.digipath ?? []).map(encodeCallsign);
  const info =
    typeof opts.info === 'string' ? Buffer.from(opts.info, 'utf8') : Buffer.from(opts.info);
  const totalLen = ADDR_BYTES * (2 + digis.length) + 2 + info.length;
  const out = Buffer.alloc(totalLen);

  let off = 0;
  const noDigis = digis.length === 0;

  // Destination first. C-bit set in AX.25 v2 command frames; AX.25 standard
  // places dest before src.
  off = writeAddress(out, off, opts.destCall, opts.destSsid ?? 0, {
    c: true,
    last: false,
  });

  // Source.
  off = writeAddress(out, off, opts.srcCall, opts.srcSsid ?? 0, {
    c: false,
    last: noDigis,
  });

  // Digipeaters.
  digis.forEach((d, i) => {
    const isLast = i === digis.length - 1;
    off = writeAddress(out, off, d.call, d.ssid, {
      h: false,
      last: isLast,
    });
  });

  out[off++] = opts.control ?? UI_CONTROL;
  out[off++] = opts.pid ?? PID_NO_L3;

  info.copy(out, off);
  return out;
}

/**
 * Decode an AX.25 frame. Returns { dest, src, digipath, control, pid, info }.
 * Throws on malformed input.
 */
export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let off = 0;
  const dest = readAddress(buf, off);
  off += ADDR_BYTES;
  if (dest.last) {
    throw new Error('dest cannot be the last address');
  }
  const src = readAddress(buf, off);
  off += ADDR_BYTES;

  const digipath = [];
  let last = src.last;
  while (!last) {
    if (off + ADDR_BYTES > buf.length) throw new Error('digipath truncated');
    if (digipath.length >= 8) throw new Error('too many digipeaters');
    const d = readAddress(buf, off);
    off += ADDR_BYTES;
    digipath.push({
      callsign: d.callsign,
      ssid: d.ssid,
      repeated: d.cOrH,
    });
    last = d.last;
  }

  if (off + 2 > buf.length) throw new Error('control/pid truncated');
  const control = buf[off++];
  const pid = buf[off++];
  const info = buf.slice(off);

  return {
    dest: { callsign: dest.callsign, ssid: dest.ssid },
    src: { callsign: src.callsign, ssid: src.ssid },
    digipath,
    control,
    pid,
    info,
  };
}

/**
 * Quick predicate: is this a UI frame with PID 0xF0 (the only kind APRS uses)?
 */
export function isAprsUI(decoded) {
  return decoded.control === UI_CONTROL && decoded.pid === PID_NO_L3;
}

/**
 * Render a callsign+SSID back to text form for logging.
 */
export function fmtAddr(a) {
  return a.ssid > 0 ? `${a.callsign}-${a.ssid}` : a.callsign;
}
