
# node-nutrunner-open-library

[![npm version](https://badge.fury.io/js/node-nutrunner-open-library.svg)](https://www.npmjs.com/package/node-nutrunner-open-library)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js Version](https://img.shields.io/node/v/node-nutrunner-open-library.svg)](https://nodejs.org)

Production-grade **Atlas Copco Open Protocol** client for Node.js. Built for real manufacturing environments with robust error recovery, automatic reconnection, and comprehensive industrial safety interlocks.

Designed and tested in actual automotive and aerospace assembly lines in Pune, India.

---

## Features

- ✅ **Full Open Protocol Support** - MID 0001-0101 (Specification 2.8.0+)
- ✅ **Production-Hardened** - Handles TCP fragmentation, network glitches, firmware variations
- ✅ **Automatic Reconnection** - Exponential backoff with state recovery
- ✅ **Safety Interlocks** - Enforces controller-side safety rules (VIN, job, alarms)
- ✅ **Multi-Spindle Tools** - Auto-detection from MID 0061/0101
- ✅ **VIN Traceability** - Automotive-grade part tracking and locking
- ✅ **Batch Manufacturing** - Real-time progress tracking and completion events
- ✅ **Alarm Handling** - Subscribe, acknowledge, and recover from controller alarms
- ✅ **Command Safety** - One-per-MID enforcement prevents state corruption
- ✅ **Event-Driven API** - Perfect for OPC UA, MQTT, MES integration
- ✅ **Zero Dependencies** - Uses only Node.js core modules

---

##  Installation

```bash
npm install node-nutrunner-open-library
```

**Requirements:** Node.js >= 14.0.0

---

##  Quick Start

```javascript
const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100',
  port: 4545,
  autoReconnect: true
});

// Handle tightening results
nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  console.log(`Tightening ${overallOk ? 'OK' : 'NOK'}`);
  results.forEach(r => {
    console.log(`Spindle ${r.spindle}: ${r.torque} Nm, ${r.angle}°`);
  });
});

// Connect and setup
await nutrunner.connect();
await nutrunner.selectJob(123);
await nutrunner.enableTool();

console.log('Ready for tightening!');
```

---

##  Supported Controllers

| Manufacturer | Models | Status |
|--------------|--------|--------|
| **Atlas Copco** | PowerFocus 4000/6000, PowerMACS | ✅ Tested |
| **Stanley Assembly Technologies** | Open Protocol compatible | ✅ Tested |
| **Desoutter** | CVI controllers | ✅ Tested |
| **Ingersoll Rand** | QX Series | ✅ Compatible |

---

##  Complete Examples

### Basic Tightening Workflow
```javascript
const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100'
});

nutrunner.on('connected', () => {
  console.log('✓ Connected to controller');
});

nutrunner.on('tighteningCycleStarted', () => {
  console.log('⚙ Tightening started...');
});

nutrunner.on('spindleResult', (result) => {
  console.log(`Spindle ${result.spindle}: ${result.ok ? '✓' : '✗'}`);
  console.log(`  Torque: ${result.torque} Nm`);
  console.log(`  Angle: ${result.angle}°`);
});

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk, duration }) => {
  console.log(`${overallOk ? '✓' : '✗'} Completed in ${duration}ms`);
});

await nutrunner.connect();
```

### VIN Traceability for Automotive Manufacturing
```javascript
const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100',
  spindleCount: 2 // Multi-spindle tool
});

nutrunner.on('linkEstablished', async () => {
  // Download VIN for current product
  await nutrunner.downloadVIN('1HGBH41JXMN109186');
  await nutrunner.selectJob(101);
  await nutrunner.enableTool();
  console.log('✓ VIN downloaded - ready for tightening');
});

nutrunner.on('vinLocked', (vin) => {
  console.log(`🔒 VIN locked for traceability: ${vin}`);
});

nutrunner.on('tighteningCycleCompleted', ({ results }) => {
  const record = {
    vin: nutrunner.getState().product.vin,
    timestamp: new Date().toISOString(),
    results: results
  };
  
  // Save to database for traceability
  saveToDatabase(record);
});

await nutrunner.connect();
```

### Batch Manufacturing with Progress Tracking
```javascript
const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100'
});

nutrunner.on('batchStarted', (batch) => {
  console.log(`📦 Batch ${batch.batchId} started (Size: ${batch.size})`);
});

nutrunner.on('batchProgress', ({ counter, size, remaining }) => {
  const percent = Math.round((counter / size) * 100);
  console.log(`Progress: ${counter}/${size} (${percent}%) - ${remaining} remaining`);
});

nutrunner.on('batchCompleted', (batch) => {
  console.log(`✓ Batch ${batch.batchId} completed!`);
});

await nutrunner.connect();
await nutrunner.selectJob(5); // Job configured with batch size
await nutrunner.enableTool();
```

### Alarm Handling and Recovery
```javascript
const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100'
});

nutrunner.on('alarm', (alarm) => {
  console.error(`🚨 ALARM: [${alarm.alarmCode}] ${alarm.message}`);
  
  // Auto-acknowledge specific alarms
  if (shouldAutoAcknowledge(alarm.alarmCode)) {
    setTimeout(() => {
      nutrunner.acknowledgeAlarm();
    }, 2000);
  }
});

nutrunner.on('alarmStatus', ({ alarmStatus }) => {
  if (!alarmStatus) {
    console.log('✓ All alarms cleared - system ready');
  }
});

function shouldAutoAcknowledge(code) {
  const autoAckCodes = ['0001', '0010', '0015'];
  return autoAckCodes.includes(code);
}

await nutrunner.connect();
```

### Multi-Controller Fleet Management
```javascript
const fleet = [
  { id: 'Station-A', host: '192.168.1.100' },
  { id: 'Station-B', host: '192.168.1.101' },
  { id: 'Station-C', host: '192.168.1.102' }
];

const controllers = fleet.map(config => {
  const nutrunner = new OpenProtocolNutrunner(config);
  
  nutrunner.on('tighteningCycleCompleted', ({ overallOk }) => {
    console.log(`[${config.id}] Tightening ${overallOk ? 'OK' : 'NOK'}`);
  });
  
  return { id: config.id, nutrunner };
});

// Connect all controllers
await Promise.all(controllers.map(c => c.nutrunner.connect()));

// Setup all stations
for (const { id, nutrunner } of controllers) {
  await nutrunner.selectJob(100);
  await nutrunner.enableTool();
  console.log(`[${id}] Ready`);
}
```

---

##  Constructor Options

```javascript
const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100',           // Required: Controller IP address
  port: 4545,                       // Default: 4545
  autoReconnect: true,              // Default: true (exponential backoff)
  validateFrames: true,             // Default: true (frame corruption detection)
  spindleCount: null,               // Override for controllers without MID 101
  allowDuplicateCommands: false     // Default: false (enforces command safety)
});
```

---

##  Events Reference

### Connection Events
- **`connected`** - TCP connection established
- **`disconnected`** - Connection lost
- **`reconnecting`** - Reconnection attempt in progress (emits `{ attempt, delay }`)
- **`linkEstablished`** - Open Protocol handshake complete (emits `{ revision }`)

### Tightening Events
- **`tighteningCycleStarted`** - Tool running detected (emits `{ timestamp }`)
- **`spindleResult`** - Individual spindle result received (emits result object)
- **`tighteningCycleCompleted`** - All spindles completed (emits `{ results, overallOk, duration }`)
- **`tighteningIncomplete`** - Watchdog timeout (emits `{ expected, received, results }`)

### Command Events
- **`commandAccepted`** - MID 0005 received (emits `{ mid }`)
- **`commandError`** - MID 0004 received (emits `{ failedMid, errorCode, message }`)
- **`commandTimeout`** - No response within 5s (emits `{ mid, cmdId }`)

### State Events
- **`jobSelected`** - Job activated (emits `{ jobId }`)
- **`vinLocked`** - VIN locked for traceability (emits VIN string)
- **`batchStarted`** - Batch production started (emits batch object)
- **`batchProgress`** - Batch counter updated (emits `{ counter, size, remaining }`)
- **`batchCompleted`** - Batch size reached (emits batch object)
- **`alarm`** - Controller alarm raised (emits alarm object)
- **`alarmStatus`** - Alarm state changed (emits `{ alarmStatus, currentAlarms }`)
- **`stateChanged`** - Any state change (emits full state snapshot)

---

## 🛡️ Safety Interlocks

The library enforces industrial safety interlocks before allowing tightening operations:

```javascript
try {
  nutrunner.startTightening();
} catch (err) {
  if (err instanceof InterlockError) {
    console.log(`Interlock: ${err.code} - ${err.message}`);
  }
}
```

**Interlock Error Codes:**
- `NOT_CONNECTED` - No TCP connection to controller
- `LINK_NOT_READY` - Protocol handshake not complete
- `TOOL_DISABLED` - Tool not enabled (send MID 0042)
- `TOOL_RUNNING` - Tightening already in progress
- `CTRL_NOT_READY` - Controller not ready
- `ALARM_ACTIVE` - Active alarm must be acknowledged
- `VIN_REQUIRED` - VIN required but not downloaded
- `JOB_NOT_ACTIVE` - No job selected

---

## 🔄 Available Methods

### Connection
```javascript
await nutrunner.connect()           // Connect to controller
nutrunner.disconnect()               // Disconnect gracefully
nutrunner.isConnected()              // Check connection status
nutrunner.isReady()                  // Check if ready for tightening
```

### Commands
```javascript
await nutrunner.selectJob(jobId)                    // Select job by ID
await nutrunner.downloadVIN(vin)                    // Download VIN (max 25 chars)
await nutrunner.selectParameterSet(paramSetId)      // Select parameter set
await nutrunner.enableTool()                        // Enable tool
await nutrunner.disableTool()                       // Disable tool
await nutrunner.startTightening()                   // Start tightening (interlocks enforced)
await nutrunner.resetBatch()                        // Reset batch counter
await nutrunner.decrementBatch()                    // Decrement batch counter
```

### Subscriptions
```javascript
nutrunner.subscribeTighteningResults()    // Subscribe to MID 0061
nutrunner.unsubscribeTighteningResults()  // Unsubscribe from MID 0061
nutrunner.subscribeAlarms()               // Subscribe to MID 0070
nutrunner.unsubscribeAlarms()             // Unsubscribe from MID 0070
nutrunner.acknowledgeAlarm()              // Acknowledge active alarm
```

### Configuration
```javascript
nutrunner.setSpindleCount(count)     // Manually set spindle count
nutrunner.getSpindleCount()          // Get spindle count and source
nutrunner.getState()                 // Get full state snapshot
```

---

##  Integration Examples

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
    value: results.torque
  });
});

