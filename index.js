/**
 * Open Protocol Nutrunner Client v1.2.7 (node-nutrunner-open-library)
 * Production-grade Open Protocol client for Node.js — multi-brand support
 * Handles nutrunner communication, tightening cycles, VIN traceability,
 * batch manufacturing, and industrial safety interlocks.
 *
 * Copyright (c) 2026 Bufferstack.IO Analytics Technology LLP
 * Copyright (c) 2026 Harshad Joshi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Unreleased (Framing Fix):
 * • BUGFIX: TX header is 20 bytes again (spare = SeqNo/NoOfParts/PartNo, 4
 *   bytes). The v1.2.7 8-space spare put 4 stray bytes in every data field.
 * • BUGFIX: MIN_FRAME_SIZE = 20. Length includes the 4-byte length field, so
 *   data-less frames (MID 9999 echo, 0062, ...) are 20 bytes and valid.
 * • BUGFIX: MID revision goes in the header Rev field (sendMID 4th argument);
 *   MID 0060 no longer sends the revision as data.
 * • BUGFIX: RX parsers follow each frame's own header revision.
 * • BUGFIX: RX buffer is byte-oriented (latin1), so Length matches bytes.
 *
 * Changelog v1.2.7 (Real Hardware Multi-Spindle Fix):
 * • BUGFIX: sendMID spare field corrected to 8 spaces (was 4) — TX frames now
 *   correctly emit 20-byte header bodies per Open Protocol spec. This resolves
 *   the "Message too short: expected at least 20 bytes, got 18" parse errors.
 * • BUGFIX: Frame validation threshold corrected from len<20 to len<24.
 *   The `len` field is the TOTAL frame size (including the 4-byte length prefix),
 *   so minimum valid frame = 24, not 20.
 * • BUGFIX: MID 0065 now ACKs with MID 0066 (not MID 0062). Sending MID 0062
 *   in response to MID 0065 was a protocol violation against real controllers.
 * • BUGFIX: pendingSpindles map now cleared at the START of each new tightening
 *   cycle to prevent stale results from a timed-out cycle mixing with new data.
 * • BUGFIX: Multi-spindle Rev 1 — pendingSpindles now keyed by tighteningId
 *   (not spindle number) because Rev 1 does not carry an explicit spindle field.
 *   Real hardware spindle numbers require Rev 2+ subscription.
 * • BUGFIX: MID 0062 now sent only ONCE per tightening cycle (after all spindles
 *   accumulate), not once per individual spindle result. Fixes ACK flooding on
 *   Atlas Copco Power Focus and other strict multi-spindle controllers.
 * • CLARIFIED: batch.counter semantics = number of COMPLETED CYCLES (one cycle
 *   = all spindles tightened once). This matches how the controller's own batch
 *   counter operates when using MID 0031 batch management.
 *
 * Changelog v1.2.6 (Simulator Support Edition):
 * • Added 'simulator' profile locked to Revision 1 for instant link establishment.
 * • Disabled MID 0070 (Alarm) subscriptions for the simulator profile.
 * • Added MID 0091 parser and state handler for multi-spindle status broadcasts.
 * • Added setBatchSize (MID 0019) to force batch counter resets.
 * • Added skipBolt (MID 0128) for explicit NOK bypass in strict batching.
 * • Fixed simulator-specific data drift in MID 0061 caused by 2-byte Parameter
 *   IDs and 2-byte Job IDs.
 * • Reverted invalid Angle scaling: Angle is integers per OP Spec Rev 1.
 */

'use strict';

const net = require('net');
const EventEmitter = require('events');

/* =========================================================
   Errors
   ========================================================= */

class InterlockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InterlockError';
    this.code = code;
  }
}

class ProtocolError extends Error {
  constructor(message, mid, errorCode) {
    super(message);
    this.name = 'ProtocolError';
    this.mid = mid;
    this.errorCode = errorCode;
  }
}

class CommandError extends Error {
  constructor(message, mid) {
    super(message);
    this.name = 'CommandError';
    this.mid = mid;
  }
}

/* =========================================================
   Defaults
   ========================================================= */

const DEFAULT_PORT               = 4545;
const HEARTBEAT_INTERVAL_MS      = 7000;
const TIGHTENING_TIMEOUT_MS      = 8000;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS     = 30000;
const RECONNECT_BACKOFF_FACTOR   = 2;
const COMMAND_TIMEOUT_MS         = 5000;
const FRAME_VALIDATION_ENABLED   = true;

// Open Protocol header (spec §2.2.2) is 20 bytes INCLUDING the length field:
// Length(4) MID(4) Rev(3) NoAck(1) StationID(2) SpindleID(2) SeqNo(2)
// NoOfParts(1) PartNo(1). Length counts header + data, excluding the NUL.
// A data-less frame (MID 9999 echo, MID 0062, ...) is exactly 20 bytes.
const HEADER_SIZE    = 20;
const MIN_FRAME_SIZE = HEADER_SIZE;

/* =========================================================
   Brand Profiles
   ========================================================= */

const BRAND_PROFILES = {
  'generic': {
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     4,
    supportsAlarms:  true,
    isSimulator:     false
  },
  'atlas-copco': {
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     4,
    supportsAlarms:  true,
    isSimulator:     false
  },
  'stanley': {
    jobSelectMid:   34,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     2,
    supportsAlarms:  true,
    isSimulator:     false
  },
  'desoutter': {
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     4,
    supportsAlarms:  true,
    isSimulator:     false
  },
  'ingersoll-rand': {
    jobSelectMid:   34,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     2,
    supportsAlarms:  true,
    isSimulator:     false
  },
  'simulator': {
    // Locked to Rev 1 for instant link establishment without revision negotiation.
    // Alarm subscription (MID 0070) disabled — simulator does not support it.
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     1,
    supportsAlarms:  false,
    isSimulator:     true
  }
};

/* =========================================================
   MID Field Tables
   =========================================================
   Tagged MID data is a sequence of <2-digit parameter ID><fixed-width value>.
   Each row: [paramId, name, width, type, minRevision]
     int  → Number          str  → trimmed string
     raw  → untrimmed string    char → single status digit (string)
     x100 → Number / 100 (torque values carry two implied decimals)
*/

