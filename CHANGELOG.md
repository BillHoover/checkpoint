# Changelog

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