await opcuaServer.start();
await nutrunner.connect();
```

### InfluxDB Time-Series Storage
```javascript
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const influx = new InfluxDB({ url: 'http://localhost:8086', token: 'your-token' });
const writeApi = influx.getWriteApi('org', 'manufacturing');

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  results.forEach(r => {
    const point = new Point('tightening')
      .tag('spindle', r.spindle.toString())
      .floatField('torque', r.torque)
      .intField('angle', r.angle)
      .booleanField('ok', r.ok);
    
    writeApi.writePoint(point);
  });
  
  writeApi.flush();
});

await nutrunner.connect();
```

### MQTT Gateway for IIoT
```javascript
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    ok: overallOk,
    results: results
  });
  
  client.publish('factory/station1/tightening', payload);
});

await nutrunner.connect();
```

---

##  Project Structure

```
node-nutrunner-open-library/
├── index.js                          # Main library (production-grade)
├── examples/
│   ├── 01-basic-tightening.js        # Simple tightening workflow
│   ├── 02-vin-traceability.js        # Automotive VIN tracking
│   ├── 03-batch-manufacturing.js     # Batch production
│   ├── 04-alarm-handling.js          # Alarm management
│   ├── 05-fleet-management.js        # Multi-controller setup
│   ├── 06-influxdb-integration.js    # Time-series database
│   ├── 07-opcua-bridge.js            # OPC UA server bridge
│   └── 08-error-recovery.js          # Error handling patterns
├── LICENSE                           # Apache 2.0
├── README.md                         # This file
├── CHANGELOG.md                      # Version history
└── package.json
```

---

##  Troubleshooting

### Connection Issues
```javascript
nutrunner.on('error', (err) => {
  console.error('Connection error:', err.message);
});