const MID0061_REV1_FIELDS = [
  ['01', 'cellId',          4, 'int'],
  ['02', 'channelId',       2, 'int'],
  ['03', 'controllerName', 25, 'str'],
  ['04', 'vin',            25, 'str'],
  ['05', 'jobId',           2, 'int'],
  ['06', 'paramSetId',      3, 'int'],
  ['07', 'batchSize',       4, 'int'],
  ['08', 'batchCounter',    4, 'int'],
  ['09', 'tighteningStatus',1, 'char'],
  ['10', 'torqueStatus',    1, 'char'],
  ['11', 'angleStatus',     1, 'char'],
  ['12', 'torqueMin',       6, 'x100'],
  ['13', 'torqueMax',       6, 'x100'],
  ['14', 'torqueTarget',    6, 'x100'],
  ['15', 'torque',          6, 'x100'],
  ['16', 'angleMin',        5, 'int'],
  ['17', 'angleMax',        5, 'int'],
  ['18', 'angleTarget',     5, 'int'],
  ['19', 'angle',           5, 'int'],
  ['20', 'timestamp',      19, 'str'],
  ['21', 'lastPsetChange', 19, 'str'],
  ['22', 'batchStatus',     1, 'char'],
  ['23', 'tighteningId',   10, 'raw']
];

// Revisions 2-7 share one parameter numbering; later revisions append fields.
const MID0061_REV2_FIELDS = [
  ['01', 'cellId',                         4, 'int',  2],
  ['02', 'channelId',                      2, 'int',  2],
  ['03', 'controllerName',                25, 'str',  2],
  ['04', 'vin',                           25, 'str',  2],
  ['05', 'jobId',                          4, 'int',  2],
  ['06', 'paramSetId',                     3, 'int',  2],
  ['07', 'strategy',                       2, 'int',  2],
  ['08', 'strategyOptions',                5, 'raw',  2],
  ['09', 'batchSize',                      4, 'int',  2],
  ['10', 'batchCounter',                   4, 'int',  2],
  ['11', 'tighteningStatus',               1, 'char', 2],
  ['12', 'batchStatus',                    1, 'char', 2],
  ['13', 'torqueStatus',                   1, 'char', 2],
  ['14', 'angleStatus',                    1, 'char', 2],
  ['15', 'rundownAngleStatus',             1, 'char', 2],
  ['16', 'currentMonitoringStatus',        1, 'char', 2],
  ['17', 'selftapStatus',                  1, 'char', 2],
  ['18', 'prevailTorqueMonitoringStatus',  1, 'char', 2],
  ['19', 'prevailTorqueCompensateStatus',  1, 'char', 2],
  ['20', 'tighteningErrorStatus',         10, 'int',  2],
  ['21', 'torqueMin',                      6, 'x100', 2],
  ['22', 'torqueMax',                      6, 'x100', 2],
  ['23', 'torqueTarget',                   6, 'x100', 2],
  ['24', 'torque',                         6, 'x100', 2],
  ['25', 'angleMin',                       5, 'int',  2],
  ['26', 'angleMax',                       5, 'int',  2],
  ['27', 'angleTarget',                    5, 'int',  2],
  ['28', 'angle',                          5, 'int',  2],
  ['29', 'rundownAngleMin',                5, 'int',  2],
  ['30', 'rundownAngleMax',                5, 'int',  2],
  ['31', 'rundownAngle',                   5, 'int',  2],
  ['32', 'currentMonitoringMin',           3, 'int',  2],
  ['33', 'currentMonitoringMax',           3, 'int',  2],
  ['34', 'currentMonitoringValue',         3, 'int',  2],
  ['35', 'selftapMin',                     6, 'x100', 2],
  ['36', 'selftapMax',                     6, 'x100', 2],
  ['37', 'selftapTorque',                  6, 'x100', 2],
  ['38', 'prevailTorqueMonitoringMin',     6, 'x100', 2],
  ['39', 'prevailTorqueMonitoringMax',     6, 'x100', 2],
  ['40', 'prevailTorque',                  6, 'x100', 2],
  ['41', 'tighteningId',                  10, 'raw',  2],
  ['42', 'jobSequenceNumber',              5, 'int',  2],
  ['43', 'syncTighteningId',               5, 'int',  2],
  ['44', 'toolSerialNumber',              14, 'str',  2],
  ['45', 'timestamp',                     19, 'str',  2],
  ['46', 'lastPsetChange',                19, 'str',  2],
  ['47', 'paramSetName',                  25, 'str',  3],
  ['48', 'torqueUnit',                     1, 'char', 3],
  ['49', 'resultType',                     2, 'int',  3],
  ['50', 'identifierPart2',               25, 'str',  4],
  ['51', 'identifierPart3',               25, 'str',  4],
  ['52', 'identifierPart4',               25, 'str',  4],
  ['53', 'customerErrorCode',              4, 'str',  5],
  ['54', 'prevailTorqueCompensateValue',   6, 'x100', 6],
  ['55', 'tighteningErrorStatus2',        10, 'int',  6],
  ['56', 'compensatedAngle',               7, 'x100', 7],
  ['57', 'finalAngleDecimal',              7, 'x100', 7]
];

// Revision 999 ("light"): untagged, fixed positions.
const MID0061_REV999_FIELDS = [
  ['vin',              25, 'str'],
  ['jobId',             2, 'int'],
  ['paramSetId',        3, 'int'],
  ['batchSize',         4, 'int'],
  ['batchCounter',      4, 'int'],
  ['batchStatus',       1, 'char'],
  ['tighteningStatus',  1, 'char'],
  ['torqueStatus',      1, 'char'],
  ['angleStatus',       1, 'char'],
  ['torque',            6, 'x100'],
  ['angle',             5, 'int'],
  ['timestamp',        19, 'str'],
  ['lastPsetChange',   19, 'str'],
  ['tighteningId',     10, 'raw']
];

