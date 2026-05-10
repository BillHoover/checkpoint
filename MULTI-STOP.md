# Checkpoint Multi-Stop Refactor — Design

**Status:** Proposal · not implemented
**Audience:** Future implementers, the user, and Claude Code in later sessions
**Companion to:** [`RADIO-SYNC.md`](./RADIO-SYNC.md) — radio sync depends on this refactor; this refactor stands on its own and provides standalone value even if radio sync is never built.

---

## 1. What we're solving

Today Checkpoint is a single-stop tool: one device, one roster, one column of arrivals and one column of departures. At a real event with multiple checkpoints, that means N independent app installs each with their own siloed data, and no way for an operator at Stop 2 to glance at who's already through Stop 1.

This refactor makes Checkpoint **multi-stop aware**:

- One app instance knows about every stop on the course.
- Each operator picks **their** stop in Settings. They record times for that stop.
- Any stop's times can be **viewed** on any device. Read-only, but visible.
- The internal data model becomes an **append-only event log**, which is the foundation the radio sync work in `RADIO-SYNC.md` needs and which is also valuable on its own (clean audit trail, undo-friendly, post-event analysis).

This work is intentionally scoped to "the data and UX changes a single device needs to display multiple stops correctly" — there is **no sync** in this phase. Sync is `RADIO-SYNC.md`'s job and lives entirely on top of the event log this phase establishes.

## 2. Goals and non-goals

**Goals**

- A single device can hold rosters and times for multiple stops, switch between them, and edit its own stop.
- The cell-interaction model from CLAUDE.md (tap-to-record on empty, long-press-only on filled, no tap-to-edit on filled) is **preserved unchanged** for the operator's own stop.
- Other stops are visually distinct and inert — no taps, no long-press menu, no accidental edits.
- The event log shape matches what `RADIO-SYNC.md` Phase 1 expects, so the next phase doesn't have to re-shape data.
- Migration from `checkpoint.riders.v1` to `checkpoint.state.v2` is automatic, lossless, and one-shot at first load.

**Non-goals (this phase)**

- Inter-device sync of any kind. No frames, no CRC, no Radio panel. All of that is Phase 1.
- A "cross-stop dashboard" that shows every rider's progress across every stop on one screen. Useful, but separate UX work.
- Stop-list synchronization between devices. Operators coordinate stop IDs/names manually during pre-event briefing in Phase 0; programmatic stop sync can come later.
- Time-zone handling. All operators are in the same local time zone for the duration of an event.
- Importing stops from a CSV. Stops are entered by the operator in Settings. The typical event has 2–10 stops; a CSV importer is overkill.

## 3. Data model

### 3.1 New storage shape

The single new key is `checkpoint.state.v2`. Old `checkpoint.riders.v1` and `checkpoint.settings.v1` are read once at migration and then left in place as a one-version backup (deletion deferred to a later release).

```js
// localStorage: checkpoint.state.v2
{
  version: 2,
  myDevice: 5,            // 1..99. Identity of this physical device. Defaults to a random
                          // value 1..99 on first run; user-editable in Settings (advanced).
                          // Used as `origin` on every event this device creates.
  myStop: 2,              // 1..99. The stop this device is currently recording for.
                          // User-editable in Settings; can change mid-event if an operator
                          // moves between stops.
  stops: [
    { id: 1, name: "Start" },
    { id: 2, name: "Mile 30 — Bridge" },
    { id: 3, name: "Mile 65 — Diner" }
  ],
  riders: [
    { number: 12, name: "A. Smith" },
    { number: 17, name: "B. Jones" }
  ],
  events: [
    // Append-only. Immutable once written. Ordering is by (origin, seq).
    { origin: 5, seq: 1, rider: 12, stop: 2, kind: "A", hhmm: "1423", recordedAt: 1746822180000 },
    { origin: 5, seq: 2, rider: 17, stop: 2, kind: "A", hhmm: "1425", recordedAt: 1746822300000 }
  ],
  settings: {
    sheetUrl: "...",
    defaultEmail: "..."
  }
}
```

`vector` and `pending` fields from the radio-sync state shape are **not introduced in Phase 0**. They land in Phase 1 alongside the inbound-frame parser. Phase 0 ships only with `events` and the implicit "next seq for my origin = max(seq | origin == myDevice) + 1" rule.

