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
| **Stanley Assembly Technologies** | Open Protocol compatible | `stanley` | Job=0034, Enable=0043, Rev2 |
| **Desoutter** | CVI controllers | `desoutter` | Job=0038, Enable=0043, Rev4 |
| **Ingersoll Rand** | QX Series | `ingersoll-rand` | Job=0034, Enable=0043, Rev2 |

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

  // ── Hardware ──────────────────────────────────────────────────────────────
  spindleCount:          null,   // Manual override for controllers without MID 101
  allowDuplicateCommands: false  // Default: false — enforces one-per-MID safety
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
  console.error(`🚨 ALARM [${alarm.alarmCode}]: ${alarm.message}`);
  if (['E001', 'E010'].includes(alarm.alarmCode)) {
    nutrunner.acknowledgeAlarm(); // fire-and-forget — safe to call without await
  }
});

nutrunner.on('alarmStatus', ({ alarmStatus, currentAlarms }) => {
  if (alarmStatus) console.warn('  Active alarms:', currentAlarms.join(', '));
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
| `linkEstablished` | `{ revision }` | Open Protocol handshake complete (MID 0003 received) |
| `error` | `Error` | Socket-level error |
| `frameError` | `{ type, buffer }` | Corrupt or malformed frame detected |

### Protocol Negotiation Events

| Event | Payload | Description |
|---|---|---|
| `revisionNegotiated` | `{ revision }` | Controller accepted MID 0061 subscription at this revision |
| `revisionDowngrade` | `{ from, to }` | Controller rejected revision; retrying at lower level |
| `revisionNegotiationFailed` | `{ errorCode, message }` | All revisions exhausted — controller rejected MID 0060 at every level |

### Tightening Events

| Event | Payload | Description |
|---|---|---|
| `tighteningCycleStarted` | `{ timestamp }` | Tool running signal detected |
| `spindleResult` | result object | Individual spindle result (fires once per spindle) |
| `tighteningCycleCompleted` | `{ results, overallOk, duration }` | All spindles collected |
| `tighteningIncomplete` | `{ expected, received, results }` | Watchdog fired before all spindles arrived |

### Command Events

| Event | Payload | Description |
|---|---|---|
| `commandAccepted` | `{ mid }` | MID 0005 received (ACK) |
| `commandSuccess` | `{ mid, cmdId, data }` | Promise resolved for a pending command |
| `commandFailed` | `{ mid, cmdId, data }` | Promise rejected — MID 0004 NAK received |
| `commandError` | `{ failedMid, errorCode, message }` | Controller returned error for a command |
| `commandTimeout` | `{ mid, cmdId }` | No ACK received within 5 s |
| `commandAborted` | `{ mid, cmdId }` | Pending command cancelled due to disconnection |

### VIN / Traceability Events

| Event | Payload | Description |
|---|---|---|
| `vinDownloaded` | `{ vin }` | MID 0050 ACK received — VIN accepted, `vinValid` set to `true` |
| `vinRequired` | — | Controller sent MID 0052 — VIN must be downloaded before tightening |
| `vinLocked` | `vin` (string) | VIN locked for this tightening cycle |

### State Events

| Event | Payload | Description |
|---|---|---|
| `jobSelected` | `{ jobId }` | Controller confirmed job selection |
| `batchStarted` | batch object | New batch cycle started |
| `batchProgress` | `{ counter, size, remaining }` | Tightening incremented the batch counter |
| `batchCompleted` | batch object | Batch counter reached batch size |
| `batchResetConfirmed` | — | Batch counter reset (MID 0020 ACK) |
| `alarm` | alarm object | Controller alarm raised |
| `alarmStatus` | `{ alarmStatus, currentAlarms }` | Alarm state changed |
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
| `TOOL_DISABLED` | Tool not enabled via `enableTool()` |
| `TOOL_RUNNING` | Tightening already in progress |
| `CTRL_NOT_READY` | Controller not ready (MID 0041 flag) |
| `ALARM_ACTIVE` | Active alarm must be acknowledged first |
| `VIN_REQUIRED` | VIN required by controller but not yet downloaded |
| `JOB_NOT_ACTIVE` | No job selected |

---

## API Reference

### Connection

```javascript
await nutrunner.connect()     // Connect and send MID 0001
nutrunner.disconnect()         // Send MID 0002 and close socket
nutrunner.isConnected()        // → boolean
nutrunner.isReady()            // → boolean (connected + link ready + no alarms)
```

### Commands (all return Promises — truly await the controller ACK)

```javascript
await nutrunner.selectJob(jobId)               // MID 0038 or brand-specific MID
await nutrunner.downloadVIN(vin)               // MID 0050 — sets vinValid on ACK
await nutrunner.selectParameterSet(paramSetId) // MID 0018
await nutrunner.enableTool()                   // MID 0043 or brand-specific MID
await nutrunner.disableTool()                  // MID 0042 or brand-specific MID
await nutrunner.startTightening()              // Interlocks enforced — throws InterlockError
await nutrunner.resetBatch()                   // MID 0020
await nutrunner.decrementBatch()               // MID 0021
```

### Subscriptions

```javascript
// Called automatically after linkEstablished — manual calls rarely needed
nutrunner.subscribeTighteningResults()    // MID 0060 — starts at maxRevision, auto-downgrades
nutrunner.unsubscribeTighteningResults()  // MID 0063
nutrunner.subscribeAlarms()               // MID 0070
nutrunner.unsubscribeAlarms()             // MID 0073
nutrunner.acknowledgeAlarm()              // MID 0078 — fire-and-forget (no await needed)
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
