// Config loader for the Checkpoint Pi bridge.
//
// JSON file. Required fields are validated up front; the process exits with a
// readable message if anything is wrong. See config.example.json for the shape.

import fs from 'node:fs';
import path from 'node:path';

const CALLSIGN_RE = /^[A-Z0-9]{1,6}$/;

function fail(msg) {
  throw new Error(`config: ${msg}`);
}

function requireType(obj, key, type, label) {
  if (obj == null || typeof obj[key] !== type) {
    fail(`${label}.${key} must be a ${type}`);
  }
}

export function load(filePath) {
  const abs = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    fail(`could not read ${abs}: ${err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    fail(`${abs} is not valid JSON: ${err.message}`);
  }
  return validate(cfg, path.dirname(abs));
}

function validate(cfg, baseDir) {
  if (!cfg || typeof cfg !== 'object') fail('top level must be an object');

  // station
  if (!cfg.station) fail('missing "station"');
  const sc = String(cfg.station.callsign || '').toUpperCase();
  if (!CALLSIGN_RE.test(sc))
    fail(
      `station.callsign must match ${CALLSIGN_RE} (got ${JSON.stringify(cfg.station.callsign)})`
    );
  const ssid = Number(cfg.station.ssid);
  if (!Number.isInteger(ssid) || ssid < 0 || ssid > 15)
    fail('station.ssid must be an integer 0..15');
  cfg.station = { callsign: sc, ssid };

  // aprs
  if (!cfg.aprs) fail('missing "aprs"');
  const dest = String(cfg.aprs.destination || '').toUpperCase();
  if (!CALLSIGN_RE.test(dest)) fail(`aprs.destination must match ${CALLSIGN_RE}`);
  const destSsid = Number(cfg.aprs.destinationSsid ?? 0);
  if (!Number.isInteger(destSsid) || destSsid < 0 || destSsid > 15)
    fail('aprs.destinationSsid must be 0..15');
  const digipath = Array.isArray(cfg.aprs.digipath) ? cfg.aprs.digipath.map(String) : [];
  for (const hop of digipath) {
    if (!/^[A-Z0-9]{1,6}(-(1[0-5]|[0-9]))?$/.test(hop))
      fail(`aprs.digipath entry ${JSON.stringify(hop)} is not a valid AX.25 callsign[-ssid]`);
  }
  const addressee = String(cfg.aprs.addressee || 'CKPT').toUpperCase();
  if (!/^[A-Z0-9 ]{1,9}$/.test(addressee))
    fail('aprs.addressee must be 1..9 chars from A-Z 0-9 space');
  cfg.aprs = { destination: dest, destinationSsid: destSsid, digipath, addressee };

  // https
  if (!cfg.https) fail('missing "https"');
  requireType(cfg.https, 'host', 'string', 'https');
  const port = Number(cfg.https.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('https.port must be 1..65535');
  cfg.https.port = port;
  requireType(cfg.https, 'certFile', 'string', 'https');
  requireType(cfg.https, 'keyFile', 'string', 'https');
  cfg.https.certFile = path.resolve(baseDir, cfg.https.certFile);
  cfg.https.keyFile = path.resolve(baseDir, cfg.https.keyFile);
  for (const f of [cfg.https.certFile, cfg.https.keyFile]) {
    if (!fs.existsSync(f)) fail(`cert file not found: ${f}`);
  }

  // static
  if (!cfg.static) fail('missing "static"');
  requireType(cfg.static, 'root', 'string', 'static');
  cfg.static.root = path.resolve(baseDir, cfg.static.root);
  if (!fs.existsSync(path.join(cfg.static.root, 'index.html'))) {
    fail(`static.root (${cfg.static.root}) does not contain index.html`);
  }

  // kiss
  if (!cfg.kiss) fail('missing "kiss"');
  requireType(cfg.kiss, 'host', 'string', 'kiss');
  const kport = Number(cfg.kiss.port);
  if (!Number.isInteger(kport) || kport < 1 || kport > 65535) fail('kiss.port must be 1..65535');
  cfg.kiss.port = kport;
  cfg.kiss.reconnectMs = Math.max(500, Number(cfg.kiss.reconnectMs ?? 3000));

  // log (optional)
  cfg.log = cfg.log && typeof cfg.log === 'object' ? cfg.log : {};
  cfg.log.level = cfg.log.level || 'info';

  return cfg;
}
