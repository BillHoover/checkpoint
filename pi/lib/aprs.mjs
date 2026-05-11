// APRS message wrap/unwrap for CKPT/1 frames.
//
// On the wire (info field of an AX.25 UI frame), the APRS message format is:
//
//   ':' <addressee 9 chars, space-padded> ':' <text up to 67 chars> [ '{' <msgno> ]
//
// We use a synthetic addressee (default "CKPT", padded to "CKPT     ") so the
// packet looks like a valid addressed APRS message — iGates will forward it,
// digipeaters will relay it — but no real station ACKs it. The gossip protocol
// in the PWA handles dedup itself, so we don't request or send ACKs.

const ADDRESSEE_WIDTH = 9;

export function padAddressee(name) {
  const up = String(name).toUpperCase();
  if (up.length > ADDRESSEE_WIDTH) {
    throw new Error(`addressee too long (max ${ADDRESSEE_WIDTH}): ${name}`);
  }
  return up.padEnd(ADDRESSEE_WIDTH, ' ');
}

/**
 * Wrap a CKPT/1 frame string in an APRS message info field.
 * Returns the bytes (Buffer) ready to drop into an AX.25 UI frame's info field.
 */
export function wrapCkptFrame(frame, { addressee = 'CKPT' } = {}) {
  if (typeof frame !== 'string') throw new Error('frame must be a string');
  if (!frame.startsWith('CKPT/')) {
    throw new Error(`frame missing CKPT/ magic: ${frame.slice(0, 16)}...`);
  }
  if (frame.length > 67) {
    throw new Error(`frame exceeds 67-char APRS message limit (${frame.length})`);
  }
  const addr = padAddressee(addressee);
  return Buffer.from(`:${addr}:${frame}`, 'ascii');
}

/**
 * Try to extract a CKPT/1 frame from an AX.25 info field. Returns the frame
 * string if this is an APRS message addressed to the configured addressee and
 * the text starts with CKPT/, otherwise null.
 */
export function unwrapCkptFrame(info, { addressee = 'CKPT' } = {}) {
  if (!info || info.length < 12) return null;
  // Must look like ':XXXXXXXXX:...'
  if (info[0] !== 0x3a) return null; // ':'
  if (info[10] !== 0x3a) return null;
  const addr = info.slice(1, 10).toString('ascii');
  if (addr !== padAddressee(addressee)) return null;
  // Strip any trailing {msgno (we never request ACKs, but be tolerant).
  let text = info.slice(11).toString('ascii');
  const brace = text.indexOf('{');
  if (brace >= 0) text = text.slice(0, brace);
  if (!text.startsWith('CKPT/')) return null;
  return text;
}

/**
 * Quick predicate for "does this AX.25 frame look like one of ours we should
 * forward to the PWA?" — used to filter out other APRS chatter on the channel.
 */
export function isCheckpointFrame(decoded, { addressee = 'CKPT' } = {}) {
  return unwrapCkptFrame(decoded.info, { addressee }) != null;
}