nutrunner.on('reconnecting', ({ attempt, delay }) => {
  console.log(`Reconnection attempt ${attempt} in ${delay}ms...`);
});
```

### Frame Validation Errors
```javascript
nutrunner.on('frameError', ({ type, buffer }) => {
  console.error(`Frame error: ${type}`);
  // Network corruption detected - library auto-recovers
});
```

### Command Timeouts
```javascript
nutrunner.on('commandTimeout', ({ mid, cmdId }) => {
  console.error(`Command MID ${mid} timed out (ID: ${cmdId})`);
});
```

### Watchdog Timeouts (Missing Spindle Results)
```javascript
nutrunner.on('tighteningIncomplete', ({ expected, received }) => {
  console.error(`Watchdog: Expected ${expected} spindles, got ${received}`);
  // Check controller configuration and network stability
});
```

---

##  Known Controller Quirks

### PowerFocus 3000
- Some units send **MID 0002** instead of MID 0003 for comm start ACK (handled automatically)

### Legacy Controllers
- Controllers without MID 0101 support require manual spindle count:
  ```javascript
  const nutrunner = new OpenProtocolNutrunner({
    host: '192.168.1.100',
    spindleCount: 2  // Set manually
  });
  ```

### Firmware Variations
- MID 0061 field positions vary by firmware version
- Library uses status flags instead of hard-coded offsets (production-safe)

---

##  License

**Apache License 2.0**

Copyright (c) 2026 Bufferstack.IO Analytics Technology LLP  
Copyright (c) 2026 Harshad Joshi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---

##  Acknowledgments

Developed for real manufacturing environments in **Pune, India**. Built on lessons learned from production deployments in:
- Automotive assembly lines
- Aerospace component manufacturing
- Heavy equipment production

**Protocol Reference:** Atlas Copco Open Protocol Specification v2.xx.yy+

---

##  Contributing

Contributions welcome! Areas needing help:
- Additional MID implementations (parameter sets, multi-stage results, graphs)
- TypeScript type definitions
- Controller-specific quirks documentation
- More integration examples (PostgreSQL, Kafka, etc.)

---

##  Support

- 🐛 [Report Issues](https://github.com/hj91/node-nutrunner-open-library/issues)
- 💬 [Discussions](https://github.com/hj91/node-nutrunner-open-library/discussions)
- 📧 Email: harshad@bufferstack.io

---

## Star this project

If this library helps your manufacturing operations, please ⭐ star it on GitHub!

---

**Made with ❤️ for the industrial automation community**

*Tested in production since 2026 | Zero dependencies | Production-grade reliability*