### 3.2 Event log semantics

Every state change that today writes to a rider's `arrival` or `departure` field becomes an **append** to `events`:

| Action | Event written |
|---|---|
| Tap empty Arrival cell on my stop | `{ origin: myDevice, seq: ++, rider, stop: myStop, kind: "A", hhmm: <now>, recordedAt: Date.now() }` |
| Tap empty Departure cell on my stop | same with `kind: "D"` |
| Long-press → keypad → save value (Arrival) | `kind: "A"` with the typed `hhmm` |
| Long-press → keypad → save value (Departure) | `kind: "D"` with the typed `hhmm` |
| Long-press → keypad → Clear (Arrival) | `kind: "Z"` (clears arrival) with `hhmm = <now>` |
| Long-press → keypad → Clear (Departure) | `kind: "Y"` (clears departure) with `hhmm = <now>` |

Cells are **never** mutated in place. The displayed value of a cell is the result of a **reduction** over `events` filtered by `(rider, stop)`:

- Walk events in `(origin, seq)` order.
- `A hhmm` → arrival = `hhmm`
- `D hhmm` → departure = `hhmm`
- `Z hhmm` → arrival = `null`
- `Y hhmm` → departure = `null`

The final `(arrival, departure)` pair is what the cell shows. Edits "win" in seq order: if you typed 14:23 then later corrected to 14:20, both events stay in the log; the reduction shows 14:20.

For Phase 0, every event has `origin === myDevice` (no other devices write to this log yet). This means seq order ≡ insertion order ≡ recording order, and the reduction is trivial. Phase 1 generalizes the reduction to multi-origin without changing this structure.

### 3.3 Why an event log

Three reasons, in order of how much they matter for this phase:

1. **It's the right shape for what's coming.** The radio sync layer in `RADIO-SYNC.md` is fundamentally an event-log gossip protocol. Building the multi-stop refactor on a mutating-fields model and then re-shaping it for sync would be two refactors instead of one.
2. **Audit trail comes for free.** Every correction and clear is recoverable. The Phase 1 "Save event log (CSV)" export is one `events.map(...)` away.
3. **Undo becomes implementable.** Not building it in Phase 0, but the door is open: an undo command would emit a compensating event. Forward-only, no time travel.

The cost is small. The reduction over events is O(events) per render; for a typical event of ~200 riders × 4 stops × 2 columns × 1 correction average ≈ 1600 events, the reduction takes microseconds.

## 4. UI changes

### 4.1 Stop switcher in the header

The header today shows the live clock (amber) and the app title. Add a **stop selector** to the right of the clock:

```
┌────────────────────────────────────────────────────┐
│  Checkpoint    14:32    Stop: 2 — Mile 30 ▼        │
└────────────────────────────────────────────────────┘
```

Tapping the dropdown opens a list of all stops. Selecting one switches the times grid below to that stop's view. The dropdown also has a small badge marking which stop is "mine":

```
┌─ Switch stop ────────────────────────┐
│  1 — Start                           │
│  2 — Mile 30 — Bridge      ★ (mine)  │  ← currently viewing
│  3 — Mile 65 — Diner                 │
└──────────────────────────────────────┘
```

If only one stop is configured, the switcher collapses to a static label (no dropdown affordance) — single-stop users see no UI change beyond the label appearing in the header.

### 4.2 Times grid — interaction rules per stop

The grid layout (columns: `# · Arrival · Departure · Name`, the widths from CLAUDE.md) does not change. What changes is **interaction**:

- **Viewing my stop** — full interaction. Cell colors, tap-to-record on empty, long-press-only on filled. Identical to today. **The CLAUDE.md rule about no-tap-to-edit on filled cells is preserved verbatim.**
- **Viewing another stop** — read-only. Cells show the same colors (orange empty / green arrival / blue departure) so the visual model is consistent, but with a slight desaturation to signal "not yours." **Tap and long-press both do nothing** on these cells. No keypad opens, no flash, no toast. Silent inertness is unambiguous and matches the existing "filled cells don't respond to tap" pattern.

Why no helpful "this is read-only, switch stops to edit" toast: at a real checkpoint, an accidental long-press on a peer's stop should be invisible, not interrupt the operator with a modal. If they meant to edit, they'll switch stops first.

