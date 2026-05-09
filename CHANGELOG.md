# Changelog

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
