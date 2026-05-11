# Checkpoint Pi bridge

A per-checkpoint radio I/O appliance for the [Checkpoint PWA](../). The bridge:

- Serves the existing PWA over **HTTPS** from the Pi, so EUDs (phones/tablets/laptops) at the checkpoint connect to the Pi and use the app as they would from anywhere.
- Exposes a small REST/SSE API (`/api/health`, `/api/tx`, `/api/rx`) the PWA feature-detects.
- Talks to **Direwolf** over its KISS-over-TCP interface to actually transmit/receive AX.25 UI frames carrying `CKPT/1` payloads as APRS messages.

The bridge owns no rider state. The PWA on each EUD remains the source of truth; the bridge is a stateless radio I/O appliance. If the bridge dies mid-event, EUDs keep working with localStorage and the paste-bridge fallback.

## Why HTTPS (and not plain HTTP)

The PWA, when served from GitHub Pages, is on an HTTPS origin. Browsers block HTTPS pages from calling HTTP APIs (mixed content) — no CORS escape, no `no-cors` workaround. So the bridge must serve HTTPS. We use real Let's Encrypt certs via the DNS-01 challenge (see [Certs](#certs)) so EUDs need zero per-device trust setup.

---

## Prerequisites

- A host running Linux, macOS, or Windows. A Raspberry Pi 4 (or 5, or Zero 2 W) running Raspberry Pi OS is the canonical target; a Linux laptop works equally well.
- **Node.js 20+**.
- A radio + audio-interface combo Direwolf can drive: USB sound card with a 3.5 mm cable to the radio's accessory port, a [DigiRig](https://digirig.net/), a [Mobilinkd USB TNC](https://store.mobilinkd.com/), etc.
- **Direwolf 1.7+** installed and configured (see below).
- A domain you control (e.g. `deadmoose.com`) and the ability to add DNS TXT records for ACME DNS-01 challenges.

## Layout

```
pi/
├── README.md              # this file
├── package.json           # zero runtime deps; entry: server.mjs
├── server.mjs             # HTTPS + static + /api/* + KISS orchestration
├── config.example.json    # copy to config.json and edit
├── lib/
│   ├── config.mjs         # loader + validator
│   ├── ax25.mjs           # AX.25 UI frame encode/decode (uses no deps)
│   ├── kiss.mjs           # KISS-over-TCP client (TCP socket + framing)
│   └── aprs.mjs           # CKPT/1 ↔ APRS message wrap/unwrap
└── setup/
    ├── direwolf.conf.example
    └── checkpoint-bridge.service     # systemd unit
```

`config.json` and `certs/` are gitignored.

---

## Step 1 — install Direwolf and enable KISS-over-TCP

Most Linux distros ship Direwolf 1.7 or newer in their package repo:

```sh
sudo apt install direwolf            # Raspberry Pi OS / Debian / Ubuntu
sudo dnf install direwolf            # RHEL / Fedora
brew install direwolf                # macOS
```

(For Windows, a `direwolf.exe` build is already vendored under `../tools/direwolf/` for dev / cross-check work — see the project root.)

Edit `~/.direwolf.conf` (or wherever your distro puts it; sample at `setup/direwolf.conf.example`). Key lines:

```text
ACHANNELS 1
CHANNEL 0
MYCALL AJ6UU-1                       # your station callsign + ssid for this checkpoint
MODEM 1200
PTT GPIO 23                          # or RIG ..., or none if you key via VOX
KISSPORT 8001                        # the bridge talks to direwolf here
```

Test direwolf is working on its own first (it should listen on `tcp/8001`, the AGW port is `tcp/8000` — we don't use that):

```sh
direwolf -t 0
# in another shell:
ss -lnt | grep 8001
```

## Step 2 — get TLS certs (Let's Encrypt via DNS-01)

We want a real cert so browsers don't nag and EUDs don't have to install a custom CA. Use the **DNS-01 challenge** — the bridge does *not* need to be reachable from the internet for the ACME flow.

Pick a hostname under a domain you control, e.g. `cp.deadmoose.com`. Point that hostname's A record to the LAN address the Pi will hand out (e.g. `192.168.4.1` if the Pi is the AP, or whatever address it has on the venue's WiFi). Public DNS resolving to a private IP is fine — TLS only checks that the hostname *in the cert* matches the hostname *in the URL bar*. Where DNS resolves to is irrelevant.

For hands-off renewals you need an ACME client that can write TXT records via a DNS provider's API. **Network Solutions, GoDaddy, IONOS, and most low-end registrars do *not* expose a usable API**, so if your domain lives there you have two clean paths:

### Path A — move DNS hosting to Cloudflare (recommended)

Keeps the domain *registered* wherever it is (Network Solutions, etc.); only the DNS *hosting* moves. Free, 5-minute setup, then fully unattended renewals forever.