A subtle visual cue makes the read-only state obvious: a small lock glyph in the header bar of the grid when viewing another stop:

```
┌─────────────────────────────────────────────────────┐
│  #   Arrival   Departure   Name        🔒 read-only │
└─────────────────────────────────────────────────────┘
```

### 4.3 Settings

Three new settings, plus the existing two (Sheet URL, default email):

- **My stop** — dropdown of `stops`. Defaults to the first stop. Changing it mid-event is allowed; previously recorded events stay attached to whichever stop they were recorded for (the event has its own `stop` field, frozen at write time).
- **Stops** — editable list. Add/rename/remove. Each stop has a numeric id and a display name. New stops get the lowest unused id by default. Removing a stop that has events attached is allowed but warns ("This stop has 47 recorded times. Remove anyway? The times will remain in the log but will be hidden until the stop is re-added with the same id.").
- **My device id** — 1..99, editable in an Advanced section. Defaults to a random value on first run. Most users never touch this; it matters only when multiple devices write to the same shared event log (i.e., once radio sync is in use).

The CSV roster import dialog stays exactly as it is. No new fields, no stop column on the rider — riders are the same set across all stops.

### 4.4 Keypad modal

No structural change. Same entry rules (`HH:MM`, `HMM`, `HHMM`), same Clear button, same dark-theme styling.

What changes is the **action on save/clear**: instead of mutating `riders[i].arrival` directly, the modal emits an `A`/`D`/`Z`/`Y` event into the log, and the grid re-renders from the reduced log.

The keypad **does not open** when long-pressing a cell on another stop. The long-press handler short-circuits when `cell.stopId !== state.myStop`.

## 5. Migration v1 → v2

Run once at app boot, before any rendering:

```js
function migrateV1toV2() {
  const v2 = localStorage.getItem('checkpoint.state.v2');
  if (v2) return JSON.parse(v2);          // already migrated

  const v1ridersRaw = localStorage.getItem('checkpoint.riders.v1');
  const v1settingsRaw = localStorage.getItem('checkpoint.settings.v1');

  const v1riders = v1ridersRaw ? JSON.parse(v1ridersRaw) : [];
  const v1settings = v1settingsRaw ? JSON.parse(v1settingsRaw) : {};

  const myDevice = randomInt(1, 99);
  const stops = [{ id: 1, name: 'Checkpoint' }];   // v1 had one implicit stop
  const riders = v1riders.map(r => ({ number: r.number, name: r.name || '' }));

  const events = [];
  let seq = 1;
  const now = Date.now();
  for (const r of v1riders) {
    if (r.arrival) {
      events.push({ origin: myDevice, seq: seq++, rider: r.number, stop: 1, kind: 'A',
                    hhmm: normalizeHHMM(r.arrival), recordedAt: now });
    }
    if (r.departure) {
      events.push({ origin: myDevice, seq: seq++, rider: r.number, stop: 1, kind: 'D',
                    hhmm: normalizeHHMM(r.departure), recordedAt: now });
    }
  }

  const state = {
    version: 2,
    myDevice,
    myStop: 1,
    stops,
    riders,
    events,
    settings: { sheetUrl: v1settings.sheetUrl || '', defaultEmail: v1settings.defaultEmail || '' }
  };
  localStorage.setItem('checkpoint.state.v2', JSON.stringify(state));
  // v1 keys left in place as a one-version backup; deleted in a later release.
  return state;
}
```

`normalizeHHMM` truncates `HH:MM:SS` → `HH:MM` and zero-pads `HMM` → `HHMM`, matching the existing parser's tolerances (per CLAUDE.md, "pasting an old `HH:MM:SS` value should be silently truncated rather than rejected").

After migration, the displayed times grid for the (single) implicit stop shows exactly what the v1 app showed. If a user opens the v2 app, doesn't add stops, and doesn't change anything, behavior is indistinguishable from v1 — except the underlying storage is now event-log shaped.

### 5.1 Migration corner cases