// MID 0065: Old tightening result upload reply (answer to MID 0064).
const MID0065_REV1_FIELDS = [
  ['01', 'tighteningId',     10, 'raw'],
  ['02', 'vin',              25, 'str'],
  ['03', 'paramSetId',        3, 'int'],
  ['04', 'batchCounter',      4, 'int'],
  ['05', 'tighteningStatus',  1, 'char'],
  ['06', 'torqueStatus',      1, 'char'],
  ['07', 'angleStatus',       1, 'char'],
  ['08', 'torque',            6, 'x100'],
  ['09', 'angle',             5, 'int'],
  ['10', 'timestamp',        19, 'str'],
  ['11', 'batchStatus',       1, 'char']
];

const MID0065_REV2_FIELDS = [
  ['01', 'tighteningId',                  10, 'raw'],
  ['02', 'vin',                           25, 'str'],
  ['03', 'paramSetId',                     3, 'int'],
  ['04', 'strategy',                       2, 'int'],
  ['05', 'strategyOptions',                5, 'raw'],
  ['06', 'batchCounter',                   4, 'int'],
  ['07', 'batchStatus',                    1, 'char'],
  ['08', 'tighteningStatus',               1, 'char'],
  ['09', 'torqueStatus',                   1, 'char'],
  ['10', 'angleStatus',                    1, 'char'],
  ['11', 'rundownAngleStatus',             1, 'char'],
  ['12', 'currentMonitoringStatus',        1, 'char'],
  ['13', 'selftapStatus',                  1, 'char'],
  ['14', 'prevailTorqueMonitoringStatus',  1, 'char'],
  ['15', 'prevailTorqueCompensateStatus',  1, 'char'],
  ['16', 'tighteningErrorStatus',         10, 'int'],
  ['17', 'torque',                         6, 'x100'],
  ['18', 'angle',                          5, 'int'],
  ['19', 'rundownAngle',                   5, 'int'],
  ['20', 'currentMonitoringValue',         3, 'int'],
  ['21', 'selftapTorque',                  6, 'x100'],
  ['22', 'prevailTorque',                  6, 'x100'],
  ['23', 'jobSequenceNumber',              5, 'int'],
  ['24', 'syncTighteningId',               5, 'int'],
  ['25', 'toolSerialNumber',              14, 'str'],
  ['26', 'timestamp',                     19, 'str']
];

// MID 0041: Tool data upload reply (answer to MID 0040).
const MID0041_FIELDS = [
  ['01', 'toolSerialNumber',          14, 'str',  1],
  ['02', 'tighteningCount',           10, 'int',  1],
  ['03', 'lastCalibrationDate',       19, 'str',  1],
  ['04', 'controllerSerialNumber',    10, 'str',  1],
  ['05', 'calibrationValue',           6, 'x100', 2],
  ['06', 'lastServiceDate',           19, 'str',  2],
  ['07', 'tighteningsSinceService',   10, 'int',  2],
  ['08', 'toolType',                   2, 'int',  2],
  ['09', 'motorSize',                  2, 'int',  2],
  ['10', 'openEndData',                3, 'raw',  2],
  ['11', 'controllerSoftwareVersion', 19, 'str',  2],
  ['12', 'toolMaxTorque',              6, 'x100', 3],
  ['13', 'toolGearRatio',              6, 'x100', 3],
  ['14', 'toolFullSpeed',              6, 'x100', 3],
  ['15', 'primaryTool',                2, 'int',  4]
];

const TORQUE_UNITS = {
  '1': 'Nm', '2': 'Lbf.ft', '3': 'Lbf.In', '4': 'Kpm',
  '5': 'Kgf.cm', '6': 'ozf.in', '7': '%', '8': 'Ncm'
};

function convertField(value, type) {
  switch (type) {
    case 'int':  return Number(value.trim());
    case 'x100': return Number(value.trim()) / 100;
    case 'str':  return value.trim();
    default:     return value;          // 'raw', 'char'
  }
}

/**
 * Parse tagged MID data against a field table.
 * Parameter IDs are consecutive, starting at 01. Parsing stops at the first
 * parameter ID the table does not know (a newer revision than this library
 * implements); the remainder is returned as `unparsed`.
 * Throws ProtocolError on malformed data.
 */
function parseTagged(mid, p, table) {
  const byId   = new Map(table.map(row => [row[0], row]));
  const out    = {};
  let pos      = 0;
  let lastId   = 0;
  let maxRev   = 1;

  while (pos < p.length) {
    const id = p.slice(pos, pos + 2);
    if (!/^\d{2}$/.test(id)) {
      throw new ProtocolError(`MID ${mid}: invalid parameter ID "${id}" at offset ${pos}`, mid);
    }
    if (Number(id) !== lastId + 1) {
      throw new ProtocolError(`MID ${mid}: expected parameter ${lastId + 1}, got ${id} at offset ${pos}`, mid);
    }
    const row = byId.get(id);
    if (!row) { out.unparsed = p.slice(pos); break; }
    const [, name, width, type, minRev = 1] = row;
    const value = p.slice(pos + 2, pos + 2 + width);
    if (value.length < width) {
      throw new ProtocolError(`MID ${mid}: parameter ${id} truncated at offset ${pos}`, mid);
    }
    out[name] = convertField(value, type);
    lastId    = Number(id);
    maxRev    = Math.max(maxRev, minRev);
    pos      += 2 + width;
  }

  return { fields: out, maxRev };
}

/**
 * Parse a tagged MID whose rev 1 and rev 2+ layouts number their parameters
 * differently. With the header revision unknown, the data is accepted as rev 1
 * only if it is exactly the complete rev 1 parameter set.
 */
function parseTaggedByRevision(mid, p, rev, rev1Table, revNTable) {
  if (rev === 1) return { fields: parseTagged(mid, p, rev1Table).fields, revision: 1 };
  if (rev >= 2)  return { fields: parseTagged(mid, p, revNTable).fields, revision: rev };

  try {
    const { fields } = parseTagged(mid, p, rev1Table);
    if (!fields.unparsed && Object.keys(fields).length === rev1Table.length) {
      return { fields, revision: 1 };
    }
  } catch (_) { /* not rev 1 */ }

  const { fields, maxRev } = parseTagged(mid, p, revNTable);
  return { fields, revision: Math.max(2, maxRev) };
}

