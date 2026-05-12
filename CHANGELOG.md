# Changelog

## 0.4.1 — 2026-05-12 — SonarCloud sweep

- **Security**: path-traversal hardening on the two static-file servers (`pi/server.mjs`, `tools/serve.mjs`) — `path.resolve` + `path.relative` containment check rather than `startsWith` (closes Sonar S2083 BLOCKER on both).
- **Maintainability**: extracted helpers in `pi/lib/config.mjs` (per-section validators) and `index.html` (`parseEventToken`, `decodeFrame`, `applyInbound`, `composeFrames`, `refreshBridgeUi`, `parseCSVLine`) — same behavior, each function now under Sonar's cognitive-complexity threshold.
- **Modernization sweep across `index.html`**: `parseInt` → `Number.parseInt`, `isNaN` → `Number.isNaN`, `[^0-9]` → `\D`, `parentNode.removeChild` → `Element.remove`, nested ternaries flattened, optional chain in `apps-script.js`.
- **A11y**: standalone `<label>` tags that didn't reference a control are now `<div class="section-label">`, with one regained `for=` on the radio-outbound textarea.
- Service worker cache bumped to `checkpoint-v6`.

## 0.4.0 — 2026-05-10 — Pi radio bridge (Phase 3b groundwork)

- New **`pi/`** subdirectory: a Node service (zero runtime deps) that runs on a per-checkpoint Raspberry Pi (or any Linux/macOS/Windows host) and acts as a radio I/O appliance. It serves the existing PWA over HTTPS from the Pi and shuttles `CKPT/1` frames over RF via Direwolf's KISS-over-TCP interface, so volunteers no longer have to read frames over voice or copy-paste them into a separate radio app.
- Wire wrapper on RF: CKPT/1 frames go out as **APRS messages addressed to `CKPT     `** (9-char addressee). iGate-forwardable, digipeater-relayable, and the 67-char design constraint was already chosen to fit this exact envelope.
- New API surface (same-origin from the PWA when loaded from the Pi):
  - `GET /api/health` — bridge presence + KISS link status + tx/rx counters. PWA feature-detects.
  - `POST /api/tx` — accepts `{ frame }`, wraps as APRS message, sends via KISS.
  - `GET /api/rx` — Server-Sent Events stream of received CKPT/1 frames (echoes of our own transmissions are filtered).
