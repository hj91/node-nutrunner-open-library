# node-nutrunner-open-library

[![npm version](https://badge.fury.io/js/node-nutrunner-open-library.svg)](https://www.npmjs.com/package/node-nutrunner-open-library)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js Version](https://img.shields.io/node/v/node-nutrunner-open-library.svg)](https://nodejs.org)

Production-grade **Open Protocol** nutrunner client for Node.js. Built for real manufacturing environments with robust error recovery, automatic reconnection, multi-brand controller support, and comprehensive industrial safety interlocks.

Designed and tested in actual automotive and aerospace assembly lines in Pune, India.

---

## Features

- ✅ **Full Open Protocol Support** — MID 0001–0101 (Specification 2.8.0+)
- ✅ **Multi-Brand Controller Support** — Atlas Copco, Stanley, Desoutter, Ingersoll Rand via brand profiles
- ✅ **Promise-Based Commands** — `await enableTool()` truly waits for the controller ACK
- ✅ **Automatic Revision Negotiation** — Starts at highest supported revision, downgrades automatically
- ✅ **Production-Hardened** — Handles TCP fragmentation, network glitches, firmware variations
- ✅ **Automatic Reconnection** — Exponential backoff with full state recovery
- ✅ **Safety Interlocks** — Enforces controller-side safety rules (VIN, job, alarms)
- ✅ **Multi-Spindle Tools** — Auto-detection from MID 0061/0101
- ✅ **VIN Traceability** — Automotive-grade part tracking; VIN synced from every result
- ✅ **Batch Manufacturing** — Real-time progress tracking and completion events
- ✅ **Alarm Handling** — Subscribe, acknowledge, and recover from controller alarms
- ✅ **Command Safety** — One-per-MID enforcement prevents state corruption
- ✅ **Event-Driven API** — Perfect for OPC UA, MQTT, MES integration
- ✅ **Zero Dependencies** — Uses only Node.js core modules

---

## Installation

```bash
npm install node-nutrunner-open-library
```

**Requirements:** Node.js >= 18.0.0

---

## Quick Start

```javascript
const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:  '192.168.1.100',
  port:   4545,
  brand: 'atlas-copco'   // selects correct MID profile for this controller
});

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  console.log(`Tightening ${overallOk ? 'OK' : 'NOK'}`);
  results.forEach(r => console.log(`Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°`));
});

nutrunner.on('linkEstablished', async () => {
  await nutrunner.selectJob(1);    // waits for MID 0005 ACK from controller
  await nutrunner.enableTool();    // waits for MID 0005 ACK from controller
  console.log('Ready for tightening!');
});

await nutrunner.connect();
```

---

## Supported Controllers

| Manufacturer | Models | Brand String | MID Profile |
|---|---|---|---|
| **Generic / Unknown** | Any spec-compliant Open Protocol controller | `generic` | Job=0038, Enable=0043, Rev4 |
| **Atlas Copco** | PowerFocus 4000/6000, PowerMACS | `atlas-copco` | Job=0038, Enable=0043, Rev4 |
| **Stanley Assembly Technologies** | Open Protocol compatible | `stanley` | Job=0038, Enable=0043, Rev2 |
| **Desoutter** | CVI controllers | `desoutter` | Job=0038, Enable=0043, Rev4 |
| **Ingersoll Rand** | QX Series | `ingersoll-rand` | Job=0038, Enable=0043, Rev2 |

---

## Constructor Options

```javascript
const nutrunner = new OpenProtocolNutrunner({
  // ── Required ──────────────────────────────────────────────────────────────
  host: '192.168.1.100',

  // ── Connection ────────────────────────────────────────────────────────────
  port:           4545,    // Default: 4545
  autoReconnect:  true,    // Default: true — exponential backoff reconnection
  validateFrames: true,    // Default: true — frame corruption detection

  // ── Brand Profile ─────────────────────────────────────────────────────────
  // Selects the correct MID numbers for your controller manufacturer.
  // Supported: 'generic' | 'atlas-copco' | 'stanley' | 'desoutter' | 'ingersoll-rand'
  // Use 'generic' when the manufacturer is unknown or for spec-compliant controllers.
  // 'generic' uses the official Open Protocol spec defaults (same MIDs as Atlas Copco).
  brand: 'atlas-copco',   // Default: 'atlas-copco'

  // ── Per-MID Overrides (take precedence over brand profile) ────────────────
  jobSelectMid:   null,    // Override job selection MID
  toolEnableMid:  null,    // Override tool enable MID
  toolDisableMid: null,    // Override tool disable MID
  maxRevision:    null,    // Override highest MID 0061 revision to request

  // ── Protocol ──────────────────────────────────────────────────────────────
  communicationRevision: 1,      // MID 0001/0002 revision; steps down on MID 0004 error 97
  linkLevelAck:          false,  // MID 0001 rev 6+ with sequence numbers and MID 9997/9998
  commandTimeout:        10000,  // ms to wait for an answer before the link is considered lost
  powerMacsBoltData:     true,   // MID 0108 "Bolt data": ask PowerMACS for the MID 0107 bolt results

  // ── Hardware ──────────────────────────────────────────────────────────────
  spindleCount:          null,   // Manual override for controllers without MID 101
  allowDuplicateCommands: false  // Default: false — rejects a second call of a MID already pending or queued
});
```

---

## Complete Examples

### Basic Tightening Workflow

```javascript
const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:  '192.168.1.100',
  brand: 'atlas-copco'
});

nutrunner.on('connected',            () => console.log('✓ Connected'));
nutrunner.on('revisionNegotiated',   ({ revision }) => console.log(`✓ Rev ${revision} negotiated`));
nutrunner.on('revisionDowngrade',    ({ from, to }) => console.log(`  ↓ Rev ${from} → ${to}`));

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk, duration }) => {
  console.log(`${overallOk ? 'OK ✓' : 'NOK ✗'} in ${duration} ms`);
  results.forEach(r => console.log(`  Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°`));
});

nutrunner.on('linkEstablished', async () => {
  try {
    await nutrunner.selectJob(1);
    await nutrunner.enableTool();
  } catch (err) {
    console.error('Setup failed:', err.message);
  }
});

async function main() { await nutrunner.connect(); }
main().catch(console.error);
```

### VIN Traceability for Automotive Manufacturing

```javascript
const nutrunner = new OpenProtocolNutrunner({
  host:  '192.168.1.100',
  brand: 'atlas-copco'
});

nutrunner.on('vinDownloaded', ({ vin }) => console.log(`✓ VIN accepted by controller: ${vin}`));
nutrunner.on('vinLocked',     (vin)      => console.log(`🔒 VIN locked for this cycle: ${vin}`));

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  // VIN is embedded in every MID 0061 result — no need for getState()
  const vin = results[0]?.vin || nutrunner.getState().product.vin;
  console.log(`\nCycle ${overallOk ? 'OK ✓' : 'NOK ✗'}  VIN: ${vin}`);
  results.forEach(r =>
    console.log(`  Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°  id=${r.tighteningId}`)
  );
});

nutrunner.on('linkEstablished', async () => {
  await nutrunner.downloadVIN('1HGBH41JXMN109186'); // sets vinValid on ACK — await really waits
  await nutrunner.selectJob(101);
  await nutrunner.enableTool();
  console.log('✓ VIN downloaded — ready for tightening');
});

async function main() { await nutrunner.connect(); }
main().catch(console.error);
```

### Batch Manufacturing with Progress Tracking

```javascript
const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100', brand: 'atlas-copco' });

nutrunner.on('batchStarted',   (b) => console.log(`📦 Batch ${b.batchId} (size: ${b.size})`));
nutrunner.on('batchProgress',  ({ counter, size, remaining }) =>
  console.log(`  ${counter}/${size} — ${remaining} remaining`));
nutrunner.on('batchCompleted', (b) => console.log(`✓ Batch ${b.batchId} complete`));

nutrunner.on('linkEstablished', async () => {
  await nutrunner.selectJob(5);
  await nutrunner.enableTool();
});

async function main() { await nutrunner.connect(); }
main().catch(console.error);
```

### Alarm Handling and Recovery

```javascript
const nutrunner = new OpenProtocolNutrunner({
  host:          '192.168.1.100',
  brand:         'atlas-copco',
  autoReconnect: true
});

nutrunner.on('alarm', (alarm) => {
  console.error(`🚨 ALARM [${alarm.alarmCode}] at ${alarm.timestamp}`);
  if (['E001', 'E010'].includes(alarm.alarmCode)) {
    nutrunner.acknowledgeAlarm(); // fire-and-forget — safe to call without await
  }
});

nutrunner.on('alarmStatus', ({ alarmActive, alarmCode }) => {
  if (alarmActive) console.warn('  Active alarm:', alarmCode);
  else             console.log('✓ All alarms cleared');
});

async function main() { await nutrunner.connect(); }
main().catch(console.error);
```

### Multi-Controller Fleet Management

```javascript
// Each station can have a different brand/controller type
const STATIONS = [
  { id: 'Pune-Line-1', host: '192.168.1.101', brand: 'atlas-copco' },
  { id: 'Pune-Line-2', host: '192.168.1.102', brand: 'atlas-copco' },
  { id: 'Pune-Line-3', host: '192.168.1.103', brand: 'stanley'     },
  { id: 'Pune-Line-4', host: '192.168.1.104', brand: 'generic'     }  // unknown/third-party controller
];

STATIONS.forEach(({ id, host, brand }) => {
  const runner = new OpenProtocolNutrunner({ host, brand, autoReconnect: true });

  runner.on('revisionNegotiated', ({ revision }) =>
    console.log(`[${id}] Rev ${revision} negotiated`));

  runner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
    console.log(`[${id}] ${overallOk ? 'OK ✓' : 'NOK ✗'}`);
    results.forEach(r => console.log(`  Spindle ${r.spindle}: ${r.torque} Nm`));
  });

  runner.on('linkEstablished', async () => {
    await runner.selectJob(1);
    await runner.enableTool();
    console.log(`[${id}] Tool enabled`);
  });

  runner.connect().catch(() => console.error(`[${id}] Initial connection failed`));
});
```

### Error Recovery with InterlockError

```javascript
const { OpenProtocolNutrunner, InterlockError } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100', brand: 'atlas-copco', autoReconnect: true
});

nutrunner.on('revisionNegotiationFailed', ({ errorCode }) =>
  console.error(`Controller rejected all revision levels (errorCode: ${errorCode})`));

nutrunner.on('commandAborted', ({ mid }) =>
  console.warn(`  MID ${mid} aborted — connection closed mid-command`));

async function attemptTightening() {
  try {
    nutrunner.startTightening();
  } catch (err) {
    if (err instanceof InterlockError) {
      switch (err.code) {
        case 'TOOL_DISABLED':  await nutrunner.enableTool();  break;
        case 'JOB_NOT_ACTIVE': await nutrunner.selectJob(1); break;
        case 'ALARM_ACTIVE':   nutrunner.acknowledgeAlarm(); break;
        case 'VIN_REQUIRED':   console.log('Download VIN first'); break;
        default:                console.error('Manual intervention needed');
      }
    } else {
      console.error('Unexpected error:', err.message);
    }
  }
}

async function main() { await nutrunner.connect(); }
main().catch(console.error);
```

---

## Events Reference

### Connection Events

| Event | Payload | Description |
|---|---|---|
| `connected` | — | TCP socket connected |
| `disconnected` | — | TCP socket closed |
| `reconnecting` | `{ attempt, delay }` | Reconnect attempt scheduled |
| `linkEstablished` | `{ revision, cellId, channelId, controllerName, ... }` | MID 0002 received: handshake complete, with the controller info of that MID 0002 revision |
| `communicationRejected` | `{ errorCode, message }` | MID 0001 answered with MID 0004 (e.g. 96 client already connected) |
| `linkTimeout` | `{ reason }` | No answer to a command, keep-alive or link ACK in time; the connection is dropped (spec §3.3.5) |
| `linkError` | `{ mid, errorCode, message }` | MID 9998 link-level error from the controller |
| `error` | `Error` | Socket-level error |
| `frameError` | `{ type, buffer }` | Corrupt or malformed frame detected |

### Protocol Negotiation Events

| Event | Payload | Description |
|---|---|---|
| `revisionNegotiated` | `{ revision }` | Controller accepted MID 0061 subscription at this revision |
| `revisionDowngrade` | `{ from, to }` | Controller rejected revision; retrying at lower level |
| `revisionNegotiationFailed` | `{ errorCode, message }` | All revisions exhausted — controller rejected MID 0060 at every level |
| `midRevisionDowngrade` | `{ mid, from, to }` | Another subscription was rejected for its revision and is retried one lower |

### Tightening Events

| Event | Payload | Description |
|---|---|---|
| `tighteningCycleStarted` | `{ timestamp }` | First MID 0061 result of a new cycle received |
| `spindleResult` | result object | One MID 0061 result (fires once per result; each is ACKed with MID 0062 immediately) |
| `tighteningCycleCompleted` | `{ results, overallOk, duration }` | All spindles collected |
| `tighteningIncomplete` | `{ expected, received, results }` | Watchdog fired before all spindles arrived |
| `oldTighteningResult` | result object | MID 0065 reply to `requestOldTighteningResult()` (not counted toward the batch) |
| `toolData` | tool data object | MID 0041 reply to `requestToolData()` |

Result objects carry `revision` (the MID 0061 layout they were parsed with) plus the fields of that revision: rev 1 is tagged parameters 01-23, revs 2-10 are tagged parameters 01-74 (strategy, error status, rundown/current/self-tap/prevail values, pset name, torque unit, identifier parts, post-view torque, current in A, overall angle, peak torque, ...), rev 998 adds multistage stage results, rev 999 is the untagged light layout. Numeric fields the controller sends as spaces (not supported) are `null`. MID 0061 carries no spindle number, so `spindle` is always 1. Parameters newer than this library knows are returned in `unparsed`. A result that cannot be parsed is still acknowledged and reported through `parseError`.

### Results, Traces and Identifiers

| Event | Payload | Description |
|-------|---------|-------------|
| `operationResult` | `{ resultDataId, ok, objects[], fields, values, ... }` | MID 1201 overall data |
| `operationResultObject` | `{ objectId, fields, values, ... }` | MID 1202, one per object |
| `operationResultComplete` | MID 1201 data plus `objectData[]` | The 1201 and all its 1202 messages arrived |
| `trace` | `{ traceType, traceTypeName, samples[], values[], coefficient, resolutions[], ... }` | MID 0900. Samples are signed 16-bit big-endian (the spec does not state the byte order); `values` applies PID 02213/02214 |
| `tracePlotParameters` | `{ fields, values, ... }` | MID 0901 |
| `tighteningResultList` | `{ results: [{ index, startTime, ok }] }` | MID 0067 |
| `powerMacsResult` / `powerMacsBoltResult` | station / bolt data with `bolts[]`, `stepResults[]`, `specialValues[]` | MID 0106 / MID 0107 |
| `alarm` | `{ mid: 1000, alarmCode, alarmText, severity, fields, values }` | MID 1000 (same event as MID 0071) |
| `identifierResultParts` | `{ parts: [{ identifierType, includedInWorkOrder, status, resultPart }] }` | MID 0152 |
| `dynamicIdentifiers` | `{ formatType, fields, values }` | MID 1601 |
| `tighteningProgram` | `{ program: { nodeType, parameters, children } }` | MID 2501 |
| `programPasswordRequest` | — | MID 2502: answer with `sendProgramPassword()` |
| `modeIds` / `modeData` | modes / bolts | MID 2601 / MID 2603 |
| `toolList` / `toolGenericData` / `toolDataDownloadStatus` | tools / variable data | MID 0701 / 0702 / 0700 |
| `toolTagId` | `{ toolTagId, toolTagIdDecoded }` | MID 0262 |
| `motorTuningResult` | `{ motorTuneOk }` | MID 0501 |
| `jobLineControl` | `{ event: 'started' \| 'alert1' \| 'alert2' \| 'done' }` | MID 0121-0124 |
| `userData` | `{ userData, bytes }` | MID 0242 PLC user data (hex) |
| `selectorSocketInfo` | `{ mid, deviceId, sockets[] }` or variable data | MID 0251 / MID 1900 |
| `histogram` | `{ sigma, mean, classRange, bars[9] }` | MID 0301 |

### Command Events

| Event | Payload | Description |
|---|---|---|
| `commandAccepted` | `{ mid }` | MID 0005 received (ACK) |
| `commandSuccess` | `{ mid, cmdId, data }` | Promise resolved for a pending command |
| `commandFailed` | `{ mid, cmdId, data }` | Promise rejected — MID 0004 NAK received |
| `commandError` | `{ failedMid, errorCode, message }` | Controller returned error for a command |
| `commandTimeout` | `{ mid, cmdId }` | No answer within `commandTimeout` (default 10 s, spec §3.3.5); the connection is then dropped |
| `commandAborted` | `{ mid, cmdId }` | Pending command cancelled due to disconnection |

### VIN / Traceability Events

| Event | Payload | Description |
|---|---|---|
| `vinDownloaded` | `{ vin }` | MID 0050 ACK received — VIN accepted, `vinValid` set to `true` |
| `vin` | `{ vin, identifierPart2..4 }` | MID 0052: the controller's current VIN (subscribe with `subscribeVIN()`) |
| `vinLocked` | `vin` (string) | VIN locked for this tightening cycle |

### State Events

| Event | Payload | Description |
|---|---|---|
| `jobSelected` | `{ jobId }` | MID 0005 for MID 0038, or a new Job in MID 0035 |
| `jobInfo` | Job info | MID 0035 (subscribe with `subscribeJobInfo()`) |
| `parameterSetSelected` | pset info | MID 0015 (subscribe with `subscribeParameterSetSelection()`) |
| `batchStarted` | batch object | The parameter set batch reported in MID 0061 started |
| `batchProgress` | `{ counter, size, remaining }` | MID 0061 reported the controller's batch counter |
| `batchCompleted` | batch object | MID 0061 reported batch status OK |
| `lockAtBatchDone` | `{ relayStatus }` | MID 0022 |
| `batchResetConfirmed` | — | Batch counter reset (MID 0020 ACK) |
| `alarm` | `{ alarmCode, controllerReady, toolReady, timestamp, ... }` | MID 0071: an alarm appeared |
| `alarmAcknowledged` | `{ alarmCode }` | MID 0074: the alarm was acknowledged on the controller |
| `alarmStatus` | `{ alarmActive, alarmCode, controllerReady, toolReady, timestamp }` | MID 0076: alarm status after subscribing |
| `multiSpindleStatus` | status with `spindles[]` | MID 0091 |
| `multiSpindleCycleComplete` | result with `spindles[]` | MID 0101 |
| `digitalInputs` | `{ inputs }` | MID 0211: inputs 1-8 |
| `relayFunction` / `digitalInputFunction` | `{ function, active }` | MID 0217 / MID 0221 |
| `automaticManualMode` | `{ mode }` | MID 0401 |
| `commandsDisabled` | `{ commandsDisabled }` | MID 0421 |
| `toolPairingStatus` | `{ pairingStatus, timestamp }` | MID 0048 |
| `selectedMode` / `modeSelected` | `{ modeId, lastChange, numberOfBolts }` | MID 2604 |
| `mid` | `{ mid, revision, data }` | Every received MID, parsed or `{ raw }` |
| `spindleCountUpdated` | `{ count, source }` | Spindle count auto-detected from MID 0061 or 0101 |
| `stateChanged` | full state snapshot | Emitted after every state mutation |

---

## Safety Interlocks

`startTightening()` enforces full pre-flight checks before commanding the controller:

```javascript
try {
  nutrunner.startTightening();
} catch (err) {
  if (err instanceof InterlockError) {
    console.log(`Interlock: ${err.code} — ${err.message}`);
  }
}
```

| Code | Condition |
|---|---|
| `NOT_CONNECTED` | TCP connection not established |
| `LINK_NOT_READY` | Open Protocol handshake not complete |
| `TOOL_DISABLED` | Tool not enabled via `enableTool()` (set when the controller ACKs MID 0043) |
| `TOOL_RUNNING` | Tightening already in progress |
| `CTRL_NOT_READY` | Controller has not answered MID 0001 with MID 0002 |
| `ALARM_ACTIVE` | Active alarm must be acknowledged first |
| `VIN_REQUIRED` | `state.product.vinRequired` is set (by your application) and no VIN is valid yet |
| `JOB_NOT_ACTIVE` | No job selected |

---

## API Reference

### Connection

```javascript
await nutrunner.connect()     // Connect and send MID 0001
nutrunner.disconnect()         // Send MID 0003 Communication stop and close socket
nutrunner.isConnected()        // → boolean
nutrunner.isReady()            // → boolean (connected + link ready + no alarms)
```

### Message flow (Open Protocol R2.16.0)

- Only one request, command or subscription is outstanding at a time (spec §3.2.1). Calls made while one is in flight are queued and sent in order; each promise settles on its own MID 0005, reply MID or MID 0004.
- Every subscription push is acknowledged with its spec ACK MID (0016, 0023, 0036, 0053, 0062, 0072, 0075, 0077, 0092, 0102, 0212, 0218, 0222, 0402, 0422, ...) before it is parsed.
- With `linkLevelAck: true` the client starts with MID 0001 revision 6. If MID 0002 reports sequence-number support, messages carry header sequence numbers and are acknowledged with MID 9997/9998 instead (spec §3.2.2).
- `communicationRevision` (default 1) is the MID 0001/0002 revision; it steps down automatically on MID 0004 error 97.
- Multi-part (linked) messages are reassembled before parsing. Sending is limited to one part (9979 data bytes).
- Variable data fields (spec chapter 6: PID, length, data type, unit, step, value) are parsed into `fields[]` and a `values` map keyed by PID (`'02001'`, or `'02001.3'` for step 3). `encodeVariableFields()` builds them for MIDs 0703, 1901, 2100, 2500 and 2505.
- No answer within `commandTimeout` (default 10 s) to a command, keep-alive or link ACK drops the connection, and `autoReconnect` re-establishes it (spec §3.3.5).

### Commands (all return Promises — truly await the controller ACK)

```javascript
await nutrunner.selectJob(jobId)               // MID 0038 (rev 1: 2 digits, rev 2 for IDs > 99)
await nutrunner.restartJob(jobId)              // MID 0039
await nutrunner.abortJob()                     // MID 0127
await nutrunner.incrementJobBatch()            // MID 0128 (alias skipBolt)
await nutrunner.decrementJobBatch()            // MID 0129 (alias decrementBatch); { channelId, paramSetId } → rev 2
await nutrunner.setJobOff(true)                // MID 0130
await nutrunner.downloadVIN(vin)               // MID 0050 — sets vinValid on ACK
await nutrunner.selectParameterSet(paramSetId) // MID 0018
await nutrunner.setBatchSize(paramSetId, size) // MID 0019 (rev 2 for sizes > 99)
await nutrunner.resetBatch(paramSetId)         // MID 0020 (default: the selected parameter set)
await nutrunner.enableTool()                   // MID 0043; { toolNumber } → rev 2
await nutrunner.disableTool()                  // MID 0042; { toolNumber, type } → rev 2
await nutrunner.startTightening()              // Interlocks enforced, then MID 0043 (OP has no start command)
await nutrunner.requestToolDisconnect()        // MID 0044
await nutrunner.setCalibrationValue(35.5)      // MID 0045; { unit, channel }
await nutrunner.setPrimaryTool(1)              // MID 0046
await nutrunner.toolPairing(1)                 // MID 0047 → MID 0048 'toolPairingStatus'
await nutrunner.setTime(new Date())            // MID 0082
await nutrunner.setRelays([0, 1, 2, 3])        // MID 0200 (0 off, 1 on, 2 flash, 3 keep)
await nutrunner.setDigitalInputFunction(fn)    // MID 0224 / resetDigitalInputFunction MID 0225
await nutrunner.flashGreenLight()              // MID 0113
await nutrunner.acknowledgeAlarm()             // MID 0078
await nutrunner.downloadIdentifier(text)       // MID 0150 (max 100 chars)
await nutrunner.bypassIdentifier()             // MID 0155 / resetLatestIdentifier 0156 / resetAllIdentifiers 0157
await nutrunner.selectParameterSetDynamicJob(p)// MID 2504
await nutrunner.selectParameterSetDynamically(p, fields) // MID 2505
await nutrunner.selectMode(modeId)             // MID 2606
await nutrunner.downloadTighteningProgram(tree, rev) // MID 2500; tree = { nodeType, parameters, children, json }
nutrunner.sendProgramPassword(pw)              // MID 2503 answer to 'programPasswordRequest' (MID 2502)
await nutrunner.setCalibrationValueGeneric(tool, fields) // MID 0703
await nutrunner.sendExternalToolTag(hex8, 1)   // MID 0265
await nutrunner.requestMotorTuning()           // MID 0504
await nutrunner.displayUserTextCompact('OK')   // MID 0110
await nutrunner.displayUserTextGraph(lines, { duration, acknowledge }) // MID 0111
await nutrunner.setJobLineControlStart()       // MID 0131 / setJobLineAlert1 0132 / setJobLineAlert2 0133
await nutrunner.executeDynamicJob(job, rev)    // MID 0140 (rev 1-4, 999)
await nutrunner.userDataDownload(hex)          // MID 0240 / userDataDownloadWithOffset(offset, hex) MID 0245
await nutrunner.setSelectorGreenLights(dev, cmds) // MID 0254 / setSelectorRedLights MID 0255
await nutrunner.selectorSocketControl(fields)  // MID 1901
await nutrunner.rebootController()             // MID 0270
await nutrunner.deviceCommand(id, fields)      // MID 2100 (0001 reboot, 0002/0003 standby)
```

### Data Requests (resolve with the parsed reply)

```javascript
await nutrunner.requestParameterSetIds()                 // MID 0010 → MID 0011
await nutrunner.requestParameterSetData(paramSetId)      // MID 0012 → MID 0013
await nutrunner.requestJobIds()                          // MID 0030 → MID 0031
await nutrunner.requestJobData(jobId)                    // MID 0032 → MID 0033
await nutrunner.requestToolData()                        // MID 0040 → MID 0041
await nutrunner.requestOldTighteningResult(tighteningId) // MID 0064 → MID 0065 (0 = latest; { offline } → rev 10)
await nutrunner.readTime()                               // MID 0080 → MID 0081
await nutrunner.requestIoDeviceStatus(device)            // MID 0214 → MID 0215
await nutrunner.requestAutoDisableSettings()             // MID 0410 → MID 0411
await nutrunner.requestHistogram(paramSetId, type)       // MID 0300 → MID 0301
await nutrunner.requestToolTagId()                       // MID 0260 → MID 0262
await nutrunner.requestModeIds()                         // MID 2600 → MID 2601
await nutrunner.requestModeData(modeId)                  // MID 2602 → MID 2603
await nutrunner.requestOperationResult(index)            // MID 0006 → MID 1201 (+ MID 1202s)
await nutrunner.requestTighteningResultList(start, n)    // MID 0006 → MID 0067
await nutrunner.requestTrace(index, traceType, tool)     // MID 0006 → MID 0900
await nutrunner.requestTracePlotParameters(index, type)  // MID 0006 → MID 0901
await nutrunner.requestTighteningProgram(id, nodeType)   // MID 0006 → MID 2501
await nutrunner.requestToolList()                        // MID 0006 → MID 0701
await nutrunner.requestToolGenericData(toolNumber)       // MID 0006 → MID 0702
await nutrunner.requestData(mid, revision, extraData)    // MID 0006 generic request → that MID
```

### Subscriptions

```javascript
// Tightening results and alarms are subscribed automatically after linkEstablished
nutrunner.subscribeTighteningResults()       // MID 0060 → 0061 (ACK 0062); starts at maxRevision, auto-downgrades
nutrunner.subscribeAlarms()                  // MID 0070 → 0071/0074/0076 (ACK 0072/0075/0077)
nutrunner.subscribeParameterSetSelection(2)  // MID 0014 → 0015 (ACK 0016)
nutrunner.subscribeLockAtBatchDone()         // MID 0021 → 0022 (ACK 0023)
nutrunner.subscribeJobInfo(5)                // MID 0034 → 0035 (ACK 0036)
nutrunner.subscribeVIN(2)                    // MID 0051 → 0052 (ACK 0053)
nutrunner.subscribeMultiSpindleStatus()      // MID 0090 → 0091 (ACK 0092)
nutrunner.subscribeMultiSpindleResults(5, { onlyNew: true }) // MID 0100 → 0101 (ACK 0102)
nutrunner.subscribeDigitalInputs()           // MID 0210 → 0211 (ACK 0212)
nutrunner.subscribeRelayFunction(fn)         // MID 0216 → 0217 (ACK 0218)
nutrunner.subscribeDigitalInputFunction(fn)  // MID 0220 → 0221 (ACK 0222)
nutrunner.subscribeAutomaticManualMode()     // MID 0400 → 0401 (ACK 0402)
nutrunner.subscribeCommandsDisabled()        // MID 0420 → 0421 (ACK 0422)
nutrunner.subscribePowerMacsResults(4, { onlyNew: true }) // MID 0105 → 0106/0107 (ACK 0108)
nutrunner.subscribeJobLineControl()          // MID 0120 → 0121-0124 (ACK 0125)
nutrunner.subscribeIdentifierResultParts()   // MID 0151 → 0152 (ACK 0153)
nutrunner.subscribeUserData()                // MID 0241 → 0242 (ACK 0243)
nutrunner.subscribeSelectorSocketInfo()      // MID 0250 → 0251 (ACK 0252)
nutrunner.subscribeToolTagId()               // MID 0261 → 0262 (ACK 0263)
nutrunner.subscribeMotorTuning()             // MID 0500 → 0501 (ACK 0502)
// MID 0008 subscriptions:
nutrunner.subscribeOperationResults({ sendObjectData: true }) // → 1201 + 1202 (ACK 1203)
nutrunner.subscribeTraces([1, 2])            // → 0900 trace curves (ACK 0005)
nutrunner.subscribeTracePlotParameters()     // → 0901 (ACK 0005)
nutrunner.subscribeAlarmsV2()                // → 1000 (ACK 1001)
nutrunner.subscribeDynamicIdentifiers({ sendAlternative: 2, pids: [60] }) // → 1601 (ACK 1602)
nutrunner.subscribeTighteningPrograms(id, nodeType) // → 2501 (ACK 0005)
nutrunner.subscribeModeSelected()            // → 2604 (ACK 2605)
nutrunner.subscribeToolDataDownloadStatus()  // → 0700 (ACK 0005)
nutrunner.subscribeSelectorSocketInfoV2()    // → 1900 (ACK 0005)
nutrunner.subscribe(mid, revision, extra)    // MID 0008 generic subscription
// each has a matching unsubscribe…() (MID 0063, 0073, 0017, 0024, 0037, 0054, 0093, 0103, 0109, 0126,
// 0154, 0213, 0219, 0223, 0244, 0253, 0264, 0403, 0423, 0503, 0009)
```

### Configuration & State

```javascript
nutrunner.setSpindleCount(count)  // Manually override spindle count (1–99)
nutrunner.getSpindleCount()       // → { count, source }
nutrunner.getState()              // → deep-cloned state snapshot (Maps serialised as arrays)
```

---

## Integration Examples

### OPC UA Server Bridge

```javascript
const { OPCUAServer, Variant, DataType } = require('node-opcua');

const opcuaServer = new OPCUAServer({ port: 4840 });
await opcuaServer.initialize();

const namespace = opcuaServer.engine.addressSpace.getOwnNamespace();
const lastTorqueVar = namespace.addVariable({
  browseName: 'LastTorque',
  dataType: 'Double',
  value: { dataType: DataType.Double, value: 0.0 }
});

nutrunner.on('tighteningCycleCompleted', ({ results }) => {
  lastTorqueVar.setValueFromSource({
    dataType: DataType.Double,
    value: results[0].torque
  });
});

await opcuaServer.start();
await nutrunner.connect();
```

### InfluxDB Time-Series Storage

```javascript
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const writeApi = new InfluxDB({ url: 'http://localhost:8086', token: 'YOUR_TOKEN' })
  .getWriteApi('org', 'manufacturing');

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  results.forEach(r => {
    writeApi.writePoint(new Point('tightening')
      .tag('spindle', r.spindle.toString())
      .tag('vin', r.vin || 'unknown')
      .floatField('torque', r.torque)
      .intField('angle', r.angle)
      .booleanField('ok', r.ok));
  });
  writeApi.flush();
});
```

### MQTT Gateway for IIoT

```javascript
const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://localhost:1883');

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  client.publish('factory/station1/tightening', JSON.stringify({
    timestamp: new Date().toISOString(),
    ok:        overallOk,
    vin:       results[0]?.vin,
    results
  }));
});
```

---

## Project Structure

```
node-nutrunner-open-library/
├── index.js                          # Main library
├── examples/
│   ├── 01-basic-tightening.js        # Simple tightening workflow
│   ├── 02-vin-traceability.js        # Automotive VIN tracking
│   ├── 03-batch-manufacturing.js     # Batch production
│   ├── 04-alarm-handling.js          # Alarm management
│   ├── 05-fleet-management.js        # Multi-controller / multi-brand
│   ├── 06-influxdb-integration.js    # Time-series database
│   ├── 07-opcua-bridge.js            # OPC UA server bridge
│   └── 08-error-recovery.js          # Error handling patterns
├── LICENSE
├── README.md
├── CHANGELOG.md
└── package.json
```

---

## Troubleshooting

### VIN Shows as `null` in Results
The library syncs VIN from the MID 0061 payload on every result. Read it from `results[0].vin`:
```javascript
nutrunner.on('tighteningCycleCompleted', ({ results }) => {
  const vin = results[0]?.vin || nutrunner.getState().product.vin || 'N/A';
});
```

### Controller Rejects Revision 4
The library automatically downgrades. Watch these events for diagnostics:
```javascript
nutrunner.on('revisionDowngrade',        ({ from, to }) => console.log(`Rev ${from} → ${to}`));
nutrunner.on('revisionNegotiated',       ({ revision }) => console.log(`Locked at Rev ${revision}`));
nutrunner.on('revisionNegotiationFailed', () =>           console.error('All revisions rejected'));
```

### `await enableTool()` Returns Immediately Without Waiting
Update to **v1.1.0** or later. Earlier versions returned a command ID number immediately; v1.1.0+ returns a real Promise that resolves on MID 0005 ACK.

### Commands Fail After Reconnect
Set `autoReconnect: true` and listen for `linkEstablished` to re-run setup:
```javascript
nutrunner.on('linkEstablished', async () => {
  await nutrunner.selectJob(1);
  await nutrunner.enableTool();
});
```

### Frame Validation Errors
```javascript
nutrunner.on('frameError', ({ type }) => console.error(`Frame error: ${type}`));
// Library auto-recovers by advancing the buffer pointer
```

### Legacy Controllers Without MID 101
```javascript
const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100', brand: 'atlas-copco', spindleCount: 2
});
```

---

## Known Controller Quirks

### Unknown or Third-Party Controllers
Use `brand: 'generic'` for any controller not in the supported list. This uses the official Open Protocol specification defaults (Job=MID 0038, Enable=MID 0043, Rev4). If the controller is based on the Atlas Copco spec, `'generic'` will work without knowing the manufacturer.

### PowerFocus 3000
Some units send **MID 0002** instead of MID 0003 for the comm-start ACK — handled automatically.

### Controllers Without MID 0051 (VIN Download Reply)
Many controllers ACK the VIN download with a generic MID 0005 instead of MID 0051. The library handles this correctly since v1.0.7 — `vinValid` is set on the MID 0005 ACK and VIN is synced from every MID 0061 result payload.

### Revision Support Varies by Firmware
Use `brand` to set the correct `maxRevision` for your controller family. Use `maxRevision` constructor option to override if your controller's firmware version differs from the brand default.

---

## License

**Apache License 2.0**

Copyright (c) 2026 Bufferstack.IO Analytics Technology LLP  
Copyright (c) 2026 Harshad Joshi

---

## Acknowledgments

Developed for real manufacturing environments in **Pune, India**. Tested across automotive assembly lines, aerospace component manufacturing, and heavy equipment production.

**Protocol Reference:** Atlas Copco Open Protocol Specification v2.xx+

---

## Contributing

Contributions welcome! Areas needing help:
- Additional MID implementations (parameter sets, multi-stage, graphs/curves)
- TypeScript type definitions
- Controller-specific quirks documentation
- More integration examples (PostgreSQL, Kafka, MTConnect)

---

## Support

- 🐛 [Report Issues](https://github.com/hj91/node-nutrunner-open-library/issues)
- 💬 [Discussions](https://github.com/hj91/node-nutrunner-open-library/discussions)
- 📧 harshad@bufferstack.io

---

**Made with ❤️ for the industrial automation community**

*Tested in production since 2026 | Zero dependencies | Production-grade reliability*
