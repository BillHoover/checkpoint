# Checkpoint — Rider Tracker PWA

Offline-capable rider arrival/departure tracker. Single codebase, runs on Android, iPhone, iPad, Windows, and Mac.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app itself (UI + logic, all-in-one) |
| `manifest.json` | Makes the app installable |
| `sw.js` | Service worker — enables full offline use after first load |
| `icon-192.png` / `icon-512.png` / `icon-512-maskable.png` | App icons |
| `apps-script.js` | **Optional** — paste into Google Apps Script to enable Sheets sync |

The first 5 files must be served from the **same folder** over HTTPS. The Apps Script file is separate — you only need it if you want the Google Sheets sync feature.

## How to host the app

PWAs require HTTPS (or `localhost`):

- **GitHub Pages** — drop the files into a repo, enable Pages, done.
- **Netlify Drop** — drag the folder onto https://app.netlify.com/drop.
- **Cloudflare Pages**, **Vercel**, etc. — same idea.
- **Local testing** — `python3 -m http.server 8000` from the folder, visit `http://localhost:8000` from the same machine.

## Installing on each platform

After loading the page once, it runs **fully offline** — even airplane mode.

### iPhone / iPad (Safari)
1. Open in **Safari** (not Chrome).
2. Share button → **Add to Home Screen** → **Add**.
3. Launch from the home-screen icon.

### Android (Chrome)
1. Open in Chrome.
2. **⋮** menu → **Add to Home screen** (Chrome may prompt automatically).

### Windows / Mac (Chrome or Edge)
1. Open the URL.
2. Install icon in the address bar, or menu → **Install Checkpoint…** (Chrome) / **Apps → Install this site as an app** (Edge).
3. The app gets its own window and shows in your Start menu / Applications.

### Mac (Safari 17+)
1. **File → Add to Dock**.

## Using the app

- **Roster** — pre-load rider numbers + names. Can also import CSV (`number,name` per line).
- **Tap an empty (orange-tinted) cell** → records current time instantly.
- **Long-press a cell** (~½ second) → keypad to type/edit/clear. Filled cells can only be edited via long-press (no accidental tap-to-overwrite).
- Times are 24-hour local, `HH:MM`.
- All data persists in the browser's storage automatically.

## Exporting

The **Export** button opens a menu with these options:

- **💾 Save CSV file** — downloads to the device.
- **✉️ Email via Gmail** — opens a Gmail compose window with the CSV in the body and (optionally) a default recipient pre-filled. Works on any platform.
- **📊 Send to Google Sheet** — appends a new dated tab to a Google Sheet you've configured. Requires one-time setup (below).
- **📤 Share…** — system share sheet (mobile only).

## Google Sheets sync setup (optional, ~2 minutes one-time)

1. Open the Google Sheet you want as the destination.
2. **Extensions → Apps Script**.
3. Delete any boilerplate. Paste the contents of `apps-script.js` from this bundle. Save.
4. **Deploy → New deployment**.
5. Click the gear next to "Select type" → choose **Web app**.
6. Settings:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy**, authorize when prompted.
8. Copy the **Web app URL** Google gives you.
9. In the Checkpoint app: **Export → Settings** → paste the URL → **Save**.
10. Tap **Test Sheet URL** to confirm the connection works.

Each "Send to Google Sheet" tap appends a **new tab** named with the timestamp — nothing in your sheet is overwritten or deleted. You can sync multiple times during an event for incremental backups.

**Privacy:** Anyone with the URL can append tabs, so don't post it publicly. To rotate it, create a new deployment in Apps Script and update the URL in the app.

## Time-entry formats

The keypad accepts: `14:35`, `1435`, `935`, `9:5` (zero-padded automatically). Anything invalid is rejected with a toast.

## Data storage

- Saved in `localStorage` under `checkpoint.riders.v1` and `checkpoint.settings.v1`.
- **Per-device, per-browser.** Clearing browser data or uninstalling the PWA loses local data — **export first.**
- Nothing is sent to any server unless you explicitly use Email or Sheets sync.