| Situation | Behavior |
|---|---|
| No v1 keys present (fresh install) | State initialized to defaults: random `myDevice`, `myStop=1`, one stop named "Checkpoint", empty roster, empty events. |
| v1 keys present but `riders` is empty/null | Migration produces a state with empty `riders` and `events`. The single default stop is still created. |
| v1 keys present with malformed JSON | Treat as fresh install. Don't crash. (Optional: copy the malformed value to a `checkpoint.broken.v1` key for diagnosis.) |
| v2 key present alongside v1 keys | Use v2; ignore v1. (Migration was already done; don't redo.) |
| User clears site data and re-imports a v1 backup CSV | The CSV import path is rider-only. Times don't come back from CSV. This is consistent with v1 behavior and acceptable. |

## 6. Export changes

Phase 0 keeps export deliberately minimal. The four export options from CLAUDE.md (Save CSV, Gmail, Google Sheet, Share) all continue to operate **on the currently selected stop**:

- The CSV file produced by Save and the body included in Gmail are unchanged in schema (`number,name,arrival,departure`), but the filename and Gmail subject get the stop name prepended: `checkpoint-Stop2-Mile30-2026-05-09.csv`.
- The Apps Script payload's `tab` name (which becomes the Sheet tab title) gets the stop name appended too: `2026-05-09T14:30 — Stop 2 — Mile 30`.
- Share works the same as today, on the currently selected stop.

A comprehensive "all stops in one CSV" export and the raw event-log CSV are both deferred to Phase 1, where they pair naturally with the radio-sync changes.

## 7. Service worker

Per CLAUDE.md, when cached assets change, bump `CACHE` in `sw.js`:

```js
const CACHE = 'checkpoint-v2';   // was 'checkpoint-v1'
```

`ASSETS` does not need a new entry — `index.html` is still the same single file, just with substantially more JS inside it. The bump alone is what forces clients to re-fetch.

## 8. Test plan

These are the manual cases that should be exercised before declaring Phase 0 done. Automated coverage is out of scope for a vanilla single-HTML-file project.

**Migration**

1. Install v1 build, add 5 riders, record arrivals and departures for some, then load the v2 build. Verify all times appear identical and the stop selector shows "Checkpoint."
2. Install v1 build with the `HH:MM:SS` legacy time format in storage. Verify migration silently truncates.
3. Fresh install of v2 with no prior data. Verify default state, single stop, empty grid.

**Stop switching**

1. Add three stops in Settings. Switch between them. Verify the grid re-renders empty for stops with no events.
2. With `myStop = 2`, record arrivals at stop 2. Switch to stop 1. Verify cells on stop 1 are read-only and inert.
3. Long-press a cell on stop 1 while `myStop = 2`. Verify nothing happens — no keypad, no flash, no toast.
4. Tap an empty cell on stop 1 while `myStop = 2`. Verify nothing happens.

**Recording and editing on my stop**

1. Tap an empty Arrival cell. Verify the time appears with the green flash and is persisted.
2. Long-press the now-filled cell. Verify keypad opens with the current value pre-filled.
3. Edit to a different time, save. Verify display updates and the log has two events for that `(rider, stop, A)` pair.
4. Long-press, Clear. Verify the cell goes back to empty and a `Z` event is in the log.
5. Long-press a Departure cell, type 1430, save. Verify display.
6. Long-press the same Departure cell, Clear. Verify a `Y` event is in the log.

**Cross-stop attribution**

1. With `myStop = 2`, record some arrivals.
2. Change `myStop` to 3 in Settings. Switch the grid view to stop 2. Verify cells are now read-only (because stop 2 is no longer "mine"). Verify the previously recorded times still display.
3. Switch to stop 3. Verify grid is empty and editable.

**Roster management**

1. Import a CSV with 50 riders. Verify all appear in the grid for every stop.
2. Re-import a different CSV. Verify roster replaces but events for now-removed riders still exist in the log (display them as `#<num> — (unknown)` if necessary).

**Export**

1. Record some times at stop 2. Export CSV. Verify filename and content reflect stop 2 only.
2. Switch to stop 3 (also has data). Export CSV. Verify filename and content reflect stop 3.
3. Send to Google Sheet. Verify the new tab title includes the stop name.

## 9. Edge cases and decisions

| Situation | Decision |
|---|---|
| Operator changes `myStop` mid-event | Allowed. Future events go to the new stop. Past events stay attached to whichever stop they were recorded for. |
| Operator changes `myDevice` mid-event | Allowed but rare. Past events under the old origin keep their numbering; new events start a fresh seq counter under the new origin. The local "next seq" is computed as `max(seq | origin === myDevice) + 1` so changing `myDevice` correctly resets to 1 for an unused id. |
| Two operators accidentally pick the same `myDevice` and have records of independent events under the same origin id, then one of them imports the other's data | Out of scope — Phase 0 has no inter-device data flow. This becomes detectable in Phase 1 (see RADIO-SYNC.md §6.5 collision detection). |
| Roster has a rider number with existing events, then the user re-imports a CSV that omits that rider | Events stay. Grid shows `#<num> — (unknown)` for that rider until the roster is updated. No data loss. |
| User removes a stop in Settings that has events attached | Warn before confirming. On confirm: stop is removed from the `stops` list but events with that `stop` value remain in the log. They're hidden until the stop is re-added with the same id. (Effectively soft-delete at the stop level.) |
| Stop ids drift between operators' devices (operator A's "stop 2" is operator B's "stop 3") | Phase 0 has no sync, so this is a Phase 1 concern. The pre-event briefing should establish a canonical stop list. |
| Display of the time when looking at events from a future date (`recordedAt` ahead of current local clock) | Display shows hhmm as recorded. Phase 0 has no cross-day display issue because there's only one origin and the operator is using the device in real time. Cross-day edge cases are explicitly handled in `RADIO-SYNC.md` once frames carry `D=`. |

## 10. Implementation outline

The work is roughly one focused sitting. Order of operations inside `index.html`:

1. **Add the v2 schema and migration function.** Put the migration call at the very top of the boot sequence, before any rendering.
2. **Replace `state.riders[i].arrival/departure` reads** with a `getCellValue(rider, stop, kind)` helper that runs the reduction over `events`. Keep this helper memoized per render.
3. **Replace `state.riders[i].arrival/departure` writes** with `appendEvent({...})`. Centralize so every write goes through one path.
4. **Add stop list + my-stop state** plus the dropdown component in the header. Keep it CSS-only (no new dependencies).
5. **Gate cell event handlers** on `state.myStop === currentlyViewedStop`. When the gate is closed, every handler is a no-op.
6. **Settings UI** for stops list, my stop, my device.
7. **Update export filenames and Apps Script tab name** to include the current stop's name.
8. **Bump `CACHE` in `sw.js`** to `checkpoint-v2`.
9. **Update `CHANGELOG.md`** and the user-facing README sections that describe single-stop assumptions.

Avoid the temptation to start splitting `index.html` into modules — CLAUDE.md is explicit that the monolith is intentional. The new code is still vanilla JS, no build step.

## 11. Open questions (please review before code is written)

1. **Default stop list on fresh install** — should the app start with `[{ id: 1, name: "Checkpoint" }]` (matches v1 single-stop look), or with `[]` and force the user to add at least one stop in Settings before recording? The first is friendlier for users who just want the v1 behavior; the second is cleaner. Recommendation: start with one default stop.
2. **"My device" UI prominence** — bury it deep in an Advanced section of Settings (most users never touch it), or surface it more visibly because it'll matter the moment radio sync is enabled? Recommendation: deep in Advanced for Phase 0, with a one-line note that it'll matter for radio sync. Promote to top-level Settings when Phase 1 ships.
3. **Removed-stop UX** — when an operator removes a stop that has events, do we (a) keep events hidden but recoverable, (b) require the operator to confirm a hard-delete, or (c) refuse the removal entirely? Recommendation: (a) with the warning text shown in §4.3.
4. **Read-only cell visual treatment** — desaturated colors + a small lock glyph as proposed in §4.2, or something more aggressive (e.g., grayscale)? Recommendation: desaturate only; aggressive treatment would lose the at-a-glance "this rider has arrived" information that the green/blue colors carry.
5. **Migration backup retention** — keep the v1 keys as a one-version backup (current proposal), or delete them once v2 is written? Recommendation: keep for one release, delete in the release after. Adds three lines of code in a future cleanup commit.
6. **Stop ordering in the dropdown** — sort by id, sort by name, or preserve insertion order? Recommendation: by id (matches operator's mental model of "stop 1 comes before stop 2" along the course).

---

*End of design. Once these questions are answered, implementation can proceed in the order listed in §10. The radio-sync work in `RADIO-SYNC.md` Phase 1 picks up directly from the v2 schema established here.*
