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

function validateStation(s) {
  if (!s) fail('missing "station"');
  const sc = String(s.callsign || '').toUpperCase();
  if (!CALLSIGN_RE.test(sc))
    fail(`station.callsign must match ${CALLSIGN_RE} (got ${JSON.stringify(s.callsign)})`);
  const ssid = Number(s.ssid);
  if (!Number.isInteger(ssid) || ssid < 0 || ssid > 15)
    fail('station.ssid must be an integer 0..15');
  return { callsign: sc, ssid };
}

function validateAprs(a) {
  if (!a) fail('missing "aprs"');
  const dest = String(a.destination || '').toUpperCase();
  if (!CALLSIGN_RE.test(dest)) fail(`aprs.destination must match ${CALLSIGN_RE}`);
  const destSsid = Number(a.destinationSsid ?? 0);
  if (!Number.isInteger(destSsid) || destSsid < 0 || destSsid > 15)
    fail('aprs.destinationSsid must be 0..15');
  const digipath = Array.isArray(a.digipath) ? a.digipath.map(String) : [];
  for (const hop of digipath) {
    if (!/^[A-Z0-9]{1,6}(-(1[0-5]|\d))?$/.test(hop))
      fail(`aprs.digipath entry ${JSON.stringify(hop)} is not a valid AX.25 callsign[-ssid]`);
  }
  const addressee = String(a.addressee || 'CKPT').toUpperCase();
  if (!/^[A-Z0-9 ]{1,9}$/.test(addressee))
    fail('aprs.addressee must be 1..9 chars from A-Z 0-9 space');
  return { destination: dest, destinationSsid: destSsid, digipath, addressee };
}

function validateHttps(h, baseDir) {
  if (!h) fail('missing "https"');
  requireType(h, 'host', 'string', 'https');
  const port = Number(h.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('https.port must be 1..65535');
  requireType(h, 'certFile', 'string', 'https');
  requireType(h, 'keyFile', 'string', 'https');
  const certFile = path.resolve(baseDir, h.certFile);
  const keyFile = path.resolve(baseDir, h.keyFile);
  for (const f of [certFile, keyFile]) {
    if (!fs.existsSync(f)) fail(`cert file not found: ${f}`);
  }
  return { ...h, port, certFile, keyFile };
}

function validateStatic(s, baseDir) {
  if (!s) fail('missing "static"');
  requireType(s, 'root', 'string', 'static');
  const root = path.resolve(baseDir, s.root);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    fail(`static.root (${root}) does not contain index.html`);
  }
  return { ...s, root };
}

function validateKiss(k) {
  if (!k) fail('missing "kiss"');
  requireType(k, 'host', 'string', 'kiss');
  const port = Number(k.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('kiss.port must be 1..65535');
  return { ...k, port, reconnectMs: Math.max(500, Number(k.reconnectMs ?? 3000)) };
}

function validate(cfg, baseDir) {
  if (!cfg || typeof cfg !== 'object') fail('top level must be an object');
  cfg.station = validateStation(cfg.station);
  cfg.aprs = validateAprs(cfg.aprs);
  cfg.https = validateHttps(cfg.https, baseDir);
  cfg.static = validateStatic(cfg.static, baseDir);
  cfg.kiss = validateKiss(cfg.kiss);
  cfg.log = cfg.log && typeof cfg.log === 'object' ? cfg.log : {};
  cfg.log.level = cfg.log.level || 'info';
  return cfg;
}
