# Checkpoint — Project Context

This file gives Claude Code the context it needs to work on this repo effectively. Read it first.

## What this is

**Checkpoint** is an offline-capable Progressive Web App (PWA) for tracking rider arrival and departure times at event checkpoints (rallies, randonneuring, brevets, gravel events, etc.). It is designed to be used at the checkpoint itself — often outdoors, possibly with gloves, possibly with no network.

The app is intentionally a single-page, single-purpose tool. Resist scope creep.

## Target platforms

A single PWA codebase that installs on all of:

- iPhone / iPad (Safari → Add to Home Screen)
- Android (Chrome → Add to Home screen)
- Windows (Chrome/Edge → Install)
- Mac (Chrome/Edge → Install, or Safari 17+ → Add to Dock)

After first load, the app must work **fully offline** including airplane mode. The service worker (`sw.js`) is responsible for this — it is cache-first.

## File layout

```
.
├── index.html         # The whole app: HTML, CSS, and JS in one file. Single source of truth.
├── manifest.json      # PWA manifest. Required for installability.
├── sw.js              # Service worker. Cache-first. Required for offline.
├── icon-192.png       # PWA icon
├── icon-512.png       # PWA icon
├── icon-512-maskable.png   # PWA icon (Android adaptive)
├── apps-script.js     # Google Apps Script source — pasted by the user into Sheets → Extensions → Apps Script. Not loaded by the app itself.
├── README.md          # User-facing docs (install, use, Sheets setup)
├── CHANGELOG.md       # Human-maintained changelog
├── CLAUDE.md          # This file
└── .gitignore
```

`index.html` is intentionally monolithic. Don't split it into separate JS/CSS files unless explicitly asked — keeping it one file makes the PWA cache simpler, makes "double-click the file to test" possible, and matches the single-purpose nature of the app.

## Domain rules and invariants

These are user-confirmed product decisions. Don't change them without asking.

### Columns and layout

- Column order, left to right: **# (rider number) · Arrival · Departure · Name**.
- Column widths: `#` 10%, `Arrival` 19%, `Departure` 19%, `Name` 52%.
- Rider numbers are integers starting at 1 and must be unique within the roster.

### Time format

- All recorded times are **24-hour `HH:MM`** (no seconds).
- The header clock also shows `HH:MM`.
- The keypad input accepts `HH:MM`, `HMM`, or `HHMM` (with or without colon). The parser zero-pads and rejects out-of-range values.
- Pasting an old `HH:MM:SS` value should be silently truncated to `HH:MM` rather than rejected, so that round-tripping data through CSV does not fail.

### Cell interaction model — **this is the most important UX rule**

- **Empty cell** (orange-tinted background, shows "—"):
  - Quick tap → records the current local time (`HH:MM`) immediately, with a visual flash.
  - Long-press (~550ms) → opens the keypad modal to type a time.
- **Filled cell** (green for arrival, blue for departure):
  - Quick tap → **does nothing**. This is intentional. Filled cells must not respond to taps.
  - Long-press → opens the keypad modal to edit or clear the value.

The reason: at a real checkpoint, accidental taps on a filled cell would silently overwrite a recorded time. The asymmetric behavior (tap-to-record on empty, long-press-only on filled) makes overwrites a deliberate two-action gesture. **Do not "fix" this** by allowing tap-to-edit on filled cells.

The "Clear" button lives inside the long-press modal so erasing a wrong entry is also a deliberate two-step action.

### Roster management

- Roster is pre-loaded before the event (numbers + optional names).
- The user explicitly chose **pre-load only** over add-on-the-fly — don't add an "add rider on arrival" feature without confirming.
- Roster can be imported from a CSV with `number,name` per line (header row tolerated).

### Data persistence

- All data is in `localStorage`:
  - `checkpoint.riders.v1` — the roster + recorded times
  - `checkpoint.settings.v1` — Sheet URL, default email recipient
- The data is **per-device, per-browser**. There is no automatic sync across devices.
- The user has been warned about this in the README. Don't add multi-device sync without an explicit request.

### Export options

The Export button opens a modal with these options (in this order):

1. **Save CSV file** — direct download. On Windows this must NOT route through `navigator.share` (the Windows OS share sheet is poor); it should hit the anchor-tag download path directly. Same for Mac desktop.
2. **Email via Gmail** — opens `https://mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...` in a new tab. The CSV is included inline in the body. Optional default recipient comes from settings.
3. **Send to Google Sheet** — POSTs JSON to the user's deployed Apps Script Web App URL (configured in Settings). Apps Script appends a **new dated tab** to the sheet on every sync. Never overwrites.
4. **Share…** — only shown when `/Android|iPhone|iPad|iPod/.test(navigator.userAgent)` AND `navigator.canShare` is available. Hidden on desktop because the Windows share sheet is what motivated the multi-option menu in the first place.

### Apps Script integration