function parsePositional(mid, p, table) {
  const out = {};
  let pos   = 0;
  for (const [name, width, type] of table) {
    const value = p.slice(pos, pos + width);
    if (value.length < width) {
      throw new ProtocolError(`MID ${mid}: field ${name} truncated at offset ${pos}`, mid);
    }
    out[name] = convertField(value, type);
    pos += width;
  }
  return out;
}

/* =========================================================
   State Factory
   ========================================================= */

function createInitialState() {
  return {
    connection: {
      connected:         false,
      linkLayerReady:    false,
      lastMID:           null,
      reconnecting:      false,
      reconnectAttempts: 0
    },

    protocol: {
      revision: 1,
      subscriptions: {
        tighteningResults:   false,
        alarms:              false,
        multiSpindleStatus:  false,
        multiSpindleResults: false
      }
    },

    controller: {
      ready:         false,
      errorActive:   false,
      errorCode:     null,
      alarms:        [],
      emergencyStop: false
    },

    tool: {
      ready:              false,
      enabled:            false,
      running:            false,
      direction:          '—',
      processOn:          false,
      spindleCount:       1,
      spindleCountSource: 'default',
      data:               null      // last MID 0041 tool data reply
    },

    product: {
      vin:         null,
      vinRequired: false,
      vinValid:    false,
      vinLocked:   false
    },

    job: {
      jobId:      null,
      paramSetId: null,
      active:     false,
      locked:     false
    },

    batch: {
      batchId:      null,
      size:         null,
      counter:      0,
      active:       false,
      complete:     false,
      locked:       false,
      pendingReset: false
    },

    tightening: {
      inProgress:      false,
      cycleStartTs:    null,
      // KEY: tighteningId (string) → result object. MID 0061 carries no
      // spindle number at any revision, so tighteningId is the unique key.
      pendingSpindles: new Map(),
      watchdog:        null
    },

    pendingCommands: new Map()
  };
}

/* =========================================================
   Header
   ========================================================= */

// Parses the 20-byte Open Protocol header of a frame (latin1 string, length
// field included). Blank, 000 and 001 revisions all mean revision 1.
function parseHeader(frame) {
  const field = (from, to) => frame.slice(from, to).trim();
  const num   = (from, to) => { const n = parseInt(field(from, to), 10); return isNaN(n) ? null : n; };
  return {
    length:    num(0, 4),
    mid:       num(4, 8),
    revision:  num(8, 11) || 1,
    noAck:     frame[11] === '1',
    stationId: num(12, 14),
    spindleId: num(14, 16),
    seqNo:     num(16, 18),
    parts:     num(18, 19),
    partNo:    num(19, 20)
  };
}

/* =========================================================
   Client
   ========================================================= */

class OpenProtocolNutrunner extends EventEmitter {
  constructor({
    host,
    port                   = DEFAULT_PORT,
    autoReconnect          = true,
    validateFrames         = FRAME_VALIDATION_ENABLED,
    spindleCount           = null,
    allowDuplicateCommands = false,
    brand                  = 'generic',
    jobSelectMid           = null,
    toolEnableMid          = null,
    toolDisableMid         = null,
    maxRevision            = null
  }) {
    super();
    this.host                   = host;
    this.port                   = port;
    this.autoReconnect          = autoReconnect;
    this.validateFrames         = validateFrames;
    this.configuredSpindleCount = spindleCount;
    this.allowDuplicateCommands = allowDuplicateCommands;

    const baseProfile = BRAND_PROFILES[brand] || BRAND_PROFILES['generic'];
    this.profile = {
      isSimulator:    baseProfile.isSimulator,
      supportsAlarms: baseProfile.supportsAlarms !== false,
      jobSelectMid:   jobSelectMid   !== null ? jobSelectMid   : baseProfile.jobSelectMid,
      toolEnableMid:  toolEnableMid  !== null ? toolEnableMid  : baseProfile.toolEnableMid,
      toolDisableMid: toolDisableMid !== null ? toolDisableMid : baseProfile.toolDisableMid,
      maxRevision:    maxRevision    !== null ? maxRevision    : baseProfile.maxRevision
    };
    this._pendingRevision = this.profile.maxRevision;

    this.socket         = null;
    this.buffer         = Buffer.alloc(0);
    this.state          = createInitialState();
    this.lastTrafficTs  = Date.now();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
    this.commandSeq     = 0;
    this._lastCommandId = null;
    this._pendingVin    = null;
  }

  /* =======================================================
     Connection
     ======================================================= */

