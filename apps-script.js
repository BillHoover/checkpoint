/**
 * Checkpoint sync — Apps Script for Google Sheets
 * ------------------------------------------------
 * Receives JSON from the Checkpoint PWA and appends the data as a new tab
 * (named with the send timestamp) to this spreadsheet. Original tabs are
 * never modified — every sync is a fresh, dated tab.
 *
 * SETUP:
 *   1. Open the Google Sheet you want to use as the destination.
 *   2. Extensions → Apps Script. Delete any boilerplate code.
 *   3. Paste this entire file. Save (disk icon).
 *   4. Click  Deploy → New deployment.
 *   5. Click the gear icon next to "Select type" → choose "Web app".
 *   6. Description: "Checkpoint sync" (or anything).
 *      Execute as: Me  (your Google account)
 *      Who has access: Anyone
 *   7. Click Deploy. Authorize access when Google asks.
 *   8. Copy the "Web app URL" Google shows you.
 *   9. In the Checkpoint app: Export → Settings → paste the URL → Save.
 *
 * PRIVACY:
 *   Anyone with the URL can append tabs to your sheet, so don't post it
 *   publicly. Treat it like a write-only password. To rotate it, just
 *   create a new deployment and update the URL in the app.
 *
 * UPDATING:
 *   If you change this script, you must Deploy → Manage deployments →
 *   pencil icon → Version: New version → Deploy. The URL stays the same.
 */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // Test pings from the Settings dialog
    if (body && body.test === true) {
      return jsonResponse({ ok: true, test: true });
    }

    if (!body || !Array.isArray(body.riders)) {
      return jsonResponse({ ok: false, error: 'Missing riders array' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // Tab name from sentAt timestamp (or now), safe for sheet names
    const sentAt = body.sentAt ? new Date(body.sentAt) : new Date();
    const tabName = formatTabName(sentAt);
    const sheet = ss.insertSheet(uniqueTabName(ss, tabName));

    // Header
    sheet.getRange(1, 1, 1, 4).setValues([['Number', 'Name', 'Arrival', 'Departure']]);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setFrozenRows(1);

    // Data
    const rows = body.riders.map(r => [
      Number(r.num) || '',
      sanitizeForSheet(String(r.name || '')),
      sanitizeForSheet(String(r.arrival || '')),
      sanitizeForSheet(String(r.departure || ''))
    ]);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 4).setValues(rows);
    }

    // Footer with metadata
    const metaRow = rows.length + 3;
    sheet.getRange(metaRow, 1).setValue('Synced:');
    sheet.getRange(metaRow, 2).setValue(sentAt);
    sheet.getRange(metaRow + 1, 1).setValue('Device:');
    sheet.getRange(metaRow + 1, 2).setValue(String(body.device || ''));

    // Auto-size columns
    sheet.autoResizeColumns(1, 4);

    return jsonResponse({ ok: true, tab: sheet.getName(), rows: rows.length });
  } catch (err) {
    // Log details server-side; return a non-leaky message to the client.
    console.error(err);
    return jsonResponse({ ok: false, error: 'Server error processing request' });
  }
}

// Prevent CSV-injection: spreadsheets evaluate cells starting with these as formulas.
function sanitizeForSheet(s) {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function doGet() {
  // Friendly response if someone opens the URL in a browser
  return ContentService.createTextOutput(
    'Checkpoint sync endpoint is live. POST JSON to record a sync.'
  ).setMimeType(ContentService.MimeType.TEXT);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatTabName(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
         ' ' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
}

function uniqueTabName(ss, base) {
  let name = base;
  let i = 2;
  while (ss.getSheetByName(name)) {
    name = base + ' (' + i + ')';
    i++;
  }
  return name;
}
