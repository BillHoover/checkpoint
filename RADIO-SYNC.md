# Checkpoint Radio Sync — Design

**Status:** Proposal · not implemented
**Audience:** Future implementers, the user, and Claude Code in later sessions
**Depends on:** Multi-stop refactor — see [`MULTI-STOP.md`](./MULTI-STOP.md). This design assumes the app already has the multi-stop event-log data model that doc establishes.

---

## 1. What we're solving

Multiple checkpoint operators, each with a phone/tablet/laptop running Checkpoint, want to share rider arrival/departure times in real time. The connection between sites is **amateur radio**, not the internet. Each operator's device is connected to a radio (HT, mobile, base) directly, via a sound-card modem, or — most universally — by a human who pastes messages between Checkpoint and a radio app like Winlink, JS8Call, or APRS messaging.

Constraints we accept up front:

- **No internet at the checkpoint.** Sync must work air-gapped from the cellular/WAN.
- **iOS Safari is a first-class target.** Web Serial and Web Bluetooth are not available there. The protocol must be usable with copy/paste alone; hardware automation is a later layer on top.
- **FCC Part 97 §97.113 forbids encrypting messages on US ham bands.** Payload is plaintext. No tokens, no signed blobs.
- **Bandwidth is tiny and lossy.** APRS message field ≈ 67 chars. AX.25 packet payload ≤ 256 bytes. JS8Call normal mode ≈ 16 bps. Frames must be compact and tolerant of drops, duplicates, and reorderings.
- **Single source of truth is each device's local store.** The radio is just a transport; sync is eventually consistent.

## 2. Goals and non-goals

**Goals**

- Each device records times for its own stop and broadcasts them.
- Each device receives times from other stops and displays them as read-only (you can view any stop, edit only your own).
- Sync converges in the absence of duplicates, in the presence of duplicates, and across packet loss.
- Frames are short enough to fit a single APRS message in the common case (≤ 5 events).
- Frames survive paste through email, chat, and radio-software composers without mangling.
- Humans can read a frame off a radio screen and roughly understand it.

**Non-goals (v1)**

- Encrypted or authenticated payloads. Part 97 forbids encryption; authentication via signing is technically allowed but adds bytes and key-management headaches we don't need at this scale.
- Automatic radio keying from the browser. Hardware automation (KISS-over-TCP, Web Serial) is a Phase 3 add-on. Phase 1 is paste-bridge.
- Time-zone handling. All devices are assumed to be in the same local time zone for the duration of the event (true for any single event in practice).
- Conflict-free multi-master editing of the *same* cell from different devices. The product rule is "edit only your own stop," so this shouldn't arise. If it does, both events are kept in the log; the display layer picks the latest by `(origin, seq)`.

**In scope for v1 (resolved from earlier open questions):**

- **Date handling.** The motivating event runs 03:00 to 02:00 the next morning, so frames carry a date and events can offset ±1 day from the frame date. See §5.
- **Roster sync over radio.** Reserved kind letter `R` and a roster-event token shape; sent on demand, not automatically. See §5.3.
- **CSV export of the event log** for post-event audit. See §10 Phase 1.
- **Device-id collision detection** with a loud in-app warning. See §6.6.
- **Top-level Radio panel** during the event, not buried in Settings. See §6.5.

## 3. Architectural shape

The data model is an **append-only event log** keyed by `(origin_device, sequence_number)`. Every state change in the app — recording a time, clearing a time — appends one event. The displayed times table is a **reduction** over the log.

Sync is **gossip / anti-entropy**:

- A device emits **DATA frames** carrying a contiguous run of its own (or a relayed origin's) events.
- A device periodically emits **BEACON frames** advertising the highest contiguous sequence number it has seen, per known origin.
- A device that hears a beacon and has events past the advertised seq retransmits those events.
- Receivers dedupe by `(origin, seq)`. Reapplying a duplicate event is a no-op.

This pattern is robust to drops, reorderings, echoes, and partial connectivity. It also relays naturally: if device A and device C can't hear each other but B can hear both, B's beacons and rebroadcasts close the loop.

## 4. Data model (app-side)

```js
// localStorage: checkpoint.state.v2  (versioned bump from v1)
{
  version: 2,
  myDevice: 5,            // 1..99, user-assigned in Settings
  myStop: 2,              // 1..99, user-assigned, can change mid-event
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
    // each event is immutable; ordering is by (origin, seq)
    { origin: 5, seq: 1, rider: 12, stop: 2, kind: "A", hhmm: "1423", recordedAt: 1746822180000 },
    { origin: 5, seq: 2, rider: 17, stop: 2, kind: "A", hhmm: "1425", recordedAt: 1746822300000 }
  ],
  vector: {
    // per-origin: highest contiguous seq we've fully received
    5: 2,
    3: 47,
    7: 12
  },
  pending: {
    // per-origin: out-of-order events buffered until gaps fill
    3: [{ seq: 49, ... }, { seq: 50, ... }]
  }
}
```

**Reduction rule** (events → displayed times): for each `(rider, stop)` pair, walk events in `(origin, seq)` order, applying:

- `A hhmm` → arrival = hhmm
- `D hhmm` → departure = hhmm
- `Z hhmm` → arrival = null (`hhmm` is when the clear happened, kept for audit)
- `Y hhmm` → departure = null

The "last write wins" within a single origin's seq order is naturally consistent. Across origins, ordering is by `recordedAt` for display purposes only — the log itself is partially ordered.

## 5. Wire format

### 5.1 Frame anatomy

Every frame is a single line of printable ASCII:

```
<MAGIC> <FRAME-TYPE-AND-FIELDS> *<CRC16>
```

- `MAGIC` is `CKPT/1`. The `1` is the format version. Receivers must reject frames with an unknown version.
- Fields are space-separated. Whitespace is significant only as a separator.
- `CRC16` is CRC-16-CCITT (polynomial `0x1021`, initial value `0xFFFF`, no final XOR), computed over every byte from `C` of `CKPT` up to and including the space before `*`. Encoded as four uppercase hex characters.
- A frame longer than **67 chars** MUST be split (one origin run per frame; reduce events-per-frame as needed). 67 is the APRS message-field limit and is the tightest practical transport — frames that fit it survive every other transport too. The split limit is a single fixed value in v1; per-transport tuning is a future option.

### 5.2 DATA frame

Carries a contiguous run of events from a single origin device:

```
CKPT/1 O=<origin> S=<stop> D=<yyyymmdd> N=<seqStart>-<seqEnd> <event> <event> ... *<crc>
```

| Field | Meaning |
|---|---|
| `O=<origin>` | The device that *originally created* these events. 1..99. |
| `S=<stop>` | Default stop for events in this frame. Per-event override permitted. |
| `D=<yyyymmdd>` | Default event date for this frame, 8 digits, e.g. `20260509`. Per-event ±1 day offset permitted (see §5.3). |
| `N=<seqStart>-<seqEnd>` | Contiguous, inclusive sequence range. `seqEnd ≥ seqStart`. |
| `<event>` | One event token (see §5.3). Number of events MUST equal `seqEnd - seqStart + 1` (counting only timed events; see §5.3 for roster events, which are sent in their own frames — see §5.4.1). |

Receivers MUST reject the frame if event count and seq range disagree.

The `D=` field is mandatory for v1 because the motivating use case (a 23-hour brevet starting at 03:00 and finishing at 02:00 the next morning) crosses local midnight. For events on the same date as the frame, no per-event date metadata is needed; for events that crossed midnight relative to `D=`, use the `/d±N` suffix in the event token.

### 5.3 Event token

There are two shapes — **timed events** (kinds `A` `D` `Z` `Y`) and **roster events** (kind `R`). The first character after the rider's digits is the kind letter and tells the parser which shape follows.

#### Timed events (A / D / Z / Y)

```
<rider><kind><hhmm>[<suffix>...]
```

| Subfield | Format | Meaning |
|---|---|---|
| `<rider>` | 1–4 digits | Rider number. 1..9999. |
| `<kind>` | one of `A` `D` `Z` `Y` | `A`=set arrival, `D`=set departure, `Z`=clear arrival, `Y`=clear departure. Other letters reserved; receivers MUST ignore unknown timed kinds (forward-compat). |
| `<hhmm>` | 4 digits | 24-hour wall clock, `0000`..`2359`. For Z/Y, this is the clear time (audit only). |
| `<suffix>` | zero or more, each `/...` | Optional overrides; order does not matter. See below. |

**Suffixes** (any subset, any order):

| Suffix | Meaning |
|---|---|
| `/<digits>` | Stop override. Replaces the frame's `S=` for this event. 1..99. |
| `/d+1` or `/d-1` | Day offset relative to the frame's `D=`. Use when an event crossed midnight relative to the frame date. v1 supports ±1 only; receivers MUST reject larger offsets. |

Parsing: scan digits → rider, one letter (A/D/Z/Y) → kind, four digits → hhmm, then zero or more `/`-prefixed suffixes. A suffix starting with `d` is a day offset; otherwise it's a stop number.

#### Roster events (R)

```
<rider>R<encoded-name>
```

| Subfield | Format | Meaning |
|---|---|---|
| `<rider>` | 1–4 digits | Rider number this name is being attached to. |
| `R` | literal | Roster-bind kind. |
| `<encoded-name>` | 1+ chars from `[A-Za-z0-9._-]` plus `_` and `%XX` | The rider's display name, encoded (see below). |

**Name encoding rules:**

- Spaces → `_` (underscore).
- Literal underscores in a name → `%5F`.
- Any character outside `[A-Za-z0-9._-]` → `%XX` (uppercase 2-hex, UTF-8 byte). E.g. `José` becomes `Jos%C3%A9`.
- Decoder reverses: `%XX` → byte; remaining `_` → space.
- Receivers MUST reject roster events whose decoded name exceeds 60 bytes (a sane upper bound; long names are an operator data-quality issue, not a protocol case).

Roster events have no time, no stop, and no day offset. They participate in the same `(origin, seq)` numbering as timed events — the recording device's `seq` counter advances by one whether the event is a roster bind or a timed observation.

A roster event for rider N replaces any prior name binding for rider N in the receiver's local roster. If the receiver had no entry for rider N, one is created.

### 5.4 BEACON frame

Advertises what this device has seen, per known origin:

```
CKPT/1 B F=<sender> S=<stop> <vector> <vector> ... *<crc>
```

| Field | Meaning |
|---|---|
| `B` | Frame type marker. |
| `F=<sender>` | Sender's device id ("from"). Distinct from `D=` (date) used in DATA frames. |
| `S=<stop>` | Sender's current stop. Informational, helps operators understand who's where. |
| `<vector>` | `<origin>/<seq>` — sender has fully received origin's events through `seq`. |

Beacons carry no date field — they're pure metadata about sequence numbers, which are date-independent.

The sender SHOULD include itself in the vector list (so others learn its latest seq even if it hasn't sent DATA recently).

A device that hears a beacon and has DATA frames the sender lacks MAY rebroadcast them. To avoid storms, beacons are operator-triggered in v1 ("Compose beacon" button); see §6.5 for the staleness-based UI nudge that reminds operators to re-beacon every ~10 minutes.

### 5.5 BNF (formal)

```
frame         = magic SP body SP "*" crc
magic         = "CKPT/1"
body          = data-body / beacon-body
data-body     = "O=" device SP "S=" stop SP "D=" yyyymmdd SP
                "N=" seq "-" seq SP event-list
beacon-body   = "B" SP "F=" device SP "S=" stop SP vector-list
event-list    = event *(SP event)
event         = timed-event / roster-event
timed-event   = rider time-kind hhmm *suffix
suffix        = "/" (stop / day-offset)
day-offset    = "d" ("+" / "-") "1"        ; v1: ±1 only
roster-event  = rider "R" encoded-name
vector-list   = vector *(SP vector)
vector        = device "/" seq
device        = 1*2DIGIT                   ; 1..99
stop          = 1*2DIGIT                   ; 1..99
rider         = 1*4DIGIT                   ; 1..9999
seq           = 1*DIGIT                    ; >= 0  (0 only in beacons)
time-kind     = "A" / "D" / "Z" / "Y"
hhmm          = 4DIGIT                     ; 0000..2359
yyyymmdd      = 8DIGIT                     ; e.g. 20260509
encoded-name  = 1*name-char                ; see §5.3 encoding rules
name-char     = ALPHA / DIGIT / "." / "-" / "_" / pct-encoded
pct-encoded   = "%" 2HEXDIG
crc           = 4HEXDIG                    ; uppercase
DIGIT         = %x30-39
ALPHA         = %x41-5A / %x61-7A
HEXDIG        = DIGIT / "A" / "B" / "C" / "D" / "E" / "F"
SP            = %x20
```

Note: in DATA frames, `D=` is **date**; in BEACON frames, the sender id field is `F=` (not `D=`) to avoid the name clash. See §5.4.

### 5.6 Worked examples

CRC values shown below are illustrative — recompute with the canonical CRC-16-CCITT algorithm at implementation time and replace.

**A. Two arrivals at stop 2 from device 5 on 2026-05-09, seqs 47–48:**

```
CKPT/1 O=5 S=2 D=20260509 N=47-48 12A1423 17A1425 *A3F2
```

61 chars. Fits one APRS message. With three events the same frame would be 69 chars, just over the APRS limit, so the splitter would emit two frames.

**B. Single-event frame: clear of rider 12's arrival, device 5, seq 50:**

```
CKPT/1 O=5 S=2 D=20260509 N=50-50 12Z1435 *7C9E
```

51 chars.

**C. Cross-origin relay with stop override. Device 5 retransmits device 3's events 12–13 (covering stops 4 and 5):**

```
CKPT/1 O=3 S=4 D=20260509 N=12-13 7A0815 11A0820/5 *118D
```

The relay rebroadcasts under the **original origin** (`O=3`), not the relayer's device id. Receivers dedupe by `(3, 12..13)` regardless of who actually transmitted.

**D. Cross-midnight, single frame using day offsets. Device 5 broadcasting at 00:04 on 2026-05-10, holding one event from just before midnight and one from just after:**

```
CKPT/1 O=5 S=2 D=20260510 N=72-73 9A2358/d-1 11A0002 *4517
```

Rider 9 arrived at 23:58 the day *before* the frame date (i.e., 2026-05-09); rider 11 arrived at 00:02 today.

**E. Roster bind. Device 5 attaching the name "A. Smith" to rider 12, seq 30:**

```
CKPT/1 O=5 S=2 D=20260509 N=30-30 12RA._Smith *D81C
```

Roster events have no time or stop semantics; the `S=` and `D=` headers are still required by the DATA-frame format but don't affect the roster bind itself.

**F. Roster bind with a non-ASCII name. "José M." attached to rider 47:**

```
CKPT/1 O=5 S=2 D=20260509 N=31-31 47RJos%C3%A9_M. *0A2B
```

`%C3%A9` is the UTF-8 encoding of `é`. Underscore expands to a space when decoded.

**G. Beacon from device 5 at stop 2, advertising what it knows from devices 3, 5, and 7:**

```
CKPT/1 B F=5 S=2 5/49 3/14 7/99 *9E1A
```

42 chars. Note `F=` (sender) — DATA frames use `D=` for date, beacons use `F=` for sender, so the two never clash.

**H. New device introduces itself with an empty-vector beacon:**

```
CKPT/1 B F=8 S=3 8/0 *5532
```

`/0` means "I have no events of my own yet." Other devices respond by sending their own beacons or recent DATA, so device 8 learns the population.

## 6. Sync protocol

### 6.1 Sequence numbers

- Each device maintains a single monotonically increasing `seq` counter, persisted to `localStorage`.
- The first event a device creates is `seq=1`.
- `seq` never resets, even if events are deleted from local storage (which we don't currently do).

### 6.2 Sending DATA

- After recording one or more new events, the app composes a DATA frame covering the contiguous run of "not yet broadcast" events.
- The frame is shown in the **Outbound** textbox in the Radio panel. The operator pastes it into their radio software.
- A "Mark sent" button advances the local `lastSentSeq` for the device. The next outbound frame starts from there.
- If `lastSentSeq` falls behind because of an explicit "resend from N" (e.g., in response to a beacon or a buddy's request), the app composes a frame for that range without disturbing `lastSentSeq` — resends are idempotent at the receiver.

### 6.3 Receiving DATA

1. Validate magic + version. Reject unknown.
2. Validate CRC. Reject mismatched.
3. Parse frame. Reject malformed.
4. For each event in the frame:
   - If `(origin, seq)` is already in the log → ignore (dedupe).
   - If `seq == vector[origin] + 1` → append to log, increment `vector[origin]`. Then drain `pending[origin]` for any contiguous successors.
   - If `seq > vector[origin] + 1` → buffer in `pending[origin]` for later.
   - If `seq <= vector[origin]` → already have it (dedupe).
5. Re-derive the displayed times table from the updated log.

### 6.4 Beacon flow

- Operator triggers "Compose beacon." The app gathers `vector` (its known seqs per origin, plus its own `lastSeq`) and shows a BEACON frame in Outbound.
- On receipt of a beacon from device X advertising vector V_x:
  - For each origin O in V_x where this device's `vector[O] > V_x[O]`: this device has events X is missing. The app surfaces a "Send 12 events to D=8?" prompt; the operator confirms and an Outbound frame is composed.
  - For each origin O in this device's vector where it is *not* in V_x and this device has events: same — offer to send.
  - For each origin O where `vector[O] < V_x[O]`: X has events we lack. Offer "Request from D=8?" which composes a beacon (or a future REQUEST frame) emphasizing the gap.

In v1, all beacon-driven retransmits are operator-confirmed. Future versions can automate.

### 6.5 Device-id collision detection

Each device is assigned a `myDevice` value (1..99) by an operator during pre-event briefing. If two devices end up with the same id, their `(origin, seq)` namespaces collide and the log can silently corrupt.

The receiver detects this on every inbound DATA event:

- For each parsed event with `(origin = O, seq = N)`:
  - If the local log has no event at `(O, N)` → apply normally.
  - If the local log has an event at `(O, N)` with **identical** content (same rider, kind, hhmm, stop, day-offset, name where applicable) → ignore (dedupe; this is a normal retransmit).
  - If the local log has an event at `(O, N)` with **different** content → this is a collision. The receiver MUST:
    1. Refuse to overwrite the existing event.
    2. Quarantine the conflicting inbound event in a `collisions[]` list (origin, seq, both event payloads, time observed).
    3. Surface a loud warning in the Radio panel: red banner, persistent until dismissed, with text like *"Device-id collision detected on D=5 seq 47. Two devices may share id 5. Reassign and re-broadcast."*
    4. The dismiss action does not clear `collisions[]`; that requires an operator-initiated "Resolve" flow that walks through each entry.

False positives are possible if a device's local storage was wiped and `seq` reset; the operator-driven resolution is the right answer for both cases (renumber, re-broadcast).

### 6.6 Operator UX (Radio panel)

The Radio panel is **top-level**, not buried in Settings. During the event the operator needs to see at a glance whether sync is healthy and whether anything is waiting to go out. The proposed shape: a collapsible bar pinned above the times table that expands to the full panel below when the operator opens it. Closed state shows just the essentials — outbound count and stale-peer count — at row height ≈ 28px.

```
┌─ Radio sync ──────────────────────────────────────┐
│ My device: 5     My stop: 2   [Edit]              │
│                                                   │
│ Outbound (12 events to send) [Compose] [Beacon]   │
│ ┌───────────────────────────────────────────────┐ │
│ │ CKPT/1 O=5 S=2 D=20260509 N=47-49 12A1423... │ │
│ └───────────────────────────────────────────────┘ │
│ [Copy] [Mark sent]                                │
│                                                   │
│ Inbound — paste received frame here:              │
│ ┌───────────────────────────────────────────────┐ │
│ │                                               │ │
│ └───────────────────────────────────────────────┘ │
│ [Apply]                                           │
│                                                   │
│ Known peers:                                      │
│   F=3 stop=4   seen 14 events   last 0815  ●      │  ← stale, last heard >10m ago
│   F=7 stop=1   seen 99 events   last 1432         │
│   F=8 stop=3   seen 0 events    last —     ●      │  ← never heard from yet
└───────────────────────────────────────────────────┘
```

**Staleness highlight.** Each known peer row shows when it was last heard. If that's older than 10 minutes — or if the peer has never been heard from — the row gets the staleness indicator (`●` mark + warm-orange tint, matching the rest of the dark-theme palette). The Compose-Beacon button itself also gets the same tint when *any* peer is stale, as a passive nudge for the operator to send a beacon. No automatic transmissions; the operator stays in control.

Compose and Apply are explicit, single-button actions. Operators are already running a radio; one extra button isn't friction.

## 7. Transport bindings

### 7.1 v1 — paste bridge (universal)

- App ↔ operator ↔ radio software.
- Works on iOS, Android, any desktop browser.
- No permissions, no hardware integration.
- A frame fits a single APRS message (67 chars) at ≈ 3 events in the typical case; the splitter emits multiple frames when more is queued. Larger digests fit AX.25 packets, Winlink emails, or JS8 messages.

### 7.2 Phase 3 — KISS over TCP (later, optional)

- For operators running Direwolf or a hardware TNC with a network interface.
- Browser opens `ws://<tnc-host>:8001/kiss` (requires a small WebSocket → KISS bridge — Direwolf has KISS-TCP natively but framing differs from WebSocket; a 30-line shim or one of the existing kissws bridges does it).
- Removes the paste step but keeps the same frame format. iOS still works in paste mode.

### 7.3 Phase 3 alt — Web Serial (later, optional, desktop/Android)

- Direct USB to TNC like Mobilinkd or NinoTNC.
- Chrome/Edge only; iOS not supported.
- Same frame format.

The frame format does not change between transports. Whatever bytes the radio carries, they're the same printable-ASCII line.

## 8. Failure modes and edge cases

| Situation | Behavior |
|---|---|
| Bad CRC | Discard frame. Show a counter in the Radio panel ("12 frames rejected — bad CRC"). |
| Unknown version (`CKPT/2 ...`) | Discard. Counter increments separately ("3 frames from a newer version"). |
| Unknown event kind (`12Q1423`) | Skip that event but accept the rest of the frame, **provided** the frame's `N=` count still matches the *parsed* event count. (The kind letter doesn't change the event count, so this works.) |
| Duplicate frame (radio echo) | Idempotent: dedupe by `(origin, seq)` per event. |
| Out-of-order event (seq gap) | Buffer in `pending[origin]`. The Radio panel surfaces the gap: "Missing D=3 seq 48". Operator can compose a beacon to request it. |
| Two devices with the same `myDevice` | Mandatory detection (§6.5). Conflicting `(origin, seq)` triggers a persistent red banner, quarantines the inbound event, and prompts the operator to reassign and re-broadcast. |
| Two devices both record the same cell (same rider, stop, kind) | Both events are kept in the log. Display picks the latest by `(origin, seq)` (and `recordedAt` across origins). **No conflict marker shown** — silent resolution per resolved decision; the log itself is the audit trail. |
| Clock skew between devices | Tolerated. `hhmm` is the wall-clock the *recording* operator saw. Display shows times as recorded. The log uses `(origin, seq)` for ordering, not time. Operators are expected to set their device clocks during pre-event briefing. |
| Event at midnight (e.g., 23:58 then 00:02) | DATA frames carry `D=YYYYMMDD`; events that crossed midnight relative to that date use `/d-1` (or `/d+1`) suffix. The display joins `D=` with the per-event hhmm and offset to compute the actual date for sorting and CSV export. |
| All-day event date in display | `D=` is set by the *sender's* local date when composing. Receivers don't normalize across time zones — out of scope per non-goal in §2. Within a single time zone (the only supported case), this is unambiguous. |
| Operator in a tunnel / out of radio | Local recording continues. Outbound queue grows. When the radio link returns, the next composed frame catches up everyone in range (within size limits — frames > 220 chars get auto-split into multiple frames covering sub-ranges). |
| Roster mismatch (a device is missing a rider in the CSV) | Receiver still applies the event; the rider shows as `#<num> — (unknown)` until the roster is updated. No data is lost. |

## 9. Privacy and Part 97

- The wire format **never** carries rider names or other PII. It carries rider *numbers* only.
- Names live in the local roster (from CSV import) and are joined client-side at display time.
- The CSV roster itself is distributed by whatever method the event organizers prefer (USB stick, email before the event, in-person briefing). It doesn't go over radio.
- Frames have no encryption. Anyone in radio range can decode them. This is required by Part 97 and is acceptable for a public sport-event tool.
- No callsigns are embedded in frames; the radio operator's software handles Part 97 §97.119 station-identification requirements separately (every 10 minutes on transmission, plus at end).

## 10. Implementation plan

### Phase 0 — Multi-stop refactor (prerequisite)
- Replace per-rider `{arrival, departure}` with the append-only `events` log + reduction.
- Add `stops` and `myStop` Settings.
- Stop switcher in the header. View any stop; only `myStop` is editable.
- Storage migration from `checkpoint.riders.v1` to `checkpoint.state.v2`.
- Bump SW cache to `checkpoint-v2`.

### Phase 1 — Radio sync, paste-bridge MVP
- `myDevice` Settings field (1..99).
- Frame encoder/decoder, CRC-16-CCITT.
- Date handling: `D=` in DATA frames (defaults to today's local date when composing), `/d±1` suffix on cross-midnight events.
- Frame splitter at 67 chars (APRS limit).
- Outbound textbox + Compose / Mark-sent buttons.
- Inbound textbox + Apply button.
- Per-origin `vector` and `pending` state.
- Known-peers panel (top-level Radio panel above the times table).
- Roster sync support: encoder/decoder for `R` events; "Broadcast roster" action that emits R events for every rider currently in the local roster.
- Device-id collision detection with persistent banner and quarantine list.
- CSV export of the raw event log (in addition to the existing rider×times CSV) — adds a fifth Export-modal option *"Save event log (CSV)"*. Columns: `origin, seq, recordedAt, kind, rider, stop, hhmm, dayOffset, name`.

### Phase 2 — Anti-entropy
- Compose beacon button.
- Beacon-driven retransmit prompts ("Send 12 events to F=8?").
- Stale-peer highlighting (>10 min since last heard) on peer rows and the Compose-Beacon button.
- Counters: frames sent, received, rejected (by reason).

### Phase 3 — Hardware automation (optional, future)
- KISS-over-TCP bridge (WebSocket → Direwolf).
- Web Serial direct-to-TNC (desktop/Android).
- Auto-compose every N seconds when there's pending Outbound.

## 11. Resolved decisions

These were the open questions surfaced during initial design. All are now decided and folded into the spec above; this section is the audit trail.

| # | Question | Decision | Where it lives in the spec |
|---|---|---|---|
| 1 | Date handling — accept v1 limitation, or carry date in frames? | **Carry date.** The motivating event runs 03:00 → 02:00+1, so cross-midnight is a first-class case. DATA frames carry mandatory `D=YYYYMMDD`; events use `/d±1` for ±1 day offsets. | §5.2, §5.3 |
| 2 | Auto-split threshold — fixed or per-transport? | **Fixed at 67 chars (APRS message field).** Tighter than AX.25 but ensures every transport works without per-transport branching. Re-evaluate in a later version if APRS turns out to be unused. | §5.1 |
| 3 | Beacon cadence — operator-only or periodic nudge? | **Operator-only with passive UI nudge.** No automatic transmissions. Peer rows and the Compose-Beacon button highlight when any peer has been silent for >10 min. | §6.6 |
| 4 | Conflict UI when two devices record the same cell — marker, or silent? | **Silent.** Display picks the latest by `(origin, seq)` then `recordedAt`. The full event log is the audit trail; cluttering the cell hurts more than it helps. | §8 |
| 5 | Device-id collisions — auto-detect, or silent coexistence? | **Detect and warn loudly.** Mandatory: receiver compares inbound events against the local log at `(origin, seq)`; a content mismatch quarantines the inbound, fires a persistent red banner, and demands operator action. | §6.5 |
| 6 | CSV export of the event log — v1, or defer? | **Include in v1.** Adds a fifth option to the existing Export modal: *Save event log (CSV)*. Schema in §10 Phase 1. | §10 |
| 7 | Roster sync over radio — defer, or implement now? | **Implement now.** Operators may need to push name corrections mid-event when CSV pre-loading turns out incomplete. New event kind `R` with a separate token shape; encoder uses underscore-for-space + `%XX` for non-`[A-Za-z0-9._-]`. | §5.3 |
| 8 | Radio panel placement — Settings tab, separate top-level panel, or pinned? | **Top-level, pinned above the times table** as a collapsible bar. Closed state shows outbound count and stale-peer count; expanded state is the full panel. | §6.6 |

---

*End of design. The next artifact should be a Phase 0 (multi-stop refactor) design before any code is written; treat that as a separate companion document, since it has its own data-migration and UX questions independent of radio sync.*