  connect() {
    return new Promise((resolve, reject) => {
      if (this.state.connection.connected) return resolve();

      this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.state.connection.connected         = true;
        this.state.connection.reconnecting      = false;
        this.state.connection.reconnectAttempts = 0;
        this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

        if (this.configuredSpindleCount !== null) {
          this.state.tool.spindleCount       = this.configuredSpindleCount;
          this.state.tool.spindleCountSource = 'config';
        }

        this.emit('connected');
        this._startHeartbeat();
        this.sendMID(1);
        resolve();
      });

      this.socket.on('data',  d => this._onData(d));
      this.socket.on('close', () => this._onClose());
      this.socket.on('error', e => {
        this.emit('error', e);
        if (!this.state.connection.connected) reject(e);
      });
    });
  }

  disconnect() {
    this.autoReconnect = false;
    this._stopReconnect();
    if (this.socket) { this.sendMID(2); this.socket.destroy(); }
  }

  _onClose() {
    const wasConnected = this.state.connection.connected;

    this._stopHeartbeat();
    this._clearWatchdog();
    this._clearPendingCommands();

    this.state.connection.connected      = false;
    this.state.connection.linkLayerReady = false;
    this.buffer               = Buffer.alloc(0);
    this._pendingRevision     = this.profile.maxRevision;

    this.state.controller.ready         = false;
    this.state.controller.emergencyStop = false;
    this.state.tool.enabled             = false;
    this.state.tool.running             = false;
    this.state.tool.ready               = false;
    this.state.tool.direction           = '—';
    this.state.tool.processOn           = false;
    this.state.job.active               = false;
    this.state.job.locked               = false;
    this.state.product.vinValid         = false;
    this.state.product.vinLocked        = false;
    this.state.product.vinRequired      = false;
    this._pendingVin                    = null;

    this.emit('disconnected');
    if (this.autoReconnect && wasConnected) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this._stopReconnect();
    this.state.connection.reconnecting = true;
    this.state.connection.reconnectAttempts++;
    this.emit('reconnecting', {
      attempt: this.state.connection.reconnectAttempts,
      delay:   this.reconnectDelay
    });
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(
          this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
          RECONNECT_MAX_DELAY_MS
        );
        this._scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  _stopReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  /* =======================================================
     Heartbeat
     ======================================================= */

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.state.connection.connected) return;
      if (Date.now() - this.lastTrafficTs >= HEARTBEAT_INTERVAL_MS) this.sendMID(9999);
    }, 1000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _touchTraffic() { this.lastTrafficTs = Date.now(); }

  /* =======================================================
     Framing
     ======================================================= */

  // `revision` goes in the header Rev field: Open Protocol selects the MID
  // revision there, never in the data field.
  sendMID(mid, payload = '', expectAck = false, revision = 1) {
    this._touchTraffic();

    if (expectAck && !this.allowDuplicateCommands) {
      const hasPending = [...this.state.pendingCommands.values()].some(c => c.mid === mid);
      if (hasPending) {
        throw new CommandError(`Command MID ${mid} already pending - wait for ACK or NAK`, mid);
      }
    }

    const midStr = mid.toString().padStart(4, '0');
    const rev    = revision.toString().padStart(3, '0');
    const noAck  = expectAck ? '0' : '1';
    const station = '01';
    const spindle = '01';
    // SeqNo(2) + NoOfParts(1) + PartNo(1): blank = unused (no link-level ACK,
    // single-part message).
    const spare = '    ';

    const headerRest = `${rev}${noAck}${station}${spindle}${spare}`;
    const body  = `${midStr}${headerRest}${payload}`;
    // Length counts bytes; frames are written as latin1 so 1 char = 1 byte.
    const len   = (Buffer.byteLength(body, 'latin1') + 4).toString().padStart(4, '0');
    const frame = Buffer.from(`${len}${body}\0`, 'latin1');

    if (expectAck) {
      const cmdId = ++this.commandSeq;
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

      const cmd = { mid, timestamp: Date.now(), resolve, reject, timeout: null };
      cmd.timeout = setTimeout(() => {
        if (this.state.pendingCommands.has(cmdId)) {
          this.state.pendingCommands.delete(cmdId);
          reject(new CommandError(`MID ${mid} ACK timeout after ${COMMAND_TIMEOUT_MS} ms`, mid));
          this.emit('commandTimeout', { mid, cmdId });
        }
      }, COMMAND_TIMEOUT_MS);

      this.state.pendingCommands.set(cmdId, cmd);
      this._lastCommandId = cmdId;
      this.socket.write(frame);
      return promise;
    }

    this.socket.write(frame);
  }

  _onData(data) {
    this._touchTraffic();
    // Byte-oriented buffer: Length counts bytes, so a UTF-8 string would
    // desync on any non-ASCII byte and corrupt binary payloads.
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;

    for (;;) {
      // Skip NUL terminators between frames.
      let skip = 0;
      while (skip < this.buffer.length && this.buffer[skip] === 0) skip++;
      if (skip) this.buffer = this.buffer.subarray(skip);

      if (this.buffer.length < 4) return;

      const lenStr = this.buffer.toString('latin1', 0, 4);

      if (this.validateFrames && !/^\d{4}$/.test(lenStr)) {
        this.emit('frameError', { type: 'invalid_length', buffer: this.buffer.toString('latin1', 0, 20) });
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const len = parseInt(lenStr, 10);

      // `len` is the TOTAL frame size: 20-byte header (length field included)
      // plus data, excluding the NUL terminator.
      if (this.validateFrames && (len < MIN_FRAME_SIZE || len > 9999)) {
        this.emit('frameError', { type: 'length_out_of_range', length: len });
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      // Unvalidated garbage can't be framed at all; drop a byte to make progress.
      if (!(len >= 4)) { this.buffer = this.buffer.subarray(1); continue; }

      if (this.buffer.length < len) return;

      const frame  = this.buffer.toString('latin1', 0, len);
      this.buffer  = this.buffer.subarray(len);
      const header = parseHeader(frame);
      const mid    = header.mid;
      const payload = frame.slice(HEADER_SIZE);

      try {
        const parsed = this._parseMID(mid, payload, header.revision);
        this._handleMID(mid, parsed);
      } catch (err) {
        this.emit('parseError', { mid, error: err.message });
      }
    }
  }

  /* =======================================================
     MID Parsers
     ======================================================= */

  // `rev` is the header revision the controller actually sent this frame at
  // (blank/000/001 => 1); layouts must follow it, not the requested revision.
  _parseMID(mid, p, rev) {
    this._rxRevision = rev || null;
    switch (mid) {

      case 2:
      case 3: {
        const revision = parseInt(p.slice(0, 2).trim(), 10);
        return { revision: isNaN(revision) ? 1 : revision };
      }

      case 4:
        return {
          failedMid: Number(p.slice(0, 4)),
          errorCode: Number(p.slice(4, 8)),
          message:   p.slice(8).trim()
        };

      case 5:
        return { acceptedMid: Number(p.slice(0, 4)) };

      case 11:
        return { paramSetId: Number(p.slice(0, 3)) };

      case 21:
        return { batchCounter: Number(p.slice(0, 4)) };

      // MID 0041: Tool data upload reply (answer to MID 0040). Tagged tool
      // identity and service data; it carries no ready/running status.
      case 41:
        return parseTagged(41, p, MID0041_FIELDS).fields;

      case 51: return { vin: p.trim() };
      case 52: return { vinRequired: true };
      case 35: return { jobId: Number(p.slice(0, 4)) };

      case 31:
        return {
          batchId:      Number(p.slice(0, 4)),
          batchSize:    Number(p.slice(4, 8)),
          batchCounter: Number(p.slice(8, 12))
        };

      case 61:  return this._parse0061(p, rev);
      case 65:  return this._parse0065(p, rev);

      case 70:
      case 71:
        return {
          alarmCode:       p.slice(0, 4),
          controllerReady: p[4] === '1',
          toolReady:       p[5] === '1',
          timestamp:       p.slice(6, 25),
          message:         p.slice(25).trim()
        };

      case 76:
        return {
          alarmStatus:   p[0] === '1',
          currentAlarms: this._parseAlarmList(p.slice(1))
        };

      case 91:
        return {
          syncTighteningId: p.slice(0, 5),
          spindleCount:     Number(p.slice(5, 7)),
          syncStatus:       p.slice(7, 9)
        };

      case 101:
        return {
          cycleId:      p.slice(0, 10),
          spindleCount: Number(p.slice(10, 12)),
          overallOk:    p[12] === '1',
          timestamp:    p.slice(13, 32)
        };

      default:
        return { raw: p };
    }
  }

  /**
   * MID 0061: Last tightening result data.
   * The layout is selected by the header revision:
   *   1     tagged, parameters 01-23
   *   2-7   tagged, parameters 01-46, plus 47-49 (rev 3), 50-52 (rev 4),
   *         53 (rev 5), 54-55 (rev 6), 56-57 (rev 7)
   *   999   untagged "light" layout
   * MID 0061 carries no spindle number at any revision; per-spindle results
   * are MID 0101. When the header revision is unknown, rev 1 vs rev 2+ is
   * inferred from the data.
   *
   * Never throws: a malformed result is returned as { parseError, raw } so the
   * caller can still send the MID 0062 the controller waits for.
   */
  _parse0061(p, rev) {
    try {
      const { fields, revision } = rev === 999
        ? { fields: parsePositional(61, p, MID0061_REV999_FIELDS), revision: 999 }
        : parseTaggedByRevision(61, p, rev, MID0061_REV1_FIELDS, MID0061_REV2_FIELDS);
      return this._normalizeResult(fields, revision);
    } catch (err) {
      return { parseError: err.message, raw: p, revision: rev ?? null };
    }
  }

  // MID 0065: Old tightening result upload reply (answer to MID 0064).
  _parse0065(p, rev) {
    const { fields, revision } =
      parseTaggedByRevision(65, p, rev, MID0065_REV1_FIELDS, MID0065_REV2_FIELDS);
    return this._normalizeResult(fields, revision);
  }

  _normalizeResult(fields, revision) {
    const d = { revision, ...fields };
    d.ok = fields.tighteningStatus === '1';
    if (fields.torqueUnit !== undefined) d.torqueUnitName = TORQUE_UNITS[fields.torqueUnit] || null;
    d.spindle = 1;   // MID 0061/0065 carry no spindle number
    return d;
  }

  _parseAlarmList(str) {
    const alarms = [];
    for (let i = 0; i < str.length; i += 4) {
      const code = str.slice(i, i + 4);
      if (code !== '0000') alarms.push(code);
    }
    return alarms;
  }

  /* =======================================================
     MID → State
     ======================================================= */

  _handleMID(mid, d) {
    this.state.connection.lastMID = mid;

    switch (mid) {

      case 2:
      case 3:
        this.state.protocol.revision         = d.revision;
        this.state.connection.linkLayerReady = true;
        this.state.controller.ready          = true;
        this.emit('linkEstablished', { revision: d.revision });
        this.subscribeTighteningResults();
        if (this.profile.supportsAlarms) this.subscribeAlarms();
        break;

      case 4:
        this._resolvePendingCommand(d.failedMid, false, d);
        this.emit('commandError', d);

        if (d.failedMid === 60 && this._pendingRevision > 1) {
          const next = this._pendingRevision - 1;
          this.emit('revisionDowngrade', { from: this._pendingRevision, to: next });
          this.subscribeTighteningResults(next);
          break;
        }

        if (d.failedMid === 60 && this._pendingRevision === 1) {
          this.emit('revisionNegotiationFailed', {
            errorCode: d.errorCode,
            message:   d.message
          });
          break;
        }

        if (this.state.batch.pendingReset) {
          this.state.batch.pendingReset = false;
          this.emit('batchResetFailed', d);
        }
        break;

      case 5:
        this._resolvePendingCommand(d.acceptedMid, true);
        this.emit('commandAccepted', { mid: d.acceptedMid });

        if (d.acceptedMid === 50 && this._pendingVin) {
          this.state.product.vin      = this._pendingVin;
          this.state.product.vinValid = true;
          this.emit('vinDownloaded', { vin: this._pendingVin });
          this._pendingVin = null;
        }

        if (d.acceptedMid === this.profile.toolEnableMid)  this.state.tool.enabled = true;
        if (d.acceptedMid === this.profile.toolDisableMid) this.state.tool.enabled = false;

        if (d.acceptedMid === 60) {
          this.state.protocol.revision = this._pendingRevision;
          this.emit('revisionNegotiated', { revision: this._pendingRevision });
        }

        if (this.state.batch.pendingReset && d.acceptedMid === 20) {
          this.state.batch.counter      = 0;
          this.state.batch.complete     = false;
          this.state.batch.pendingReset = false;
          this.emit('batchResetConfirmed');
        }
        break;

      case 11:
        this.state.job.paramSetId = d.paramSetId;
        break;

      case 21:
        this.state.batch.counter = d.batchCounter;
        break;

      // MID 0041 is the reply to a MID 0040 tool data request. It holds tool
      // identity and service counters, not tool/controller status.
      case 41:
        this.state.tool.data = d;
        this.emit('toolData', d);
        this._resolvePendingCommand(40, true, d);
        break;

      case 51:
        this.state.product.vin      = d.vin;
        this.state.product.vinValid = true;
        break;

      case 52:
        this.state.product.vinRequired = true;
        this.emit('vinRequired');
        break;

      case 35:
        this.state.job.jobId         = d.jobId;
        this.state.job.active        = true;
        this.state.job.locked        = true;
        this.state.product.vinLocked = false;
        this.emit('jobSelected', { jobId: d.jobId });
        break;

      case 31:
        this.state.batch = {
          batchId:      d.batchId,
          size:         d.batchSize,
          counter:      d.batchCounter,
          active:       true,
          complete:     false,
          locked:       true,
          pendingReset: false
        };
        this.state.product.vinLocked = false;
        this.emit('batchStarted', this.state.batch);
        break;

      // MID 0061: the controller holds the next result until it receives a
      // MID 0062 for this one, so acknowledge every result immediately and
      // before any processing that could fail.
      case 61:
        this.sendMID(62);
        if (d.parseError) {
          this.emit('parseError', { mid: 61, error: d.parseError, raw: d.raw });
          break;
        }
        this._handleTighteningResult(d);
        break;

      // MID 0065 is the reply to a MID 0064 old-result request. It is not part
      // of the live result stream and takes no acknowledgement.
      case 65:
        this.emit('oldTighteningResult', d);
        this._resolvePendingCommand(64, true, d);
        break;

      case 70:
      case 71:
        this.state.controller.alarms.push(d);
        this.state.controller.errorActive = true;
        this.emit('alarm', d);
        break;

      case 76:
        if (!d.alarmStatus) {
          this.state.controller.alarms      = [];
          this.state.controller.errorActive = false;
        }
        this.emit('alarmStatus', d);
        break;

      case 91:
        if (d.spindleCount > 0 && this.state.tool.spindleCountSource !== 'config') {
          this.state.tool.spindleCount       = d.spindleCount;
          this.state.tool.spindleCountSource = 'mid091';
        }
        this.emit('multiSpindleStatus', d);
        break;

      case 101:
        if (
          this.state.tool.spindleCountSource !== 'config' &&
          this.state.tool.spindleCountSource !== 'manual' &&
          d.spindleCount > 0
        ) {
          this.state.tool.spindleCount       = d.spindleCount;
          this.state.tool.spindleCountSource = 'mid101';
          this.emit('spindleCountUpdated', { count: d.spindleCount, source: 'mid101' });
        }
        this.emit('multiSpindleCycleComplete', d);
        break;
    }

    this.emit('stateChanged', this.getState());
  }

  _resolvePendingCommand(mid, success, data = null) {
    for (const [cmdId, cmd] of this.state.pendingCommands.entries()) {
      if (cmd.mid === mid) {
        clearTimeout(cmd.timeout);
        this.state.pendingCommands.delete(cmdId);
        if (success) {
          cmd.resolve({ mid, cmdId });
          this.emit('commandSuccess', { mid, cmdId, data });
        } else {
          const err = new CommandError(
            data?.message || `MID ${mid} rejected by controller`, mid
          );
          err.errorCode = data?.errorCode ?? null;
          cmd.reject(err);
          this.emit('commandFailed', { mid, cmdId, data });
        }
        break;
      }
    }
  }

  _clearPendingCommands() {
    for (const [cmdId, cmd] of this.state.pendingCommands.entries()) {
      clearTimeout(cmd.timeout);
      cmd.reject(new CommandError(`MID ${cmd.mid} aborted — connection closed`, cmd.mid));
      this.emit('commandAborted', { mid: cmd.mid, cmdId });
    }
    this.state.pendingCommands.clear();
  }

  /* =======================================================
     Tightening Lifecycle
     ======================================================= */

  _startTighteningCycle() {
    // FIX: Clear pendingSpindles at cycle start to ensure no stale results
    // from a previous timed-out cycle can mix with results from this cycle.
    this.state.tightening.pendingSpindles.clear();
    this.state.tightening.inProgress   = true;
    this.state.tightening.cycleStartTs = Date.now();
    this._startWatchdog();
    this.emit('tighteningCycleStarted', {
      timestamp: this.state.tightening.cycleStartTs,
      direction: this.state.tool.direction
    });
  }

  _handleTighteningResult(d) {
    if (!this.state.tightening.inProgress || this.state.tightening.cycleStartTs === null) {
      this._startTighteningCycle();
    }

    if (d.vin && d.vin.length > 0) {
      this.state.product.vin      = d.vin;
      this.state.product.vinValid = true;
    }

    if (!this.state.product.vinLocked && this.state.product.vin) {
      this.state.product.vinLocked = true;
      this.emit('vinLocked', this.state.product.vin);
    }

    // MID 0061 carries no spindle number, so results are keyed by
    // tighteningId, which is unique per result.
    const key = d.tighteningId || String(d.spindle);

    this.emit('spindleResult', d);
    this.state.tightening.pendingSpindles.set(key, d);

    if (this.state.tightening.pendingSpindles.size < this.state.tool.spindleCount) {
      // Not all spindles received yet — withhold batch completion.
      return;
    }

    // All spindle results for this cycle have arrived.
    this._clearWatchdog();

    const results   = [...this.state.tightening.pendingSpindles.values()];
    const overallOk = results.every(r => r.ok);

    this.state.tightening.pendingSpindles.clear();
    this.state.tightening.inProgress = false;

    // batch.counter semantics: one unit = one completed tightening CYCLE
    // (all spindles finished). This matches the controller's own MID 0031
    // batch counter behaviour.
    if (this.state.batch.active && !this.state.batch.complete) {
      this.state.batch.counter++;
      this.emit('batchProgress', {
        counter:   this.state.batch.counter,
        size:      this.state.batch.size,
        remaining: this.state.batch.size - this.state.batch.counter
      });
      if (this.state.batch.counter >= this.state.batch.size) {
        this.state.batch.complete = true;
        this.state.batch.active   = false;
        this.emit('batchCompleted', this.state.batch);
      }
    }

    this.emit('tighteningCycleCompleted', {
      results,
      overallOk,
      duration: Date.now() - this.state.tightening.cycleStartTs
    });
  }

  _startWatchdog() {
    this._clearWatchdog();
    this.state.tightening.watchdog = setTimeout(() => {
      const partialResults = [...this.state.tightening.pendingSpindles.values()];
      this.state.tightening.inProgress = false;
      this.state.tightening.pendingSpindles.clear();
      this.emit('tighteningIncomplete', {
        expected: this.state.tool.spindleCount,
        received: partialResults.length,
        results:  partialResults
      });
    }, TIGHTENING_TIMEOUT_MS);
  }

  _clearWatchdog() {
    if (this.state.tightening.watchdog) {
      clearTimeout(this.state.tightening.watchdog);
      this.state.tightening.watchdog = null;
    }
  }

  /* =======================================================
     Interlocks
     ======================================================= */

  _check(cmd) {
    const s = this.state;
    if (!s.connection.connected)      throw new InterlockError('NOT_CONNECTED',  'Controller not connected');
    if (!s.connection.linkLayerReady) throw new InterlockError('LINK_NOT_READY', 'Link layer not established');

    if (cmd === 'startTightening') {
      if (!s.tool.enabled)                              throw new InterlockError('TOOL_DISABLED',  'Tool is disabled');
      if (s.tool.running)                               throw new InterlockError('TOOL_RUNNING',   'Tool already running');
      if (!s.controller.ready)                          throw new InterlockError('CTRL_NOT_READY', 'Controller not ready');
      if (s.controller.errorActive)                     throw new InterlockError('ALARM_ACTIVE',   'Controller alarm active');
      if (s.controller.emergencyStop)                   throw new InterlockError('EMERGENCY_STOP', 'Emergency stop is active');
      if (s.product.vinRequired && !s.product.vinValid) throw new InterlockError('VIN_REQUIRED',   'Valid VIN required');
      if (!s.job.active)                                throw new InterlockError('JOB_NOT_ACTIVE',  'No job selected');
    }
  }

  /* =======================================================
     Public API — Subscriptions
     ======================================================= */

  subscribeTighteningResults(revision = null) {
    const rev = revision !== null ? revision : this.profile.maxRevision;
    this._pendingRevision = rev;
    this.sendMID(60, '', true, rev).catch(() => {});
    this.state.protocol.subscriptions.tighteningResults = true;
  }

  unsubscribeTighteningResults() {
    this.sendMID(63);
    this.state.protocol.subscriptions.tighteningResults = false;
  }

  subscribeAlarms() {
    this.sendMID(70, '', true).catch(() => {});
    this.state.protocol.subscriptions.alarms = true;
  }

  unsubscribeAlarms() {
    this.sendMID(73);
    this.state.protocol.subscriptions.alarms = false;
  }

  acknowledgeAlarm() {
    this.sendMID(78, '', true).catch(err =>
      this.emit('commandError', { mid: 78, message: err.message })
    );
  }

  subscribeMultiSpindleStatus() {
    this.sendMID(90, '', true).catch(() => {});
    this.state.protocol.subscriptions.multiSpindleStatus = true;
  }

  unsubscribeMultiSpindleStatus() {
    this.sendMID(93);
    this.state.protocol.subscriptions.multiSpindleStatus = false;
  }

  subscribeMultiSpindleResults() {
    this.sendMID(100, '', true).catch(() => {});
    this.state.protocol.subscriptions.multiSpindleResults = true;
  }

  unsubscribeMultiSpindleResults() {
    this.sendMID(103);
    this.state.protocol.subscriptions.multiSpindleResults = false;
  }

  /* =======================================================
     Public API — Commands
     ======================================================= */

  startTightening() {
    this._check('startTightening');
    return this.sendMID(this.profile.toolEnableMid, '', true);
  }

  downloadVIN(vin) {
    if (vin.length > 25) throw new Error('VIN exceeds 25 characters');
    this._pendingVin = vin;
    return this.sendMID(50, vin.padEnd(25), true);
  }

  selectJob(jobId) {
    return this.sendMID(this.profile.jobSelectMid, jobId.toString().padStart(4, '0'), true);
  }

  selectParameterSet(paramSetId) {
    return this.sendMID(18, paramSetId.toString().padStart(3, '0'), true);
  }

  enableTool()  { return this.sendMID(this.profile.toolEnableMid,  '', true); }
  disableTool() { return this.sendMID(this.profile.toolDisableMid, '', true); }

  resetBatch() {
    this.state.batch.pendingReset = true;
    return this.sendMID(20, '', true);
  }

  decrementBatch() { return this.sendMID(21, '', true); }

  // MID 0019: Set Batch Size (forces batch counter reset on controller side)
  setBatchSize(paramSetId, size) {
    const psetStr = paramSetId.toString().padStart(3, '0');
    const sizeStr = size.toString().padStart(4, '0');
    return this.sendMID(19, `${psetStr}${sizeStr}`, true);
  }

  // MID 0128: Job Batch Increment — skip a NOK bolt in strict batching mode
  skipBolt() {
    return this.sendMID(128, '', true);
  }

  /* =======================================================
     Public API — Data Requests
     ======================================================= */

  // MID 0040 → MID 0041 tool data reply (resolves with the parsed data,
  // also emitted as 'toolData'). A MID 0004 rejects the promise.
  requestToolData() {
    return this.sendMID(40, '', true).then(() => this.state.tool.data);
  }

  // MID 0064 → MID 0065 old tightening result reply ('oldTighteningResult').
  // tighteningId 0 requests the most recent result.
  requestOldTighteningResult(tighteningId = 0) {
    const id = tighteningId.toString().padStart(10, '0');
    if (id.length > 10) throw new Error('Tightening ID exceeds 10 digits');
    let result = null;
    const capture = d => { result = d; };
    this.once('oldTighteningResult', capture);
    return this.sendMID(64, id, true)
      .then(() => result)
      .finally(() => this.removeListener('oldTighteningResult', capture));
  }

  /* =======================================================
     Public API — Configuration
     ======================================================= */

  setSpindleCount(count) {
    if (count < 1 || count > 99) throw new Error('Spindle count must be between 1 and 99');
    this.state.tool.spindleCount       = count;
    this.state.tool.spindleCountSource = 'manual';
    this.emit('spindleCountUpdated', { count, source: 'manual' });
  }

  /* =======================================================
     Public API — State
     ======================================================= */

  getState() {
    return JSON.parse(JSON.stringify(this.state, (key, val) => {
      if (val instanceof Map)                                            return [...val.values()];
      if (val instanceof Object && val.constructor?.name === 'Timeout') return undefined;
      return val;
    }));
  }

  isConnected() { return this.state.connection.connected; }

  isReady() {
    return this.state.connection.connected
      && this.state.connection.linkLayerReady
      && this.state.controller.ready
      && !this.state.controller.errorActive
      && !this.state.controller.emergencyStop;
  }

  getSpindleCount() {
    return { count: this.state.tool.spindleCount, source: this.state.tool.spindleCountSource };
  }
}

module.exports = { OpenProtocolNutrunner, InterlockError, ProtocolError, CommandError };
