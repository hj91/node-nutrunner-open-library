## Changelog

---

## [1.2.0] - MID 0041 Full 8-Bit Parser & Direction Tracking - 2026-04-25

### Fixed
- **MID 0041 parser was truncated to 4 bits with wrong offsets:** The original parser extracted only 4 fields, but mapped them at incorrect positions relative to the Open Protocol specification. The full corrected mapping:

  | Bit | Old parser (wrong)  | Correct spec field  |
  |-----|---------------------|---------------------|
  | `p[0]` | `controllerReady` ✓ | `controllerReady`   |
  | `p[1]` | `toolEnabled`       | `toolReady` ← misidentified |
  | `p[2]` | `toolRunning`       | `toolEnabled` ← off by one |
  | `p[3]` | `alarmActive`       | `toolRunning` ← off by one |
  | `p[4]` | *(discarded)*       | `direction` (0=FORWARD, 1=REVERSE) |
  | `p[5]` | *(discarded)*       | `processOn` |
  | `p[6]` | *(discarded)*       | `alarmActive` ← was at wrong position |
  | `p[7]` | *(discarded)*       | `emergencyStop` |

  This meant `toolEnabled` and `toolRunning` were always reading from the wrong bytes, `alarmActive` was one bit early, and direction, processOn, and emergencyStop were silently dropped on every MID 0041 frame.

- **`_handleMID` case 41 only mapped 4 fields:** State handler updated to write all 8 corrected fields. `toolRunning` rising-edge detection now uses a `prevRunning` guard to prevent spurious `_startTighteningCycle()` calls on repeated identical MID 0041 frames.

- **`startTightening()` had no emergency stop interlock:** `_check('startTightening')` now throws `InterlockError('EMERGENCY_STOP', ...)` if `state.controller.emergencyStop` is true, preventing the tool from being triggered while an e-stop is engaged.

- **`isReady()` did not reflect emergency stop state:** Returns `false` when `controller.emergencyStop` is active.

- **`_onClose()` did not reset new state fields on disconnect:** `tool.ready`, `tool.direction`, `tool.processOn`, and `controller.emergencyStop` are now cleared on every disconnect, preventing stale flags from bypassing interlocks after reconnect.

### Added
- **`tool.ready`** (`state.tool.ready`) — tracks MID 0041 bit[1]; `true` when the tool hardware is ready but not necessarily enabled by software. Distinct from `tool.enabled`.
- **`tool.direction`** (`state.tool.direction`) — tracks MID 0041 bit[4]; value is `'FORWARD'`, `'REVERSE'`, or `'—'` (unknown/not-reported). Updated live on every MID 0041 frame.
- **`tool.processOn`** (`state.tool.processOn`) — tracks MID 0041 bit[5]; `true` while the operator is actively holding the trigger.
- **`controller.emergencyStop`** (`state.controller.emergencyStop`) — tracks MID 0041 bit[7]; `true` when the e-stop circuit is open.
- **`directionChanged` event** — emitted when direction transitions between `'FORWARD'` and `'REVERSE'`. The `'—'` (unknown) state is suppressed and does not trigger the event. Payload: `{ direction: 'FORWARD' | 'REVERSE' }`.
- **`emergencyStop` event** — emitted on both rising edge (`{ active: true }`) and falling edge (`{ active: false }`) of the e-stop bit. Integrators can use this to lock out UI controls or trigger safety alarms without polling.
- **`tighteningCycleStarted` now includes `direction`** — payload is now `{ timestamp, direction }` so the consuming application immediately knows if the operator triggered a tightening or a loosening cycle.

---

## [1.1.4] - MID 0071 Alarm Fix - 2026-04-25

### Fixed
- **Alarms silently ignored on spec-compliant controllers:** Per the Open Protocol specification, the controller sends alarm *notifications* as **MID 0071** (not MID 0070). MID 0070 is the *subscribe* request sent by the client. The library only had `case 70` in `_handleMID`, so any controller following the spec (including the simulator) would send MID 0071 which was hit the `default` branch and ignored — the `alarm` event would never fire and `errorActive` would never be set. Fixed by adding `case 71:` as a fall-through to the same alarm handler.
- **`_parseMID` also updated** to parse MID 0071 with the same field layout as MID 0070.

### Added (logger)
- MID 0071 added to `MID_INFO_IN` with full explanation and reply notes.
- MID 0072 added to `MID_INFO_OUT` (alarm ack variant used by MDCv2/MDTC controllers).
- MID 0900 added to `MID_INFO_IN` — now shows as "Trace Curve Data (binary)" instead of "Unknown MID".

---

## [1.1.3] - Cycle Duration Fix - 2026-04-25

