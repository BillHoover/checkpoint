# Changelog

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