- PWA gains a **Radio Bridge** section in the existing Radio Sync modal when served from a bridge host:
  - Status line (callsign + connection state).
  - *Send via radio* button: pushes the current outbound queue out the radio, then advances `lastSentSeq` like *Mark sent*.
  - *Bridge received N* inbox: collects frames from `/api/rx` between sessions; *Apply all* runs them through the existing inbound applier (deliberate-action UX preserved — no auto-apply).
  - On non-bridge hosts (GitHub Pages, file://, mkcert dev server), `/api/health` 404s, the bridge is silently undetected, and the paste-bridge UX is exactly as before.
- Service worker cache bumped to `checkpoint-v5`.
- See `pi/README.md` for setup: direwolf config, systemd unit, Let's Encrypt DNS-01 cert issuance (the bridge needs real HTTPS — mixed-content rules block an HTTPS PWA from calling an HTTP local API), and notes on hostapd/dnsmasq for the "Pi is the WiFi" topology.

## 0.3.0 — 2026-05-10 — Radio sync (paste-bridge MVP)

- **Radio Sync** panel — new top-level button in the header. Operators paste pending events into their radio software (Winlink, JS8Call, APRS messaging, …) and paste received frames back into the app. Frames are compact ASCII (≤ 67 chars to fit an APRS message), printable, and human-readable on a radio screen.
- Wire format implemented per `RADIO-SYNC.md` v1: `CKPT/1` magic, CRC-16-CCITT, mandatory `D=YYYYMMDD` date headers, kind letters `A` `D` `Z` `Y` (timed) and `R` (roster), `/d±1` per-event day offsets for cross-midnight events, per-event stop overrides.
- **Outbound queue** auto-composes minimal frame set covering events recorded since the last *Mark sent*. **Inbound** textbox accepts pasted frames and applies them — dedupe by `(origin, seq)`, gap-safe via per-origin pending buffer.
- **Roster sync over radio** — *Broadcast Roster* button emits an `R` event per rider; receivers update their local roster on apply.
- **Device-id collision detection** (mandatory per design §6.5). When an inbound event has the same `(origin, seq)` as a local event but different content, the inbound is quarantined into a `collisions` list and a red banner appears in the Radio panel until the operator dismisses it.
- **Save event log (CSV)** — new fifth Export option produces the raw append-only log (`origin, seq, recordedAt, kind, rider, stop, hhmm, name`) for post-event audit or replay into a fresh device.
- Service worker cache bumped to `checkpoint-v4`.

## 0.2.0 — 2026-05-10 — Multi-stop refactor

- One app instance now tracks multiple checkpoints. Configure stops in **Settings → Stops**; pick "My stop" as the one this device records for. Other stops are visible (read-only) via the **Viewing** dropdown that appears in a sub-header strip when more than one stop is configured.
- Cells on stops other than your own are inert — no tap-to-record, no long-press, no keypad. Visually desaturated with a 🔒 read-only indicator. Cells on your own stop behave exactly as before (tap-to-record on empty, long-press-only on filled).
- Internal data model is now an **append-only event log** keyed by `(origin, seq)`. Every record/edit/clear is a new event; the displayed grid is a reduction over the log. This is the foundation the upcoming radio-sync work depends on, and gives a clean audit trail for free.
- Storage migrated from `checkpoint.riders.v1` + `checkpoint.settings.v1` to a single `checkpoint.state.v2` key. Migration is automatic and one-shot on first boot of v0.2; legacy keys are left in place as a one-version backup.
- New Settings → Advanced section exposes a **My device id** (1–99). Most users will never touch this; it identifies events recorded by this device when multiple devices share a log over radio sync.
- CSV filenames and Sheet tab titles now include the currently-selected stop's name (e.g. `checkpoint-Stop2-Mile-30-2026-05-10T10-15-23.csv`). The Apps Script payload also carries the stop's `id` and `name`.
- Service worker cache bumped to `checkpoint-v3` so installed clients pick up the new build.
- See `MULTI-STOP.md` for the design that drove this refactor; `RADIO-SYNC.md` is the companion design for the next phase.

## 0.1.1 — 2026-05-09 — Hardening pass

- Long-press is now robust to minor finger drift (gloved use). Movement past ~10 px cancels; small wobble does not. Removes the previous `pointerleave` cancel that was overzealous on iOS.
- Press state is per-cell instead of global, so concurrent multi-touch on different cells no longer scrambles the timer.
- Tap-to-record flash is now applied after re-render so the orange flash actually plays to completion.
- CSV exports (Save and Send to Sheet) defuse spreadsheet formula injection: cells starting with `=`, `+`, `-`, `@`, tab, or CR are prefixed with an apostrophe.
- Roster CSV import correctly handles quoted fields with embedded commas and `""` escapes (e.g. `"Smith, John"`).
- Service worker only falls back to the app shell for navigation requests; failed asset fetches no longer return HTML with the wrong MIME. Cache bumped to `checkpoint-v2`.
- Send-to-Sheet and the Settings → Test button now time out after 15 s with a clear "timed out" toast instead of hanging the UI.
- Roster Save reports skipped invalid rows in its toast instead of dropping them silently.
- Header clock self-reschedules on minute boundaries instead of ticking once per second.
- Empty input in the time-edit modal now points at the Clear button instead of saying "Invalid time format".
- Apps Script returns a generic error string and logs the underlying cause server-side.
- Export-menu buttons use `<span>` children for valid HTML5.

## 0.1.0 — Initial version

- Offline-capable PWA for tracking rider arrival/departure times at event checkpoints.
- Cross-platform: Android, iPhone, iPad, Windows, Mac (installable to home screen / dock).
- Columns: # (10%), Arrival (19%), Departure (19%), Name (52%).
- Times are 24-hour `HH:MM`. Header clock shows current time.
- **Empty cells** (orange-tinted): single tap records current time; long-press opens keypad.
- **Filled cells**: long-press only — single tap is a no-op so accidental taps cannot overwrite recorded times.
- Roster setup with manual entry or CSV import.
- Data persists in `localStorage`. Per-device, per-browser.
- Export menu:
  - Save CSV file (download)
  - Email via Gmail (web compose URL with optional default recipient)
  - Send to Google Sheet (via Apps Script Web App; appends a new dated tab per sync, never overwrites)
  - Share… (mobile only — system share sheet)
- Settings dialog stores Google Apps Script Web App URL and default email recipient.
- `apps-script.js` provided for one-time Sheets integration setup.