### Fixed
- **Cycle duration showed Unix timestamp (~1.7 trillion ms) instead of real milliseconds:** Controllers that do not send MID 0041 (Tool Status) never triggered `_startTighteningCycle()`, leaving `cycleStartTs` as `null`. `Date.now() - null` evaluates to `Date.now()` — the Unix epoch ms — not a duration. `_handleTighteningResult` now auto-initialises `inProgress = true` and `cycleStartTs = Date.now()` if the cycle was not already started, producing a valid (near-zero) duration when a result arrives without a prior MID 0041.

---

## [1.1.2] - Diagnostic Logger - 2026-04-25

### Added
- **`protocol-logger.js`** — Standalone diagnostic tool that connects to any Open Protocol controller and logs every MID in both directions with plain-English explanations, parsed fields, and descriptions of what the library will send back. Includes:
  - Extended MID 0041 parsing: process on/off, forward/reverse direction, tool ready, emergency stop
  - Live status dashboard printed on every MID 0041 change
  - MID 0040 subscription for proactive tool status push
  - Periodic status snapshot every 60 s
  - ANSI-coloured output — incoming MIDs in cyan, outgoing in yellow, alarms in red

---

## [1.1.1] - Generic Brand Default - 2026-04-25

### Changed
- **Default `brand` changed from `'atlas-copco'` to `'generic'`** — The library no longer defaults to a specific manufacturer's name. `'generic'` uses the same spec-compliant MID assignments (Job=0038, Enable=0043, Disable=0042, Rev4) but correctly expresses that these are the Open Protocol specification defaults, not Atlas Copco-specific values.
- **Profile resolution fallback** also updated to `'generic'` — an unrecognised brand string now falls back to the neutral spec default instead of a manufacturer name.

---

## [1.1.0] - Promise-Based Command API - 2026-04-25

### Changed (Breaking)
- **`sendMID` now returns a `Promise`** when `expectAck = true`. All public command methods (`enableTool`, `selectJob`, `downloadVIN`, `disableTool`, `startTightening`, `resetBatch`, `decrementBatch`, `selectParameterSet`) now return real Promises that resolve on MID 0005 ACK and reject on MID 0004 NAK or timeout. Previously they returned a command ID number and `await` had no effect.
- **`acknowledgeAlarm()`** is now explicitly fire-and-forget — returns `void`, routes errors to the `commandError` event. No `await` needed or expected.

### Added
- **`commandSuccess` event** — emitted when a pending command's Promise resolves (`{ mid, cmdId }`).
- **`commandFailed` event** — emitted when a pending command's Promise rejects (`{ mid, cmdId, data }`).
- **`commandAborted` event** — pending Promises are now rejected (not silently dropped) when the connection closes.

### Fixed
- **Timeout rejection** — command timeout now rejects the returned Promise with a `CommandError` in addition to emitting `commandTimeout`.
- **Disconnect rejection** — all in-flight commands are now rejected with `"aborted — connection closed"` on disconnect, preventing silent hangs.

---

## [1.0.8] - Bug Fixes - 2026-04-25

### Fixed
- **Revision negotiation always started at Rev 1:** `subscribeTighteningResults()` was using `state.protocol.revision` (set to `1` by the MID 0003 comm-start ACK) instead of `profile.maxRevision`. Controllers that support Rev 4 were always subscribed at Rev 1. Fixed to always start negotiation from `profile.maxRevision`.
- **`_pendingRevision` not reset on reconnect:** After a session that negotiated down to Rev 2, the next reconnect would start negotiation from Rev 2 instead of the profile maximum. `_pendingRevision` is now reset to `profile.maxRevision` in `_onClose()`.
- **`downloadVIN` ACK not setting `vinValid`:** The MID 0005 ACK for MID 0050 was silently ignored. `vinValid` stayed `false` after a successful VIN download, causing `startTightening()` to throw `VIN_REQUIRED` if the controller did not send MID 0051. VIN is now committed to state on the MID 0005 ACK; a new `vinDownloaded` event is emitted.
- **Silent failure when all revisions exhausted:** If the controller rejected MID 0060 at every revision level, no event was emitted. A new `revisionNegotiationFailed` event is now emitted with `{ errorCode, message }` when `_pendingRevision === 1` gets a NAK.
- **`getState()` silently dropping Map data:** `JSON.stringify` converts a `Map` to `{}`. The `tightening.pendingSpindles` Map now serialises correctly as an array via a custom JSON replacer. Timer handles are omitted cleanly.

### Added
- **`vinDownloaded` event** — emitted when MID 0050 ACK is received, confirming the controller accepted the VIN (`{ vin }`).
- **`revisionNegotiationFailed` event** — emitted when the controller rejects MID 0060 at every revision level (`{ errorCode, message }`).

