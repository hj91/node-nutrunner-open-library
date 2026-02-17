## Changelog

## [1.0.4] - Production Ready - 2026-02-17
### Fixed
- **Revision 4 Parser Offsets:** Corrected critical offset errors in the Rev 4 parser. It now correctly reads the `Tightening ID` at offset 157 and `Timestamp` at offset 118, preventing garbage data from being parsed.
- **Spindle ID Extraction:** Modified `_onData` to extract the **Spindle ID** directly from the Message Header (bytes 12-14). This fixes compatibility with Rev 4 messages which do not include the Spindle ID in the payload.
- **Rev 4 OK Validation:** Changed the `ok` status validation to be strictly spec-compliant. It now checks `Overall Status` && `Torque Status` && `Angle Status` instead of relying on a single bit.

### Added
- **Gap Filling (Rev 4):** Added parsing for previously missing fields:
  - `Cell ID`, `Channel ID`, `Controller Name` (Bytes 0-30).
  - `Last Parameter Set Change` timestamp (Bytes 137-156).
  - `Batch Status` flag (Byte 156).

---

## [1.0.3] - Feature Add - 2026-02-17
### Added
- **Revision 4 Support:** Added initial support for Open Protocol Revision 4 (MID 0061).
  - Support for **Unique Result ID** (Result Persistent ID).
  - Support for ISO 8601 Timestamps.
  - Support for detailed Error Codes and granular status flags.

### Fixed
- **Protocol Compliance (The "MID" Bug):** Permanently removed the non-standard `"MID"` string prefix from all outgoing and incoming packets. The library now strictly follows the standard 20-byte header format.
- **Network Storm Fix (NoAck):** Fixed the `NoAck` flag in `sendMID`. It is now dynamic (`expectAck ? '0' : '1'`), preventing infinite acknowledgement loops on Heartbeats (MID 9999).

---

## [1.0.2] - Protocol Patches - 2026-02-17
### Fixed
- **Framing Logic:** Updated `_onData` parser to look for the Command ID at offset 0 and Payload at offset 16, correcting the misalignment caused by the previous "MID" string expectation.
- **Connection Stability:** Fixed issue where the client would hang on connection because it was waiting for a non-standard "MID" prefix in the handshake response.

---

## [1.0.1] - Hotfix - 2026-02-17
### Changed
- **Simulator Compatibility:** Applied runtime monkey-patches to `traceability_client.js` to strip null terminators (`\0`) sent by some simulators/controllers, ensuring clean JSON parsing.

---

## [1.0.0] - Initial Release - 2026-02-16
### Features
- **Core Communication:** Basic TCP/IP connection management with auto-reconnect.
- **Revision 1 Support:** Basic Torque/Angle and Pass/Fail parsing.
- **Revision 2 Support:** Basic Traceability support (VIN, Batch ID, Job ID).
- **Interlocks:** logic for `startTightening`, `enableTool`, and `disableTool`.
- **Event System:** Standard Node.js `EventEmitter` interface for `spindleResult`, `alarm`, and `connected` events.