- Lives in `apps-script.js`. It is **not loaded by the app**. It's a source file for the user to copy-paste into their Google Sheet's Apps Script editor.
- Communication is fetch POST with `Content-Type: text/plain;charset=utf-8` (intentionally not `application/json`) to avoid CORS preflight. The Apps Script `doPost` parses the JSON manually.
- The script appends a new sheet tab named with the timestamp. Tab name collisions get `(2)`, `(3)`, etc.
- Test pings have payload `{ test: true }` and get a `{ ok: true, test: true }` response.
- Real syncs respond with `{ ok: true, tab, rows }` or `{ ok: false, error }`.
- The user explicitly chose this over OAuth+Sheets API for simplicity. **Don't migrate to OAuth without an explicit request** — the tradeoffs were already discussed.

## Style and aesthetic

- Dark theme. The app is often used outdoors at dusk/dawn or in low light; bright white backgrounds are hostile.
- Big touch targets. Row height is 52px (60px on `min-width: 768px`). Buttons have `min-height: 36px`.
- Tabular figures (`font-variant-numeric: tabular-nums`) for all times so digits don't dance.
- Color coding:
  - Empty: warm orange (`--empty-tint: #3d2817`)
  - Arrival: green (`--filled: #1e3a2a`, text `#b6f0c9`)
  - Departure: blue (`--depart: #1e2a3a`, text `#b6d4f0`)
  - Accent / "primary action" / clock: amber (`--accent: #f5a623`)
  - Danger: red (`--danger: #c0392b`)
- No frameworks. Vanilla HTML/CSS/JS. Don't add React, Tailwind, build steps, or npm dependencies.
- No external network requests in the app's normal operation. The only outbound calls are user-initiated (Gmail compose, Apps Script POST).

## Browser-specific gotchas to remember

- **iOS Safari** is the strictest target. Test there mentally even if you can only run Chrome.
- `<form>` tags inside the page can trigger unwanted page reloads on iOS — don't add forms; use plain `<input>` + buttons.
- `pinch-zoom` and right-click context menus are suppressed on cells (`gesturestart` preventDefault, `contextmenu` preventDefault) because they interfere with the long-press detection. Don't remove these.
- The viewport meta has `maximum-scale=1.0, user-scalable=no` for the same reason.
- Web Share API (`navigator.share`) exists on Windows Edge/Chrome but routes to the OS share sheet, which is heavily Microsoft-centric and not what users want. Hence the explicit Save / Gmail / Sheets / (mobile-only) Share menu.
- `localStorage` is the storage layer. Don't switch to IndexedDB unless data volume justifies it (it doesn't — a typical event has dozens to a few hundred riders).

## Service worker versioning

When you change cached assets, **bump the cache name** in `sw.js`:

```js
const CACHE = 'checkpoint-v2';   // was 'checkpoint-v1'
```

The activate handler deletes any cache that doesn't match, so bumping the version is what forces clients to pick up new files. Forgetting this is the #1 cause of "I deployed but nothing changed".

If a user reports "I'm still seeing the old version after you updated", the answer is: bump the cache name.

## Adding a new feature — the workflow

1. Discuss the change with the user before coding. This is a tool used in the field; surprises during an event are bad.
2. Implement in `index.html`.
3. If the change affects cached behavior or adds a file, bump `CACHE` in `sw.js` and add the file to the `ASSETS` array.
4. Update `CHANGELOG.md` with a new dated section.
5. Update `README.md` if user-facing behavior changed.
6. Validate JS syntax (Node can do a quick sanity check: `node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\\s\\S]*?)<\\/script>/)[1])"`).
7. If feasible, manually test the long-press interaction — automated testing of the press timing is tricky.
8. Commit with a descriptive message. Conventional Commits style is fine but not required.

## Things explicitly considered and rejected (so you don't suggest them)

- **Native apps for each platform** — rejected as too much overhead for a tool of this scope.
- **OAuth + Google Sheets API** — rejected because the Apps Script approach is simpler and the security model is acceptable for a small-crew tool.
- **Add-rider-on-arrival** — rejected; pre-loaded roster only.
- **IndexedDB / SQLite-WASM** — rejected; localStorage is enough.
- **Multi-device live sync** — not requested; would require a backend.
- **Splitting `index.html` into separate files** — rejected; the monolith is intentional.

## Possible future work (user has expressed interest)

- **Google Chat webhook integration** — similar setup model to Apps Script (paste a webhook URL into Settings, fire-and-forget POST on export).
- More sophisticated time-difference / elapsed-time displays — not yet requested but plausible.
- DNF / scratch markings.

If the user asks for any of these, build them — but until then, keep the surface area small.

## Quick local test

```powershell
# In the repo root
python -m http.server 8000
# Then open http://localhost:8000 in a browser
```

Service worker registration only works over `localhost` or HTTPS, not `file://`, so don't try testing by double-clicking `index.html` if you care about offline behavior.