---

## [1.0.7] - VIN Traceability Fix - 2026-04-25

### Fixed
- **VIN always `null` in `tighteningCycleCompleted`:** `_handleTighteningResult` never synced `state.product.vin` from the MID 0061 result payload even though every tightening result embeds the VIN at offsets 31–56. State is now updated from the result on every cycle, covering controllers that never send MID 0051.

### Changed
- **`02-vin-traceability.js` example** — VIN is now read from `results[0].vin` (embedded in result) with `getState().product.vin` as fallback, instead of relying solely on state.

---

## [1.0.6] - Multi-Brand Support & Revision Negotiation - 2026-04-25

### Added
- **Brand profiles** — new `brand` constructor option selects the correct MID assignments for each manufacturer family:
  - `generic` — spec-default Open Protocol profile for unknown or third-party controllers; Job=0038, Enable=0043, Disable=0042, maxRevision=4
  - `atlas-copco` — Job=0038, Enable=0043, Disable=0042, maxRevision=4
  - `stanley` — Job=0034, Enable=0043, Disable=0042, maxRevision=2
  - `desoutter` — Job=0038, Enable=0043, Disable=0042, maxRevision=4
  - `ingersoll-rand` — Job=0034, Enable=0043, Disable=0042, maxRevision=2
- **Per-MID constructor overrides** — `jobSelectMid`, `toolEnableMid`, `toolDisableMid`, `maxRevision` can be set individually to override the brand profile default.
- **Automatic revision negotiation** — library now starts MID 0060 subscription at `profile.maxRevision` and automatically steps down on NAK until Rev 1.
- **`revisionNegotiated` event** — emitted when the controller ACKs MID 0060, locking in the negotiated revision (`{ revision }`).
- **`revisionDowngrade` event** — emitted on each step-down during negotiation (`{ from, to }`).
- All command methods (`selectJob`, `enableTool`, `disableTool`, `startTightening`) now use `profile.*Mid` instead of hardcoded MID numbers.
- All example files updated with `brand` option, `async function main()` pattern, `linkEstablished` for setup commands, and new negotiation events.

---

## [1.0.5] - Package & Dependency Fixes - 2026-04-25

### Fixed
- **`package.json` wrong dependency category:** `node-opcua`, `mqtt`, and `@influxdata/influxdb-client` were listed under `optionalDependencies`, causing ~200 MB of unnecessary downloads for every `npm install`. Moved to `devDependencies`.
- **`engines` field updated** to `>=18.0.0` (Node.js 14 has been EOL since April 2023).
- **`start` script** pointed at an example file; removed to avoid confusing library consumers.
- **`directories.doc`** referenced a `docs/` directory not included in `files`; removed.

---

## [1.0.4] - Production Ready - 2026-02-17

### Fixed
- **Revision 4 Parser Offsets:** Corrected critical offset errors in the Rev 4 parser. `Tightening ID` is now read at offset 157 and `Timestamp` at offset 118.
- **Spindle ID Extraction:** Spindle ID is now extracted directly from the Message Header (bytes 12–14), fixing compatibility with Rev 4 messages that do not include it in the payload.
- **Rev 4 OK Validation:** `ok` status now checks `Overall Status && Torque Status && Angle Status` per spec.

### Added
- **Gap Filling (Rev 4):** `Cell ID`, `Channel ID`, `Controller Name` (bytes 0–30), `Last Parameter Set Change` timestamp (bytes 137–156), `Batch Status` flag (byte 156).

---

## [1.0.3] - Feature Add - 2026-02-17

### Added
- **Revision 4 Support:** Initial support for MID 0061 Rev 4 — Unique Result ID, ISO 8601 timestamps, detailed error codes and status flags.

### Fixed
- **Protocol Compliance:** Removed non-standard `"MID"` string prefix from all packets.
- **Network Storm Fix:** `NoAck` flag is now dynamic (`expectAck ? '0' : '1'`), preventing infinite ACK loops on heartbeats.

---

## [1.0.2] - Protocol Patches - 2026-02-17

### Fixed
- **Framing Logic:** Command ID at offset 0, payload at offset 16.
- **Connection Stability:** Client no longer hangs waiting for a non-standard `"MID"` prefix.

---

## [1.0.1] - Hotfix - 2026-02-17

### Changed
- **Simulator Compatibility:** Strip null terminators (`\0`) from incoming TCP data.

---

## [1.0.0] - Initial Release - 2026-02-16

### Features
- Basic TCP/IP connection management with auto-reconnect.
- Revision 1 and 2 support (Torque/Angle, VIN, Batch ID, Job ID).
- Interlocks for `startTightening`, `enableTool`, `disableTool`.
- Node.js `EventEmitter` interface.