1. At Cloudflare, add `deadmoose.com` as a Free zone. Copy the two nameservers Cloudflare gives you.
2. At your registrar (Network Solutions in this repo's case): Account → Manage → Change Where Domain Points → Custom DNS Servers → paste the Cloudflare NS names → save. Propagation is usually 15-60 min.
3. At Cloudflare, recreate any DNS records you care about (the A record for `cp.deadmoose.com` pointing to the Pi's LAN IP, etc.).
4. At Cloudflare → My Profile → API Tokens → Create Token, use the "Edit zone DNS" template, scope to `deadmoose.com`.
5. On the Pi:

```sh
sudo apt install certbot python3-certbot-dns-cloudflare
sudo mkdir -p /etc/letsencrypt/secrets
sudo bash -c 'cat > /etc/letsencrypt/secrets/cloudflare.ini <<EOF
dns_cloudflare_api_token = PASTE_TOKEN_HERE
EOF'
sudo chmod 600 /etc/letsencrypt/secrets/cloudflare.ini

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/secrets/cloudflare.ini \
  -d cp.deadmoose.com
```

`certbot renew` from cron handles the 90-day rollover untouched.

### Path B — keep DNS at Network Solutions, use acme.sh DNS alias mode

For when you'd rather not move nameservers. Touches Network Solutions exactly once (to set a single CNAME that never changes again), then all future TXT writes happen at an API-capable DNS provider for a *different* domain you set up just for ACME aliasing.

1. Sign up at [deSEC.io](https://desec.io/) — free, API-driven, designed exactly for this. Create a domain like `aliases.deadmoose.org` (any zone you control will do; deSEC gives you `.dedyn.io` subdomains for free if you prefer). Get an API token.
2. At Network Solutions, create **one CNAME** in the `deadmoose.com` zone:
   ```
   _acme-challenge.cp.deadmoose.com  CNAME  cp.aliases.deadmoose.org
   ```
   That CNAME never changes for the lifetime of the setup.
3. On the Pi:

```sh
curl https://get.acme.sh | sh -s email=you@example.com
export DEDYN_TOKEN="..."         # deSEC token (env var name depends on provider plugin)
~/.acme.sh/acme.sh --issue \
  -d cp.deadmoose.com \
  --challenge-alias aliases.deadmoose.org \
  --dns dns_desec
```

acme.sh writes the per-challenge TXT to `_acme-challenge.cp.aliases.deadmoose.org` via the deSEC API, LE follows the CNAME from Network Solutions, validates against the alias zone, issues the cert. Renewals work the same way with no further DNS edits anywhere.

acme.sh installs its own cron entry for renewal.

### Path C — manual paste (no automation, fine for one Pi)

If you're running one Pi for one event and don't mind a calendar reminder:

```sh
sudo certbot certonly --manual --preferred-challenges dns -d cp.deadmoose.com
# certbot prints a TXT value; paste into Network Solutions' Advanced DNS panel,
# wait ~5 min, hit Enter. Repeat every 60-90 days.
```

### Note on "DNS persist mode"

[`acme.sh`'s DNS persist mode](https://github.com/acmesh-official/acme.sh/wiki/DNS-persist-mode) (one TXT record, set once, used forever — no per-issuance edits) implements `draft-ietf-acme-dns-persist-01`. The draft is **not yet implemented by any production CA** (Let's Encrypt, ZeroSSL, Buypass, etc.). It'll be the obvious answer when CAs adopt it, but isn't usable today.

### Install the cert files

However you got the cert, copy or symlink the issued files into `pi/certs/`:

```sh
mkdir -p pi/certs
sudo ln -s /etc/letsencrypt/live/cp.deadmoose.com/fullchain.pem pi/certs/fullchain.pem
sudo ln -s /etc/letsencrypt/live/cp.deadmoose.com/privkey.pem pi/certs/privkey.pem
```

(For acme.sh, the issued files live under `~/.acme.sh/cp.deadmoose.com_ecc/` or similar; symlink from there.)

Renewal: LE certs are 90 days. `certbot renew` (Path A/C) or acme.sh's cron (Path B) handles it automatically. Restart the bridge after renewal so it re-reads the cert files (`systemctl reload checkpoint-bridge` if you've set up the unit per Step 4, or use a post-renew hook).

## Step 3 — configure the bridge

```sh
cd pi
cp config.example.json config.json
# edit config.json — at minimum set station.callsign, station.ssid, and the
# https.host to "0.0.0.0" (or a specific interface), and verify the static.root
# path points at the directory containing index.html.
node -e "import('./lib/config.mjs').then(m=>console.log('config ok')).catch(e=>{console.error(e.message);process.exit(1)})"
node server.mjs
```

Expected output:

```
2026-05-10T... [bridge] starting as AJ6UU-1
2026-05-10T... [bridge] static root: /home/pi/checkpoint
2026-05-10T... [bridge] HTTPS on 0.0.0.0:443
2026-05-10T... [bridge] KISS to 127.0.0.1:8001
2026-05-10T... [bridge] listening on https://0.0.0.0:443/
2026-05-10T... [kiss] connecting to 127.0.0.1:8001
2026-05-10T... [kiss] connected
```

Browse to `https://cp.deadmoose.com/` from an EUD on the same network. The PWA loads. Open the Radio Sync modal — a new bridge-status row appears at the top of the modal showing `AJ6UU-1 · bridge online · radio link up`. Record an arrival on a rider; click **Send via radio**. Direwolf's console should show the TX.

## Step 4 — run as a systemd service

```sh
sudo cp setup/checkpoint-bridge.service /etc/systemd/system/
# Edit the unit file to point at your actual repo path and user.
sudo systemctl daemon-reload
sudo systemctl enable --now checkpoint-bridge
journalctl -u checkpoint-bridge -f
```

Port 443 requires root or a `setcap` grant. The bundled unit uses `AmbientCapabilities=CAP_NET_BIND_SERVICE` so the service can bind 443 while running as a normal user.

---

## Optional — Pi as the WiFi access point

If the venue has no usable WiFi and you want EUDs to associate directly to the Pi:

- `hostapd` to run the radio interface as an AP (e.g. SSID `Checkpoint-1`).
- `dnsmasq` to hand out DHCP leases on a small subnet, and serve DNS that answers `cp.deadmoose.com` → the Pi's local IP. Even though that hostname's public A record points at the same private IP, having dnsmasq answer locally means EUDs don't need internet to resolve.

Example dnsmasq snippet:

```text
interface=wlan0
dhcp-range=192.168.4.10,192.168.4.100,12h
address=/cp.deadmoose.com/192.168.4.1
```

Example hostapd is well-documented in standard Raspberry Pi guides; specifics depend on the WiFi chip. The bridge itself doesn't care how EUDs reach it — only that the hostname matches the cert.

**iOS gotcha:** Safari sometimes prefers a cached / carrier DNS resolver over the DHCP-provided one. If the cert error appears on iOS but the same URL works elsewhere, have the volunteer toggle airplane mode on then off after joining the WiFi. Cleaner: keep the EUD on cellular, off the local AP — public DNS for `cp.deadmoose.com` already resolves to the local IP, so any DNS source works.

---

## API surface

| Endpoint | Method | Use |
|---|---|---|
| `/api/health` | GET | JSON `{ ok, bridge, station, kissConnected, kissError, counters }`. PWA polls this to feature-detect and to update the radio-link indicator. |
| `/api/tx` | POST | Body: `{ frame: "CKPT/1 …" }`. Wraps as an APRS message addressed to `CKPT     ` and sends via KISS. Returns `{ ok, sentAt }` on success or `{ ok: false, error }`. Rejects frames > 67 chars or without the `CKPT/` magic. |
| `/api/rx` | GET (SSE) | Server-Sent Events stream. Each event is a JSON object `{ frame, src, receivedAt }`. Echoes of our own transmissions (source matches our configured callsign+ssid) are filtered. |
| `/` and `/*` | GET | Static files from `config.static.root`. `index.html`, `manifest.json`, `sw.js`, icons. |

## What's on the air

CKPT/1 frames are wrapped in standard APRS messages so they ride existing infrastructure (digipeaters, iGates) transparently:

```
:CKPT     :CKPT/1 O=5 S=2 D=20260509 N=47-48 12A1423 17A1425 *A3F2
```

- AX.25 source: your station callsign + SSID (e.g. `AJ6UU-1`).
- AX.25 destination: `APCKPT` (APRS tocall for Checkpoint — distinctive, not in the official tocall registry, unlikely to clash).
- Digipath: whatever you configure (default `WIDE1-1,WIDE2-1`).
- APRS addressee: `CKPT     ` (9 chars, padded). No station is named CKPT, so other APRS receivers ignore it; iGates still forward it to APRS-IS as an addressed message.
- No `{msgno` suffix — we don't request ACKs, the gossip protocol handles dedup itself.

## Troubleshooting

**`config: missing "station"`** — copy `config.example.json` to `config.json` and edit it.

**`config: cert file not found`** — paths in `https.certFile` / `https.keyFile` are resolved relative to the directory containing `config.json`. Either set absolute paths or place certs under `pi/certs/`.

**Bridge status shows "radio link DOWN"** — KISS socket can't reach Direwolf. Check direwolf is running and `KISSPORT 8001` is in its config; check no firewall blocks `127.0.0.1:8001`.

**iOS shows a cert warning** — most likely the hostname being requested doesn't match the cert. Verify `cp.deadmoose.com` resolves to the Pi's IP from the EUD (`nslookup cp.deadmoose.com` via the EUD's DNS).

**"Frame exceeds 67-char APRS limit"** in the bridge log — the PWA composer should never produce a >67-char frame; check the radio-sync codec hasn't been modified.

**TX is sending but nothing is received** — verify two-way RF (direwolf can decode test patterns from `atest` against a known-good recording). The bridge filters received frames to only those addressed to `CKPT     ` — check direwolf's monitor for inbound APRS messages with that exact addressee.
