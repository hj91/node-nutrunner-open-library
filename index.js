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
 * Unreleased (Open Protocol R2.16.0 compliance):
 * • One outstanding request/command/subscription at a time (spec §3.2.1);
 *   further calls queue instead of overlapping on the wire.
 * • Every subscription push is acknowledged with its spec ACK MID (0016,
 *   0023, 0036, 0053, 0062, 0072, 0075, 0077, 0092, 0102, 0212, ...).
 * • Optional link-level acknowledging: header sequence numbers with MID
 *   9997/9998 (spec §2.2.5, §3.2.2), enabled by startup at MID 0001 rev 6+.
 * • Multi-part (linked) messages are reassembled (spec §2.2.6).
 * • MID 0001 revision negotiation; MID 0002 parsed as tagged controller info;
 *   MID 0003 is sent on disconnect (it is integrator→controller).
 * • MID 0004 error code is 2 digits and mapped to the spec's text.
 * • Spec-correct semantics for MIDs 0010-0024 (psets, batch, lock at batch
 *   done), 0030-0039 (jobs), 0042-0048 (tool), 0050-0054 (VIN), 0070-0078
 *   (alarms), 0080-0082 (time), 0090-0103 (multi-spindle), 0127-0130 (job
 *   control), 0200-0225 (I/O), 0400-0423, and generic 0006/0008/0009.
 * • MID 0061 revisions 8-10 and 998; MID 0065 revision 2-10 table corrected.
 * • A command or keep-alive that gets no answer within the response timeout
 *   drops the connection (spec §3.3.5), so autoReconnect can recover it.
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
// The controller drops the link after 15 s without traffic (MID 9999, spec
// §5.28.1); the spec suggests a keep-alive after 10 s of inactivity.
const HEARTBEAT_INTERVAL_MS      = 7000;
const TIGHTENING_TIMEOUT_MS      = 8000;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS     = 30000;
const RECONNECT_BACKOFF_FACTOR   = 2;
// Spec §3.3.5: over TCP, "a suitable timeout in Open Protocol could be 10 s".
const COMMAND_TIMEOUT_MS         = 10000;
const FRAME_VALIDATION_ENABLED   = true;

// Open Protocol header (spec §2.2.2) is 20 bytes INCLUDING the length field:
// Length(4) MID(4) Rev(3) NoAck(1) StationID(2) SpindleID(2) SeqNo(2)
// NoOfParts(1) PartNo(1). Length counts header + data, excluding the NUL.
// A data-less frame (MID 9999 echo, MID 0062, ...) is exactly 20 bytes.
const HEADER_SIZE    = 20;
const MIN_FRAME_SIZE = HEADER_SIZE;
const MAX_DATA_SIZE  = 9999 - HEADER_SIZE;   // §2.3: max 9979 data bytes per part

/* =========================================================
   Brand Profiles
   ========================================================= */

// Job select is MID 0038 for every vendor; MID 0034 is "Job info subscribe".
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
    jobSelectMid:   38,
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
    jobSelectMid:   38,
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
   Message tables
   ========================================================= */

// MID 0004 error codes (spec Table 20).
const ERROR_CODES = {
  0: 'No Error', 1: 'Invalid data', 2: 'Parameter set ID not present',
  3: 'Parameter set can not be set', 4: 'Parameter set not running',
  6: 'VIN upload subscription already exists', 7: 'VIN upload subscription does not exists',
  8: 'VIN input source not granted', 9: 'Last tightening result subscription already exists',
  10: 'Last tightening result subscription does not exist', 11: 'Alarm subscription already exists',
  12: 'Alarm subscription does not exist', 13: 'Parameter set selection subscription already exists',
  14: 'Parameter set selection subscription does not exist', 15: 'Tightening ID requested not found',
  16: 'Connection rejected protocol busy', 17: 'Job ID not present',
  18: 'Job info subscription already exists', 19: 'Job info subscription does not exist',
  20: 'Job can not be set', 21: 'Job not running', 22: 'Not possible to execute dynamic Job request',
  23: 'Job batch decrement failed', 24: 'Not possible to create Pset', 25: 'Programming control not granted',
  26: 'Wrong tool type to Pset download connected', 27: 'Tool is inaccessible',
  28: 'Job abortion is in progress', 29: 'Tool does not exist',
  30: 'Controller is not a sync Master/station controller',
  31: 'Multi-spindle status subscription already exists', 32: 'Multi-spindle status subscription does not exist',
  33: 'Multi-spindle result subscription already exists', 34: 'Multi-spindle result subscription does not exist',
  35: 'Other master client already connected', 36: 'Lock type not supported',
  40: 'Job line control info subscription already exists', 41: 'Job line control info subscription does not exist',
  42: 'Identifier input source not granted',
  43: 'Multiple identifiers work order subscription already exists',
  44: 'Multiple identifiers work order subscription does not exist',
  50: 'Status external monitored inputs subscription already exists',
  51: 'Status external monitored inputs subscription does not exist',
  52: 'IO device not connected', 53: 'Faulty IO device ID', 54: 'Tool Tag ID unknown',
  55: 'Tool Tag ID subscription already exists', 56: 'Tool Tag ID subscription does not exist',
  57: 'Tool Motor tuning failed', 58: 'No alarm present', 59: 'Tool currently in use',
  60: 'No histogram available', 61: 'Pairing failed', 62: 'Pairing denied',
  63: 'Pairing or Pairing abortion attempt on wrong tooltype', 64: 'Pairing abortion denied',
  65: 'Pairing abortion failed', 66: 'Pairing disconnection failed', 67: 'Pairing in progress or already done',
  68: 'Pairing denied. No Program Control', 69: 'Unsupported extra data revision', 70: 'Calibration failed',
  71: 'Subscription already exists', 72: 'Subscription does not exists', 73: 'Subscribed MID unsupported',
  74: 'Subscribed MID Revision unsupported', 75: 'Requested MID unsupported',
  76: 'Requested MID Revision unsupported', 77: 'Requested on specific data not supported',
  78: 'Subscription on specific data not supported', 79: 'Command failed',
  80: 'Audi emergency status subscription exists', 81: 'Audi emergency status subscription does not exist',
  82: 'Automatic/Manual mode subscribe already exist', 83: 'Automatic/Manual mode subscribe does not exist',
  84: 'The relay function subscription already exists', 85: 'The relay function subscription does not exist',
  86: 'The selector socket info subscription already exist', 87: 'The selector socket info subscription does not exist',
  88: 'The digin info subscription already exist', 89: 'The digin info subscription does not exist',
  90: 'Lock at batch done subscription already exist', 91: 'Lock at batch done subscription does not exist',
  92: 'Open protocol commands disabled', 93: 'Open protocol commands disabled subscription already exists',
  94: 'Open protocol commands disabled subscription does not exist',
  95: 'Reject request, Power MACS is in manual mode', 96: 'Reject connection, Client already connected',
  97: 'MID revision unsupported', 98: 'Controller internal request timeout', 99: 'Unknown MID'
};

// MID 0004 codes that mean "this MID revision is not supported".
const REVISION_UNSUPPORTED = new Set([74, 76, 97]);

// MID 9998 error codes (spec Table 9).
const LINK_ERROR_CODES = {
  1: 'Invalid length',
  2: 'Invalid revision',
  3: 'Invalid sequence number',
  4: 'Inconsistency of number of messages and message number'
};

// Request MID → the controller's reply MID (spec §4.1). The reply itself is
// the positive answer; MID 0004 is the negative one.
const REPLY_FOR = {
  10: 11, 12: 13, 30: 31, 32: 33, 40: 41, 64: 65, 80: 81,
  214: 215, 260: 262, 300: 301, 410: 411, 2600: 2601, 2602: 2603
};

// Subscription data MID → the integrator's acknowledge MID (spec Table 7).
// With link-level acknowledging these are replaced by MID 9997 (§3.9.2).
const PUSH_ACK = {
  15: 16, 22: 23, 35: 36, 52: 53, 61: 62, 71: 72, 74: 75, 76: 77, 91: 92,
  101: 102, 106: 108, 107: 108, 121: 125, 122: 125, 123: 125, 124: 125,
  152: 153, 211: 212, 217: 218, 221: 222, 242: 243, 251: 252, 262: 263,
  401: 402, 421: 422, 501: 502, 1000: 1001, 2604: 2605, 8001: 8002
};

// Subscription data MIDs acknowledged with MID 0005 carrying the data MID.
const PUSH_ACK_0005 = new Set([700, 900, 901, 1201, 1202, 1601, 1900]);

/* =========================================================
   MID Field Tables
   =========================================================
   Tagged MID data is a sequence of <2-digit parameter ID><fixed-width value>.
   Each row: [paramId, name, width, type, minRevision]
     int  → Number          str  → trimmed string
     raw  → untrimmed string    char → single status digit (string)
     x100 → Number / 100 (torque values carry two implied decimals)
     bool → '1' is true
   Numeric fields that are all spaces ("not supported", §2.3) become null.
   `width` may be a function of the fields parsed so far (repeated records).
*/

// MID 0002: Communication start acknowledge (revisions 1-7).
const MID0002_FIELDS = [
  ['01', 'cellId',                     4, 'int',  1],
  ['02', 'channelId',                  2, 'int',  1],
  ['03', 'controllerName',            25, 'str',  1],
  ['04', 'supplierCode',               3, 'str',  2],
  ['05', 'openProtocolVersion',       19, 'str',  3],
  ['06', 'controllerSoftwareVersion', 19, 'str',  3],
  ['07', 'toolSoftwareVersion',       19, 'str',  3],
  ['08', 'rbuType',                   24, 'str',  4],
  ['09', 'controllerSerialNumber',    10, 'str',  4],
  ['10', 'systemType',                 3, 'int',  5],
  ['11', 'systemSubtype',              3, 'int',  5],
  ['12', 'sequenceNumberSupport',      1, 'bool', 6],
  ['13', 'linkingSupport',             1, 'bool', 6],
  ['14', 'stationId',                 10, 'int',  6],
  ['15', 'stationName',               25, 'str',  6],
  ['16', 'clientId',                   1, 'int',  6],
  ['17', 'optionalKeepAlive',          1, 'char', 7]
];

// MID 0013: Parameter set data upload reply (revisions 1, 2 and 5).
const MID0013_FIELDS = [
  ['01', 'paramSetId',         3, 'int',  1],
  ['02', 'paramSetName',      25, 'str',  1],
  ['03', 'rotationDirection',  1, 'char', 1],
  ['04', 'batchSize',          2, 'int',  1],
  ['05', 'torqueMin',          6, 'x100', 1],
  ['06', 'torqueMax',          6, 'x100', 1],
  ['07', 'torqueTarget',       6, 'x100', 1],
  ['08', 'angleMin',           5, 'int',  1],
  ['09', 'angleMax',           5, 'int',  1],
  ['10', 'angleTarget',        5, 'int',  1],
  ['11', 'firstTarget',        6, 'x100', 2],
  ['12', 'startFinalAngle',    6, 'x100', 2],
  ['13', 'lastPsetChange',    19, 'str',  5]
];

// MID 0015: Parameter set selected, revision 2 (revision 1 is untagged).
const MID0015_REV2_FIELDS = [
  ['01', 'paramSetId',         3, 'int'],
  ['02', 'paramSetName',      25, 'str'],
  ['03', 'lastPsetChange',    19, 'str'],
  ['04', 'rotationDirection',  1, 'char'],
  ['05', 'batchSize',          2, 'int'],
  ['06', 'torqueMin',          6, 'x100'],
  ['07', 'torqueMax',          6, 'x100'],
  ['08', 'torqueTarget',       6, 'x100'],
  ['09', 'angleMin',           5, 'int'],
  ['10', 'angleMax',           5, 'int'],
  ['11', 'angleTarget',        5, 'int'],
  ['12', 'firstTarget',        6, 'x100'],
  ['13', 'startFinalAngle',    6, 'x100']
];

// MID 0033: Job data upload reply, parameters 01-12 (13 is the Job list).
function mid0033Fields(jobIdWidth) {
  return [
    ['01', 'jobId',                  jobIdWidth, 'int'],
    ['02', 'jobName',                25, 'str'],
    ['03', 'forcedOrder',             1, 'char'],
    ['04', 'maxTimeFirstTightening',  4, 'int'],
    ['05', 'maxTimeToComplete',       5, 'int'],
    ['06', 'batchMode',               1, 'char'],
    ['07', 'lockAtJobDone',           1, 'bool'],
    ['08', 'useLineControl',          1, 'bool'],
    ['09', 'repeatJob',               1, 'bool'],
    ['10', 'toolLoosening',           1, 'char'],
    ['11', 'reserved',                1, 'char'],
    ['12', 'numberOfParamSets',       2, 'int']
  ];
}

// MID 0035: Job info. Revision 1 has a 2-digit Job ID, revisions 2+ 4 digits.
function mid0035Fields(jobIdWidth) {
  return [
    ['01', 'jobId',                jobIdWidth, 'int',  1],
    ['02', 'jobStatus',             1, 'char', 1],
    ['03', 'jobBatchMode',          1, 'char', 1],
    ['04', 'jobBatchSize',          4, 'int',  1],
    ['05', 'jobBatchCounter',       4, 'int',  1],
    ['06', 'timestamp',            19, 'str',  1],
    ['07', 'jobCurrentStep',        3, 'int',  3],
    ['08', 'jobTotalSteps',         3, 'int',  3],
    ['09', 'jobStepType',           2, 'int',  3],
    ['10', 'jobTighteningStatus',   2, 'int',  4],
    ['11', 'jobSequenceNumber',     5, 'int',  5],
    ['12', 'vin',                  25, 'str',  5],
    ['13', 'identifierPart2',      25, 'str',  5],
    ['14', 'identifierPart3',      25, 'str',  5],
    ['15', 'identifierPart4',      25, 'str',  5]
  ];
}
const MID0035_REV1_FIELDS = mid0035Fields(2);
const MID0035_REV2_FIELDS = mid0035Fields(4);

// MID 0048: Tool pairing status.
const MID0048_FIELDS = [
  ['01', 'pairingStatus',  2, 'int'],
  ['02', 'timestamp',     19, 'str']
];

// MID 0052 revision 2: VIN and identifier result parts 2-4.
const MID0052_REV2_FIELDS = [
  ['01', 'vin',             25, 'str'],
  ['02', 'identifierPart2', 25, 'str'],
  ['03', 'identifierPart3', 25, 'str'],
  ['04', 'identifierPart4', 25, 'str']
];

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

// Revisions 2-10 share one parameter numbering; later revisions append fields.
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
  ['57', 'finalAngleDecimal',              7, 'x100', 7],
  ['58', 'startFinalAngle',                6, 'x100', 8],
  ['59', 'postViewTorqueActivated',        1, 'char', 8],
  ['60', 'postViewTorqueHigh',             6, 'x100', 8],
  ['61', 'postViewTorqueLow',              6, 'x100', 8],
  ['62', 'currentMonitoringAmp',           5, 'x100', 9],
  ['63', 'currentMonitoringAmpMin',        5, 'x100', 9],
  ['64', 'currentMonitoringAmpMax',        5, 'x100', 9],
  ['65', 'angleNumeratorScaleFactor',      5, 'int', 10],
  ['66', 'angleDenominatorScaleFactor',    5, 'int', 10],
  ['67', 'overallAngleStatus',             1, 'char',10],
  ['68', 'overallAngleMin',                5, 'int', 10],
  ['69', 'overallAngleMax',                5, 'int', 10],
  ['70', 'overallAngle',                   5, 'int', 10],
  ['71', 'peakTorque',                     6, 'x100',10],
  ['72', 'residualBreakawayTorque',        6, 'x100',10],
  ['73', 'startRundownAngle',              6, 'x100',10],
  ['74', 'rundownAngleComplete',           6, 'x100',10]
];

// Revision 998: revision 6 parameters (01-55) plus multistage stage results.
const MID0061_REV998_FIELDS = [
  ...MID0061_REV2_FIELDS.filter(row => Number(row[0]) <= 55),
  ['56', 'numberOfStages',        2, 'int',  998],
  ['57', 'numberOfStageResults',  2, 'int',  998],
  ['58', 'stageResults', f => 11 * (f.numberOfStageResults || 0), 'stages', 998]
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

// MID 0065 revisions 2-10 (spec Tables 113-121).
const MID0065_REV2_FIELDS = [
  ['01', 'tighteningId',                  10, 'raw',  2],
  ['02', 'vin',                           25, 'str',  2],
  ['03', 'jobId',                          4, 'int',  2],
  ['04', 'paramSetId',                     3, 'int',  2],
  ['05', 'strategy',                       2, 'int',  2],
  ['06', 'strategyOptions',                5, 'raw',  2],
  ['07', 'batchSize',                      4, 'int',  2],
  ['08', 'batchCounter',                   4, 'int',  2],
  ['09', 'tighteningStatus',               1, 'char', 2],
  ['10', 'batchStatus',                    1, 'char', 2],
  ['11', 'torqueStatus',                   1, 'char', 2],
  ['12', 'angleStatus',                    1, 'char', 2],
  ['13', 'rundownAngleStatus',             1, 'char', 2],
  ['14', 'currentMonitoringStatus',        1, 'char', 2],
  ['15', 'selftapStatus',                  1, 'char', 2],
  ['16', 'prevailTorqueMonitoringStatus',  1, 'char', 2],
  ['17', 'prevailTorqueCompensateStatus',  1, 'char', 2],
  ['18', 'tighteningErrorStatus',         10, 'int',  2],
  ['19', 'torque',                         6, 'x100', 2],
  ['20', 'angle',                          5, 'int',  2],
  ['21', 'rundownAngle',                   5, 'int',  2],
  ['22', 'currentMonitoringValue',         3, 'int',  2],
  ['23', 'selftapTorque',                  6, 'x100', 2],
  ['24', 'prevailTorque',                  6, 'x100', 2],
  ['25', 'jobSequenceNumber',              5, 'int',  2],
  ['26', 'syncTighteningId',               5, 'int',  2],
  ['27', 'toolSerialNumber',              14, 'str',  2],
  ['28', 'timestamp',                     19, 'str',  2],
  ['29', 'torqueUnit',                     1, 'char', 3],
  ['30', 'resultType',                     2, 'int',  3],
  ['31', 'identifierPart2',               25, 'str',  4],
  ['32', 'identifierPart3',               25, 'str',  4],
  ['33', 'identifierPart4',               25, 'str',  4],
  ['34', 'customerErrorCode',              4, 'str',  5],
  ['35', 'prevailTorqueCompensateValue',   6, 'x100', 6],
  ['36', 'tighteningErrorStatus2',        10, 'int',  6],
  ['37', 'stationId',                     10, 'int',  7],
  ['38', 'stationName',                   25, 'str',  7],
  ['39', 'startFinalAngle',                6, 'x100', 8],
  ['40', 'postViewTorqueActivated',        1, 'char', 8],
  ['41', 'postViewTorqueHigh',             6, 'x100', 8],
  ['42', 'postViewTorqueLow',              6, 'x100', 8],
  ['43', 'currentMonitoringAmp',           5, 'x100', 9],
  ['44', 'currentMonitoringAmpMin',        5, 'x100', 9],
  ['45', 'currentMonitoringAmpMax',        5, 'x100', 9],
  ['46', 'angleNumeratorScaleFactor',      5, 'int', 10],
  ['47', 'angleDenominatorScaleFactor',    5, 'int', 10],
  ['48', 'overallAngleStatus',             1, 'char',10],
  ['49', 'overallAngleMin',                5, 'int', 10],
  ['50', 'overallAngleMax',                5, 'int', 10],
  ['51', 'overallAngle',                   5, 'int', 10],
  ['52', 'peakTorque',                     6, 'x100',10],
  ['53', 'residualBreakawayTorque',        6, 'x100',10],
  ['54', 'startRundownAngle',              6, 'x100',10],
  ['55', 'rundownAngleComplete',           6, 'x100',10]
];

// MID 0066: Number of offline results.
const MID0066_REV1_FIELDS = [['01', 'offlineResults', 2, 'int']];
const MID0066_REV2_FIELDS = [['01', 'offlineResults', 3, 'int'], ['02', 'offlineCurves', 3, 'int']];

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
  ['15', 'primaryTool',                2, 'int',  4],
  ['16', 'toolModel',                 12, 'str',  5],
  ['17', 'toolNumber',                 4, 'int',  6],
  ['18', 'toolArticleNumber',         30, 'str',  6],
  ['19', 'rundownMinSpeed',            6, 'x100', 7],
  ['20', 'downshiftMaxSpeed',          6, 'x100', 7],
  ['21', 'downshiftMinSpeed',          6, 'x100', 7]
];

// MID 0071 (alarm) and MID 0076 (alarm status). The error code is 4
// characters in revision 1 and 5 from revision 2.
function mid0071Fields(codeWidth) {
  return [
    ['01', 'alarmCode',        codeWidth, 'str'],
    ['02', 'controllerReady',  1, 'bool'],
    ['03', 'toolReady',        1, 'bool'],
    ['04', 'timestamp',       19, 'str'],
    ['05', 'toolHealth',       1, 'char', 3],
    ['06', 'alarmText',       50, 'str',  3]
  ];
}
function mid0076Fields(codeWidth) {
  return [
    ['01', 'alarmActive',      1, 'bool'],
    ['02', 'alarmCode',        codeWidth, 'str'],
    ['03', 'controllerReady',  1, 'bool'],
    ['04', 'toolReady',        1, 'bool'],
    ['05', 'timestamp',       19, 'str'],
    ['06', 'toolHealth',       1, 'char', 3]
  ];
}

// MID 0091: Multi-spindle status. Parameter 05 holds 5 bytes per spindle.
const MID0091_FIELDS = [
  ['01', 'spindleCount',       2, 'int'],
  ['02', 'syncTighteningId',   5, 'int'],
  ['03', 'timestamp',         19, 'str'],
  ['04', 'syncOverallOk',      1, 'bool'],
  ['05', 'spindles', f => 5 * (f.spindleCount || 0), 'spindleStatus']
];

// MID 0101: Multi-spindle result. Parameter 18 holds 18 bytes per spindle.
const MID0101_FIELDS = [
  ['01', 'spindleCount',       2, 'int',  1],
  ['02', 'vin',               25, 'str',  1],
  ['03', 'jobId',              2, 'int',  1],
  ['04', 'paramSetId',         3, 'int',  1],
  ['05', 'batchSize',          4, 'int',  1],
  ['06', 'batchCounter',       4, 'int',  1],
  ['07', 'batchStatus',        1, 'char', 1],
  ['08', 'torqueMin',          6, 'x100', 1],
  ['09', 'torqueMax',          6, 'x100', 1],
  ['10', 'torqueTarget',       6, 'x100', 1],
  ['11', 'angleMin',           5, 'int',  1],
  ['12', 'angleMax',           5, 'int',  1],
  ['13', 'angleTarget',        5, 'int',  1],
  ['14', 'lastPsetChange',    19, 'str',  1],
  ['15', 'timestamp',         19, 'str',  1],
  ['16', 'syncTighteningId',   5, 'int',  1],
  ['17', 'syncOverallOk',      1, 'bool', 1],
  ['18', 'spindles', f => 18 * (f.spindleCount || 0), 'spindleResult', 1],
  ['19', 'systemSubtype',      3, 'int',  4],
  ['20', 'jobSequenceNumber',  5, 'int',  5]
];

// MID 0217 relay function / MID 0221 digital input function.
const MID0217_FIELDS = [['01', 'function', 3, 'int'], ['02', 'active', 1, 'bool']];

const TORQUE_UNITS = {
  '1': 'Nm', '2': 'Lbf.ft', '3': 'Lbf.In', '4': 'Kpm',
  '5': 'Kgf.cm', '6': 'ozf.in', '7': '%', '8': 'Ncm'
};

function toNumber(value) {
  const t = value.trim();
  return t === '' ? null : Number(t);
}

function convertField(value, type) {
  switch (type) {
    case 'int':  return toNumber(value);
    case 'x100': { const n = toNumber(value); return n === null ? null : n / 100; }
    case 'str':  return value.trim();
    case 'bool': return value === '1';
    case 'spindleStatus': {
      const out = [];
      for (let i = 0; i + 5 <= value.length; i += 5) {
        out.push({
          spindle:   Number(value.slice(i, i + 2)),
          channelId: Number(value.slice(i + 2, i + 4)),
          ok:        value[i + 4] === '1'
        });
      }
      return out;
    }
    case 'spindleResult': {
      const out = [];
      for (let i = 0; i + 18 <= value.length; i += 18) {
        const r = value.slice(i, i + 18);
        out.push({
          spindle:      Number(r.slice(0, 2)),
          channelId:    Number(r.slice(2, 4)),
          ok:           r[4] === '1',
          torqueStatus: r[5],
          torque:       toNumber(r.slice(6, 12)) / 100,
          angleStatus:  r[12],
          angle:        toNumber(r.slice(13, 18))
        });
      }
      return out;
    }
    case 'stages': {
      const out = [];
      for (let i = 0; i + 11 <= value.length; i += 11) {
        out.push({ torque: toNumber(value.slice(i, i + 6)) / 100, angle: toNumber(value.slice(i + 6, i + 11)) });
      }
      return out;
    }
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
    // Trailing padding after the last parameter is not a parameter.
    if (p.slice(pos).trim() === '') break;
    const id = p.slice(pos, pos + 2);
    if (!/^\d{2}$/.test(id)) {
      throw new ProtocolError(`MID ${mid}: invalid parameter ID "${id}" at offset ${pos}`, mid);
    }
    if (Number(id) !== lastId + 1) {
      throw new ProtocolError(`MID ${mid}: expected parameter ${lastId + 1}, got ${id} at offset ${pos}`, mid);
    }
    const row = byId.get(id);
    if (!row) { out.unparsed = p.slice(pos); break; }
    const [, name, w, type, minRev = 1] = row;
    const width = typeof w === 'function' ? w(out) : w;
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

// A fixed-width ASCII digit field (left-padded with '0'), range-checked.
function digits(value, width, name, min = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || String(n).length > width) {
    throw new RangeError(`${name} must be an integer ${min}-${'9'.repeat(width)}`);
  }
  return String(n).padStart(width, '0');
}

function nextSeq(seq) { return seq >= 99 ? 1 : seq + 1; }

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
      reconnectAttempts: 0,
      linkLevelAck:      false      // MID 9997/9998 sequence numbering active
    },

    protocol: {
      revision: 1,
      communicationRevision: null,  // MID 0002 revision the controller answered
      subscriptions: {
        tighteningResults:     false,
        alarms:                false,
        multiSpindleStatus:    false,
        multiSpindleResults:   false,
        parameterSetSelection: false,
        lockAtBatchDone:       false,
        jobInfo:               false,
        vin:                   false,
        digitalInputs:         false,
        automaticManualMode:   false,
        commandsDisabled:      false
      }
    },

    controller: {
      ready:            false,
      errorActive:      false,
      errorCode:        null,
      alarms:           [],
      emergencyStop:    false,
      info:             null,       // parsed MID 0002
      mode:             null,       // 'automatic' | 'manual' (MID 0401)
      commandsDisabled: null,       // MID 0421
      time:             null        // MID 0081
    },

    tool: {
      ready:              false,
      enabled:            false,
      running:            false,
      direction:          '—',
      processOn:          false,
      spindleCount:       1,
      spindleCountSource: 'default',
      data:               null,     // last MID 0041 tool data reply
      pairing:            null      // last MID 0048
    },

    product: {
      vin:         null,
      vinRequired: false,
      vinValid:    false,
      vinLocked:   false,
      identifiers: null             // MID 0052 rev 2 identifier parts
    },

    job: {
      jobId:      null,
      paramSetId: null,
      active:     false,
      locked:     false,
      info:       null              // last MID 0035
    },

    batch: {
      batchId:         null,
      size:            null,
      counter:         0,
      status:          null,
      active:          false,
      complete:        false,
      locked:          false,
      lockAtBatchDone: null,        // MID 0022 relay status
      pendingReset:    false
    },

    io: {
      digitalInputs:         null,  // MID 0211, inputs 1-8
      relayFunctions:        {},    // MID 0217 by function number
      digitalInputFunctions: {}     // MID 0221 by function number
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
    revisionValid: /^(\d{3}| {3})$/.test(frame.slice(8, 11)),
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
    maxRevision            = null,
    communicationRevision  = 1,
    linkLevelAck           = false,
    commandTimeout         = COMMAND_TIMEOUT_MS
  }) {
    super();
    this.host                   = host;
    this.port                   = port;
    this.autoReconnect          = autoReconnect;
    this.validateFrames         = validateFrames;
    this.configuredSpindleCount = spindleCount;
    this.allowDuplicateCommands = allowDuplicateCommands;
    this.commandTimeout         = commandTimeout;

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

    // MID 0001 revision = the MID 0002 revision asked for. Link-level
    // acknowledging (sequence numbers + MID 9997/9998) needs revision 6+.
    this.communicationRevision = linkLevelAck
      ? Math.max(6, communicationRevision)
      : communicationRevision;
    this._commRevision = this.communicationRevision;

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
    this._queue         = [];       // commands waiting for the wire
    this._active        = null;     // the one outstanding command (§3.2.1)
    this._keepAliveTs   = null;     // when an unanswered MID 9999 was sent
    this._parts         = new Map();// multi-part reassembly by MID
    this._resetLink();
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
        this._startCommunication();
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

  // MID 0001 is the first message after connecting (spec §3.1). Its header
  // revision selects the MID 0002 revision; MID 0004 error 97 steps it down.
  _startCommunication() {
    this._resetLink();
    let payload = '';
    // Rev 7: "01" + 0 = keep alive mandatory (the client always sends one).
    if (this._commRevision >= 7) payload = '010';
    this.sendMID(1, payload, false, this._commRevision);
  }

  // MID 0003 Communication stop (integrator → controller), then close.
  disconnect() {
    this.autoReconnect = false;
    this._stopReconnect();
    if (this.socket) {
      if (this.state.connection.connected) {
        try { this._writeFrame(3, '', 1, ''); } catch (_) { /* socket gone */ }
      }
      this.socket.destroy();
    }
  }

  _onClose() {
    const wasConnected = this.state.connection.connected;

    this._stopHeartbeat();
    this._clearWatchdog();
    this._clearPendingCommands();
    this._resetLink();

    this.state.connection.connected      = false;
    this.state.connection.linkLayerReady = false;
    this.buffer               = Buffer.alloc(0);
    this._parts.clear();
    this._keepAliveTs         = null;
    this._pendingRevision     = this.profile.maxRevision;
    this._commRevision        = this.communicationRevision;

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
    for (const k of Object.keys(this.state.protocol.subscriptions)) {
      this.state.protocol.subscriptions[k] = false;
    }

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

  // Spec §3.3.5: over TCP, a missing answer means the connection is lost and
  // a new one must be established.
  _linkLost(reason) {
    this.emit('linkTimeout', { reason });
    if (this.socket) this.socket.destroy();
  }

  /* =======================================================
     Heartbeat
     ======================================================= */

  // MID 9999: send a keep-alive after HEARTBEAT_INTERVAL_MS without traffic
  // in either direction (spec §5.28.1). The controller mirrors it; no answer
  // within the response timeout means the link is lost.
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.state.connection.connected) return;
      const now = Date.now();
      if (this._keepAliveTs !== null && now - this._keepAliveTs >= this.commandTimeout) {
        this._keepAliveTs = null;
        this._linkLost('keep-alive not answered');
        return;
      }
      if (now - this.lastTrafficTs >= HEARTBEAT_INTERVAL_MS) {
        if (this._keepAliveTs === null) this._keepAliveTs = now;
        this.sendMID(9999);
      }
    }, 1000);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _touchTraffic() { this.lastTrafficTs = Date.now(); }

  /* =======================================================
     Framing
     ======================================================= */

  /**
   * Send a MID. `revision` goes in the header Rev field: Open Protocol
   * selects the MID revision there, never in the data field.
   *
   * With `expectAck`, the message is a request, command or subscription and
   * the returned promise settles on its answer: MID 0005, the request's reply
   * MID, or MID 0004. Only one such message is outstanding at a time (spec
   * §3.2.1); later ones wait in a queue.
   *
   * opts.replyMid  reply MID that answers this request (default REPLY_FOR)
   * opts.ackMid    MID number MID 0005 carries (MID 0008/0009: the data MID)
   * opts.front     queue ahead of waiting commands (revision retries)
   */
  sendMID(mid, payload = '', expectAck = false, revision = 1, opts = {}) {
    if (Buffer.byteLength(payload, 'latin1') > MAX_DATA_SIZE) {
      throw new ProtocolError(`MID ${mid}: data exceeds ${MAX_DATA_SIZE} bytes`, mid);
    }

    if (!expectAck) { this._send(mid, payload, revision); return; }

    if (!this.allowDuplicateCommands) {
      const busy = (this._active && this._active.mid === mid) || this._queue.some(c => c.mid === mid);
      if (busy && !opts.front) {
        throw new CommandError(`Command MID ${mid} already pending - wait for ACK or NAK`, mid);
      }
    }

    const cmdId = ++this.commandSeq;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const cmd = {
      id: cmdId, mid, payload, revision,
      replyMid:  opts.replyMid !== undefined ? opts.replyMid : (REPLY_FOR[mid] ?? null),
      ackMid:    opts.ackMid ?? mid,
      timestamp: Date.now(), resolve, reject, timeout: null
    };

    this.state.pendingCommands.set(cmdId, cmd);
    this._lastCommandId = cmdId;
    if (opts.front) this._queue.unshift(cmd); else this._queue.push(cmd);
    this._pumpQueue();
    return promise;
  }

  _pumpQueue() {
    if (this._active || !this._queue.length) return;
    const cmd = this._queue.shift();
    this._active = cmd;
    cmd.timeout = setTimeout(() => {
      if (this._active !== cmd) return;
      this._active = null;
      this.state.pendingCommands.delete(cmd.id);
      cmd.reject(new CommandError(`MID ${cmd.mid} ACK timeout after ${this.commandTimeout} ms`, cmd.mid));
      this.emit('commandTimeout', { mid: cmd.mid, cmdId: cmd.id });
      this._linkLost(`no answer to MID ${cmd.mid}`);
      this._pumpQueue();
    }, this.commandTimeout);
    if (cmd.timeout.unref) cmd.timeout.unref();
    this._send(cmd.mid, cmd.payload, cmd.revision);
  }

  // All TX goes through here. With link-level acknowledging, data messages
  // get a sequence number and wait for MID 9997 one at a time (§3.2.2).
  _send(mid, payload, revision) {
    this._touchTraffic();
    if (this._link.enabled && mid !== 9997 && mid !== 9998 && mid !== 9999) {
      this._link.queue.push({ mid, payload, revision });
      this._pumpLink();
      return;
    }
    this._writeFrame(mid, payload, revision, '');
  }

  _writeFrame(mid, payload, revision, seq) {
    const midStr  = mid.toString().padStart(4, '0');
    const rev     = revision.toString().padStart(3, '0');
    // No Ack flag (§2.2.2) is only meaningful on subscriptions: '0' asks the
    // controller for reliable mode, where each push is acknowledged.
    const noAck   = '0';
    const station = '01';
    const spindle = '01';
    // SeqNo(2) + NoOfParts(1) + PartNo(1): blank = unused.
    const seqStr  = seq === '' ? '  ' : String(seq).padStart(2, '0');
    const spare   = `${seqStr}  `;

    const body  = `${midStr}${rev}${noAck}${station}${spindle}${spare}${payload}`;
    // Length counts bytes; frames are written as latin1 so 1 char = 1 byte.
    const len   = (Buffer.byteLength(body, 'latin1') + 4).toString().padStart(4, '0');
    this.socket.write(Buffer.from(`${len}${body}\0`, 'latin1'));
  }

  /* -------------------- link level (MID 9997/9998) -------------------- */

  _resetLink() {
    if (this._link && this._link.timer) clearTimeout(this._link.timer);
    this._link = {
      enabled:     false,
      txSeq:       1,
      rxExpected:  1,
      lastRx:      null,       // { seq, mid } of the last accepted message
      outstanding: null,
      queue:       [],
      timer:       null
    };
    this.state.connection.linkLevelAck = false;
  }

  _pumpLink() {
    const L = this._link;
    if (L.outstanding || !L.queue.length) return;
    const m = L.queue.shift();
    m.seq = L.txSeq;
    L.outstanding = m;
    this._transmitLink(m);
  }

  _transmitLink(m) {
    const L = this._link;
    this._writeFrame(m.mid, m.payload, m.revision, m.seq);
    clearTimeout(L.timer);
    L.timer = setTimeout(() => {
      if (L.outstanding !== m) return;
      this._linkLost(`no MID 9997 for MID ${m.mid}`);
    }, this.commandTimeout);
    if (L.timer.unref) L.timer.unref();
  }

  // Returns false when the frame must not reach the application layer
  // (retransmission or out-of-sequence).
  _linkReceive(header, payload) {
    const L   = this._link;
    const mid = header.mid;
    const midStr = String(mid).padStart(4, '0');

    // MID 9997 carries the acknowledged MID.
    if (mid === 9997) {
      const m = L.outstanding;
      if (m && Number(payload.slice(0, 4)) === m.mid) {
        clearTimeout(L.timer);
        L.txSeq       = nextSeq(m.seq);
        L.outstanding = null;
        this._pumpLink();
      }
      return false;
    }

    if (mid === 9998) return false;   // handled in _handleLinkError

    const seq = header.seqNo;
    if (!(seq >= 1 && seq <= 99)) return true;    // not sequence numbered

    if (!header.revisionValid) {
      this._writeFrame(9998, `${midStr}0002`, 1, nextSeq(seq));
      return false;
    }
    if ((header.parts || header.partNo) &&
        !(header.parts >= 1 && header.partNo >= 1 && header.partNo <= header.parts)) {
      this._writeFrame(9998, `${midStr}0004`, 1, nextSeq(seq));
      return false;
    }

    if (seq === L.rxExpected) {
      this._writeFrame(9997, midStr, 1, nextSeq(seq));
      L.lastRx     = { seq, mid };
      L.rxExpected = nextSeq(seq);
      return true;
    }
    if (L.lastRx && seq === L.lastRx.seq) {
      // Retransmission: same acknowledge, no application handling.
      this._writeFrame(9997, midStr, 1, nextSeq(seq));
      return false;
    }
    this._writeFrame(9998, `${midStr}0003`, 1, L.rxExpected);
    return false;
  }

  _handleLinkError(header, data) {
    const L    = this._link;
    const mid  = Number(data.slice(0, 4));
    const code = Number(data.slice(4, 8));
    const info = { mid, errorCode: code, message: LINK_ERROR_CODES[code] || 'Unknown link error' };
    const m    = L.outstanding;

    // Wrong sequence number: the header carries the one the controller
    // expects. Retransmit with it (spec Figure 10).
    if (code === 3 && m && header.seqNo >= 1 && header.seqNo <= 99) {
      m.seq   = header.seqNo;
      L.txSeq = header.seqNo;
      this._transmitLink(m);
      this.emit('linkError', info);
      return;
    }

    if (m) {
      clearTimeout(L.timer);
      L.outstanding = null;
      L.txSeq       = nextSeq(m.seq);
      if (this._active && this._active.mid === m.mid) {
        this._settleActive(false, { failedMid: m.mid, errorCode: null, message: `Link error: ${info.message}` });
      }
      this._pumpLink();
    }
    this.emit('linkError', info);
  }

  /* -------------------- RX -------------------- */

  _onData(data) {
    this._touchTraffic();
    this._keepAliveTs = null;
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
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    const header = parseHeader(frame);
    const mid    = header.mid;
    let payload  = frame.slice(HEADER_SIZE);

    if (this._link.enabled) {
      if (mid === 9998) { this._handleLinkError(header, payload); return; }
      if (!this._linkReceive(header, payload)) return;
    }

    // Multi-part message (§2.2.6): collect the parts, then handle the whole.
    if (header.parts > 1) {
      const parts = this._parts.get(mid) || [];
      parts[header.partNo - 1] = payload;
      if (header.partNo < header.parts) { this._parts.set(mid, parts); return; }
      this._parts.delete(mid);
      payload = parts.join('');
    }

    // Acknowledge subscription data before parsing, so a malformed message
    // still releases the controller's next push.
    this._ackPush(mid);

    try {
      const parsed = this._parseMID(mid, payload, header.revision);
      this._handleMID(mid, parsed, header);
    } catch (err) {
      this.emit('parseError', { mid, error: err.message });
    }
  }

  // Integrator acknowledge of a subscription push (spec Table 7). With
  // link-level acknowledging MID 9997 replaces these (§3.9.2).
  _ackPush(mid) {
    if (this._link.enabled) return;
    if (this._active && this._active.replyMid === mid) return;   // a request reply
    if (PUSH_ACK[mid]) this._send(PUSH_ACK[mid], '', 1);
    else if (PUSH_ACK_0005.has(mid)) this._send(5, String(mid).padStart(4, '0'), 1);
  }

  /* =======================================================
     MID Parsers
     ======================================================= */

  // `rev` is the header revision the controller actually sent this frame at
  // (blank/000/001 => 1); layouts must follow it, not the requested revision.
  _parseMID(mid, p, rev) {
    this._rxRevision = rev || null;
    switch (mid) {

      // MID 0002: tagged controller information (revisions 1-7).
      // A malformed MID 0002 must not stop the link coming up.
      case 2:
        try {
          return { ...parseTagged(2, p, MID0002_FIELDS).fields, revision: rev || 1 };
        } catch (err) {
          return { parseError: err.message, raw: p, revision: rev || 1 };
        }

      // MID 0004 rev 1: failed MID(4) + error code(2).
      case 4: {
        const errorCode = toNumber(p.slice(4, 6));
        return {
          failedMid: Number(p.slice(0, 4)),
          errorCode,
          message:   ERROR_CODES[errorCode] || `Error ${errorCode}`
        };
      }

      case 5:
        return { acceptedMid: Number(p.slice(0, 4)) };

      // MID 0011: parameter set ID upload reply.
      case 11: {
        const count = Number(p.slice(0, 3));
        const ids   = [];
        for (let i = 0; i < count; i++) ids.push(Number(p.slice(3 + i * 3, 6 + i * 3)));
        const out = { count, paramSetIds: ids };
        let pos = 3 + count * 3;
        if (rev >= 2) { out.stages = []; for (let i = 0; i < count; i++, pos += 2) out.stages.push(Number(p.slice(pos, pos + 2))); }
        if (rev >= 3) { out.types  = []; for (let i = 0; i < count; i++, pos += 4) out.types.push(p.slice(pos, pos + 4).trim()); }
        if (rev >= 4) { out.lastChanges = []; for (let i = 0; i < count; i++, pos += 19) out.lastChanges.push(p.slice(pos, pos + 19)); }
        return out;
      }

      // MID 0013: parameter set data. Revisions 3-4 are Toyota-specific.
      case 13:
        if (rev === 3 || rev === 4) return { psetFileVersion: p.slice(0, 8), raw: p.slice(8), revision: rev };
        return { ...parseTagged(13, p, MID0013_FIELDS).fields, revision: rev || 1 };

      // MID 0015: parameter set selected.
      case 15:
        if (rev >= 2) return { ...parseTagged(15, p, MID0015_REV2_FIELDS).fields, revision: rev };
        return { paramSetId: Number(p.slice(0, 3)), lastPsetChange: p.slice(3, 22), revision: 1 };

      // MID 0022: lock at batch done relay status.
      case 22:
        return { relayStatus: p[0] === '1' };

      // MID 0031: Job ID upload reply. Rev 1: 2-digit count and IDs; rev 2: 4.
      case 31: {
        const w     = rev >= 2 ? 4 : 2;
        const count = Number(p.slice(0, w));
        const jobIds = [];
        for (let i = 0; i < count; i++) jobIds.push(Number(p.slice(w + i * w, 2 * w + i * w)));
        return { count, jobIds };
      }

      case 33: return this._parse0033(p, rev);

      case 35: {
        const { fields, revision } =
          parseTaggedByRevision(35, p, rev, MID0035_REV1_FIELDS, MID0035_REV2_FIELDS);
        return { ...fields, revision };
      }

      // MID 0041: Tool data upload reply (answer to MID 0040). Tagged tool
      // identity and service data; it carries no ready/running status.
      case 41:
        return parseTagged(41, p, MID0041_FIELDS).fields;

      case 48:
        return parseTagged(48, p, MID0048_FIELDS).fields;

      // MID 0052: rev 1 = VIN only (untagged), rev 2 = tagged identifiers.
      case 52:
        if (rev >= 2) return { ...parseTagged(52, p, MID0052_REV2_FIELDS).fields, revision: rev };
        return { vin: p.trim(), revision: 1 };

      case 61:  return this._parse0061(p, rev);
      case 65:  return this._parse0065(p, rev);

      case 66:
        return parseTagged(66, p, rev >= 2 ? MID0066_REV2_FIELDS : MID0066_REV1_FIELDS).fields;

      case 71: {
        const { fields, revision } =
          parseTaggedByRevision(71, p, rev, mid0071Fields(4), mid0071Fields(5));
        return { ...fields, revision };
      }

      case 74:
        return { alarmCode: p.trim() };

      case 76: {
        const { fields, revision } =
          parseTaggedByRevision(76, p, rev, mid0076Fields(4), mid0076Fields(5));
        return { ...fields, revision };
      }

      case 81:
        return { time: p.slice(0, 19) };

      case 91:
        return parseTagged(91, p, MID0091_FIELDS).fields;

      case 101: {
        const { fields } = parseTagged(101, p, MID0101_FIELDS);
        return { ...fields, revision: rev || 1 };
      }

      // MID 0211: status of the eight externally monitored digital inputs.
      case 211:
        return { inputs: p.slice(0, 8).split('').map(c => c === '1') };

      case 217:
      case 221:
        return parseTagged(mid, p, MID0217_FIELDS).fields;

      case 401:
        return { mode: p[0] === '1' ? 'manual' : 'automatic' };

      case 411:
        return { autoDisable: Number(p.slice(0, 2)), currentBatch: Number(p.slice(2, 4)) };

      case 421:
        return { commandsDisabled: p[0] === '1' };

      default:
        return { raw: p };
    }
  }

  /**
   * MID 0061: Last tightening result data.
   * The layout is selected by the header revision:
   *   1     tagged, parameters 01-23
   *   2-10  tagged, parameters 01-46, plus 47-49 (rev 3), 50-52 (rev 4),
   *         53 (rev 5), 54-55 (rev 6), 56-57 (rev 7), 58-61 (rev 8),
   *         62-64 (rev 9), 65-74 (rev 10)
   *   998   rev 6 parameters plus multistage stage results (56-58)
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
      let parsed;
      if (rev === 999)      parsed = { fields: parsePositional(61, p, MID0061_REV999_FIELDS), revision: 999 };
      else if (rev === 998) parsed = { fields: parseTagged(61, p, MID0061_REV998_FIELDS).fields, revision: 998 };
      else parsed = parseTaggedByRevision(61, p, rev, MID0061_REV1_FIELDS, MID0061_REV2_FIELDS);
      return this._normalizeResult(parsed.fields, parsed.revision);
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

  // MID 0033: Job data. Parameters 01-12, then 13 = Job list of N entries
  // separated by ';' with ':' between the entry's fields.
  _parse0033(p, rev) {
    const { fields } = parseTagged(33, p, mid0033Fields(rev >= 2 ? 4 : 2));
    const rest = fields.unparsed || '';
    delete fields.unparsed;
    const list = rest.startsWith('13') ? rest.slice(2) : '';
    const names = rev >= 4
      ? ['channelId', 'paramSetId', 'autoValue', 'batchSize', 'identifierNumber', 'stepName', 'stepType', 'maxCoherentNok']
      : rev === 3
        ? ['channelId', 'paramSetId', 'autoValue', 'batchSize', 'socket', 'stepName', 'stepType']
        : ['channelId', 'paramSetId', 'autoValue', 'batchSize'];
    fields.jobList = list.split(';').filter(e => e.length).map(entry => {
      const values = entry.split(':');
      const out = {};
      names.forEach((n, i) => {
        const v = values[i] ?? '';
        out[n] = n === 'stepName' || n === 'autoValue' ? v.trim() : toNumber(v);
      });
      return out;
    });
    fields.revision = rev || 1;
    return fields;
  }

  _normalizeResult(fields, revision) {
    const d = { revision, ...fields };
    d.ok = fields.tighteningStatus === '1';
    if (fields.torqueUnit !== undefined) d.torqueUnitName = TORQUE_UNITS[fields.torqueUnit] || null;
    d.spindle = 1;   // MID 0061/0065 carry no spindle number
    return d;
  }

  /* =======================================================
     MID → State
     ======================================================= */

  _handleMID(mid, d, header = {}) {
    this.state.connection.lastMID = mid;
    this.emit('mid', { mid, revision: header.revision ?? null, data: d });

    // A request's reply MID is its positive answer (§4.1), including the
    // data MID asked for with MID 0006.
    if (this._active && this._active.replyMid === mid && mid !== 4 && mid !== 5) {
      this._settleActive(true, d);
    }

    switch (mid) {

      // MID 0002: communication start acknowledged.
      case 2: {
        const info = { ...d };
        delete info.unparsed;
        this.state.controller.info             = info;
        this.state.protocol.communicationRevision = d.revision;
        this.state.connection.linkLayerReady   = true;
        this.state.controller.ready            = true;

        // Started at rev 6+ and the controller supports sequence numbers:
        // link-level acknowledging is in use (§3.2, §3.9.1).
        if (this._commRevision >= 6 && d.sequenceNumberSupport) {
          this._resetLink();
          this._link.enabled = true;
          this.state.connection.linkLevelAck = true;
        }

        this.emit('linkEstablished', { ...info, revision: d.revision });
        this.subscribeTighteningResults();
        if (this.profile.supportsAlarms) this.subscribeAlarms();
        break;
      }

      case 4:
        this._resolvePendingCommand(d.failedMid, false, d);
        this.emit('commandError', d);

        // MID 0001 rejected: step the requested MID 0002 revision down.
        if (d.failedMid === 1) {
          if (REVISION_UNSUPPORTED.has(d.errorCode) && this._commRevision > 1) {
            this._commRevision--;
            this._startCommunication();
          } else {
            this.emit('communicationRejected', d);
          }
          break;
        }

        if (d.failedMid === 60 && this._pendingRevision > 1 && REVISION_UNSUPPORTED.has(d.errorCode)) {
          const next = this._pendingRevision - 1;
          this.emit('revisionDowngrade', { from: this._pendingRevision, to: next });
          this.subscribeTighteningResults(next, true);
          break;
        }

        if (d.failedMid === 60 && REVISION_UNSUPPORTED.has(d.errorCode)) {
          this.emit('revisionNegotiationFailed', {
            errorCode: d.errorCode,
            message:   d.message
          });
          break;
        }

        if (this.state.batch.pendingReset && d.failedMid === 20) {
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

        if (d.acceptedMid === this.profile.jobSelectMid && this._pendingJobId !== undefined) {
          this.state.job.jobId  = this._pendingJobId;
          this.state.job.active = true;
          this.emit('jobSelected', { jobId: this._pendingJobId });
          this._pendingJobId = undefined;
        }

        if (d.acceptedMid === 18 && this._pendingParamSetId !== undefined) {
          this.state.job.paramSetId = this._pendingParamSetId;
          this._pendingParamSetId = undefined;
        }

        if (d.acceptedMid === 127) {
          this.state.job.active = false;
          this.emit('jobAborted');
        }

        if (this.state.batch.pendingReset && d.acceptedMid === 20) {
          this.state.batch.counter      = 0;
          this.state.batch.complete     = false;
          this.state.batch.pendingReset = false;
          this.emit('batchResetConfirmed');
        }
        break;

      // Request replies: the reply is the positive answer (§4.1).
      case 11:
        this.emit('parameterSetIds', d);
        break;

      case 13:
        this.emit('parameterSetData', d);
        break;

      // MID 0015: a parameter set was selected on the controller.
      case 15:
        this.state.job.paramSetId = d.paramSetId;
        this.emit('parameterSetSelected', d);
        break;

      // MID 0022: lock at batch done relay status.
      case 22:
        this.state.batch.lockAtBatchDone = d.relayStatus;
        this.state.batch.locked          = d.relayStatus;
        this.emit('lockAtBatchDone', d);
        break;

      case 31:
        this.emit('jobIds', d);
        break;

      case 33:
        this.emit('jobData', d);
        break;

      // MID 0035: Job info (after Job selection and after each tightening).
      case 35: {
        const prevJob = this.state.job.jobId;
        this.state.job.info   = d;
        this.state.job.jobId  = d.jobId;
        // 0 = Job not completed; 1 OK, 2 NOK, 3 aborted, 4 restart (rev 4).
        this.state.job.active = d.jobId > 0 && (d.jobStatus === '0' || d.jobStatus === '4');
        if (d.jobId !== prevJob) this.emit('jobSelected', { jobId: d.jobId });
        this.emit('jobInfo', d);
        break;
      }

      // MID 0041 is the reply to a MID 0040 tool data request. It holds tool
      // identity and service counters, not tool/controller status.
      case 41:
        this.state.tool.data = d;
        this.emit('toolData', d);
        break;

      case 48:
        this.state.tool.pairing = d;
        this.emit('toolPairingStatus', d);
        break;

      // MID 0052: the controller's current VIN / identifiers.
      case 52:
        this.state.product.vin      = d.vin;
        this.state.product.vinValid = d.vin.length > 0;
        if (d.revision >= 2) {
          this.state.product.identifiers = {
            part2: d.identifierPart2, part3: d.identifierPart3, part4: d.identifierPart4
          };
        }
        this.emit('vin', d);
        break;

      // MID 0061: the controller holds the next result until it receives the
      // acknowledge for this one (sent by _ackPush before parsing).
      case 61:
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
        break;

      case 66:
        this.emit('offlineResults', d);
        break;

      // MID 0071: an alarm appeared.
      case 71:
        this.state.controller.alarms.push(d);
        this.state.controller.errorActive = true;
        this.state.controller.errorCode   = d.alarmCode;
        this.state.controller.ready       = d.controllerReady;
        this.state.tool.ready             = d.toolReady;
        this.emit('alarm', d);
        break;

      // MID 0074: the current alarm was acknowledged on the controller.
      case 74:
        this.state.controller.alarms = this.state.controller.alarms.filter(a => a.alarmCode !== d.alarmCode);
        if (!this.state.controller.alarms.length) {
          this.state.controller.errorActive = false;
          this.state.controller.errorCode   = null;
        }
        this.emit('alarmAcknowledged', d);
        break;

      // MID 0076: alarm status, sent once after the alarm subscription.
      case 76:
        this.state.controller.errorActive = d.alarmActive;
        this.state.controller.errorCode   = d.alarmActive ? d.alarmCode : null;
        if (!d.alarmActive) this.state.controller.alarms = [];
        this.state.controller.ready = d.controllerReady;
        this.state.tool.ready       = d.toolReady;
        this.emit('alarmStatus', d);
        break;

      case 81:
        this.state.controller.time = d.time;
        this.emit('controllerTime', d);
        break;

      case 91:
        if (d.spindleCount > 0 && this.state.tool.spindleCountSource !== 'config' &&
            this.state.tool.spindleCountSource !== 'manual') {
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

      case 211:
        this.state.io.digitalInputs = d.inputs;
        this.emit('digitalInputs', d);
        break;

      case 215:
        this.emit('ioDeviceStatus', d);
        break;

      case 217:
        this.state.io.relayFunctions[d.function] = d.active;
        this.emit('relayFunction', d);
        break;

      case 221:
        this.state.io.digitalInputFunctions[d.function] = d.active;
        this.emit('digitalInputFunction', d);
        break;

      case 401:
        this.state.controller.mode = d.mode;
        this.emit('automaticManualMode', d);
        break;

      case 411:
        this.emit('autoDisableSettings', d);
        break;

      case 421:
        this.state.controller.commandsDisabled = d.commandsDisabled;
        this.emit('commandsDisabled', d);
        break;

    }

    this.emit('stateChanged', this.getState());
  }

  // Settles the outstanding command if `mid` answers it (MID 0004/0005 carry
  // the request's MID; a reply MID answers its request).
  _resolvePendingCommand(mid, success, data = null) {
    const cmd = this._active;
    if (!cmd || (cmd.mid !== mid && cmd.ackMid !== mid && cmd.replyMid !== mid)) return;
    this._settleActive(success, data);
  }

  _settleActive(success, data) {
    const cmd = this._active;
    clearTimeout(cmd.timeout);
    this._active = null;
    this.state.pendingCommands.delete(cmd.id);
    if (success) {
      cmd.resolve(cmd.replyMid !== null && data ? data : { mid: cmd.mid, cmdId: cmd.id });
      this.emit('commandSuccess', { mid: cmd.mid, cmdId: cmd.id, data });
    } else {
      const err = new CommandError(data?.message || `MID ${cmd.mid} rejected by controller`, cmd.mid);
      err.errorCode = data?.errorCode ?? null;
      cmd.reject(err);
      this.emit('commandFailed', { mid: cmd.mid, cmdId: cmd.id, data });
    }
    // Deferred so handlers reacting to this answer (revision retries) can
    // queue ahead of the waiting commands first.
    queueMicrotask(() => this._pumpQueue());
  }

  _clearPendingCommands() {
    const all = [...(this._active ? [this._active] : []), ...this._queue];
    this._active = null;
    this._queue  = [];
    for (const cmd of all) {
      clearTimeout(cmd.timeout);
      cmd.reject(new CommandError(`MID ${cmd.mid} aborted — connection closed`, cmd.mid));
      this.emit('commandAborted', { mid: cmd.mid, cmdId: cmd.id });
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
    this._updateBatch(d);

    if (this.state.tightening.pendingSpindles.size < this.state.tool.spindleCount) {
      // Not all spindles received yet — withhold cycle completion.
      return;
    }

    // All spindle results for this cycle have arrived.
    this._clearWatchdog();

    const results   = [...this.state.tightening.pendingSpindles.values()];
    const overallOk = results.every(r => r.ok);

    this.state.tightening.pendingSpindles.clear();
    this.state.tightening.inProgress = false;

    this.emit('tighteningCycleCompleted', {
      results,
      overallOk,
      duration: Date.now() - this.state.tightening.cycleStartTs
    });
  }

  // The parameter set batch is the controller's: mirror the batch size,
  // counter and status each MID 0061 reports. Batch status: 0 NOK,
  // 1 OK (completed), 2 not used, 3 running.
  _updateBatch(d) {
    if (d.batchStatus === undefined || d.batchStatus === '2' || !d.batchSize) return;
    const b = this.state.batch;
    const wasActive   = b.active;
    const wasComplete = b.complete;

    b.batchId  = d.paramSetId ?? b.batchId;
    b.size     = d.batchSize;
    b.counter  = d.batchCounter;
    b.status   = d.batchStatus;
    b.complete = d.batchStatus === '1';
    b.active   = !b.complete;

    if (!wasActive && (b.active || b.counter === 1)) this.emit('batchStarted', { ...b });
    this.emit('batchProgress', {
      counter:   b.counter,
      size:      b.size,
      remaining: Math.max(0, b.size - b.counter)
    });
    if (b.complete && !wasComplete) this.emit('batchCompleted', { ...b });
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
    if (this.state.tightening.watchdog.unref) this.state.tightening.watchdog.unref();
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

  // Subscribe with the given header revision; on MID 0004 "revision
  // unsupported" the subscription is retried one revision lower.
  _subscribe(key, mid, revision = 1, payload = '') {
    this.state.protocol.subscriptions[key] = true;
    return this._withDowngrade(mid, payload, revision).catch(err => {
      this.state.protocol.subscriptions[key] = false;
      throw err;
    });
  }

  _withDowngrade(mid, payload, revision, front = false) {
    return this.sendMID(mid, payload, true, revision, { front }).catch(err => {
      if (revision > 1 && REVISION_UNSUPPORTED.has(err.errorCode)) {
        this.emit('midRevisionDowngrade', { mid, from: revision, to: revision - 1 });
        return this._withDowngrade(mid, payload, revision - 1, true);
      }
      throw err;
    });
  }

  _unsubscribe(key, mid, payload = '') {
    this.state.protocol.subscriptions[key] = false;
    return this.sendMID(mid, payload, true);
  }

  // MID 0060 → MID 0061 pushes, each acknowledged with MID 0062.
  subscribeTighteningResults(revision = null, _retry = false) {
    const rev = revision !== null ? revision : this.profile.maxRevision;
    this._pendingRevision = rev;
    this.state.protocol.subscriptions.tighteningResults = true;
    const p = this.sendMID(60, '', true, rev, { front: _retry });
    p.catch(() => {});
    return p;
  }

  unsubscribeTighteningResults() {
    return this._unsubscribe('tighteningResults', 63);
  }

  // MID 0070 → MID 0071 alarms (ACK 0072), MID 0074 (ACK 0075), MID 0076 (ACK 0077).
  subscribeAlarms(revision = 1) {
    const p = this._subscribe('alarms', 70, revision);
    p.catch(() => {});
    return p;
  }

  unsubscribeAlarms() { return this._unsubscribe('alarms', 73); }

  // MID 0078: acknowledge the current alarm on the controller.
  acknowledgeAlarm() {
    const p = this.sendMID(78, '', true);
    p.catch(err => this.emit('commandError', { mid: 78, message: err.message }));
    return p;
  }

  // MID 0014 → MID 0015 (ACK 0016). Revision 2 adds pset name and limits.
  subscribeParameterSetSelection(revision = 1) { return this._subscribe('parameterSetSelection', 14, revision); }
  unsubscribeParameterSetSelection()           { return this._unsubscribe('parameterSetSelection', 17); }

  // MID 0021 → MID 0022 (ACK 0023): lock at batch done relay status.
  subscribeLockAtBatchDone()   { return this._subscribe('lockAtBatchDone', 21); }
  unsubscribeLockAtBatchDone() { return this._unsubscribe('lockAtBatchDone', 24); }

  // MID 0034 → MID 0035 (ACK 0036). Revisions 1-5.
  subscribeJobInfo(revision = 1) { return this._subscribe('jobInfo', 34, revision); }
  unsubscribeJobInfo()           { return this._unsubscribe('jobInfo', 37); }

  // MID 0051 → MID 0052 (ACK 0053). Revision 2 adds identifier parts 2-4.
  subscribeVIN(revision = 1) { return this._subscribe('vin', 51, revision); }
  unsubscribeVIN()           { return this._unsubscribe('vin', 54); }

  // MID 0090 → MID 0091 (ACK 0092). Must be sent to the sync master.
  subscribeMultiSpindleStatus() {
    const p = this._subscribe('multiSpindleStatus', 90);
    p.catch(() => {});
    return p;
  }

  unsubscribeMultiSpindleStatus() { return this._unsubscribe('multiSpindleStatus', 93); }

  // MID 0100 → MID 0101 (ACK 0102). Revision 2+ takes a "Data No System" to
  // rewind to; revision 3+ adds "send only new data".
  subscribeMultiSpindleResults(revision = 1, { dataNoSystem = 0, onlyNew = false } = {}) {
    let payload = '';
    if (revision >= 2) payload += digits(dataNoSystem, 10, 'dataNoSystem');
    if (revision >= 3) payload += onlyNew ? '1' : '0';
    const p = this._subscribe('multiSpindleResults', 100, revision, payload);
    p.catch(() => {});
    return p;
  }

  unsubscribeMultiSpindleResults() { return this._unsubscribe('multiSpindleResults', 103); }

  // MID 0210 → MID 0211 (ACK 0212): the eight externally monitored inputs.
  subscribeDigitalInputs()   { return this._subscribe('digitalInputs', 210); }
  unsubscribeDigitalInputs() { return this._unsubscribe('digitalInputs', 213); }

  // MID 0216 → MID 0217 (ACK 0218), one relay function per subscription.
  subscribeRelayFunction(fn) {
    return this.sendMID(216, digits(fn, 3, 'relay function'), true);
  }
  unsubscribeRelayFunction(fn) {
    return this.sendMID(219, digits(fn, 3, 'relay function'), true);
  }

  // MID 0220 → MID 0221 (ACK 0222), one digital input function per subscription.
  subscribeDigitalInputFunction(fn) {
    return this.sendMID(220, digits(fn, 3, 'digital input function'), true);
  }
  unsubscribeDigitalInputFunction(fn) {
    return this.sendMID(223, digits(fn, 3, 'digital input function'), true);
  }

  // MID 0400 → MID 0401 (ACK 0402).
  subscribeAutomaticManualMode()   { return this._subscribe('automaticManualMode', 400); }
  unsubscribeAutomaticManualMode() { return this._unsubscribe('automaticManualMode', 403); }

  // MID 0420 → MID 0421 (ACK 0422).
  subscribeCommandsDisabled()   { return this._subscribe('commandsDisabled', 420); }
  unsubscribeCommandsDisabled() { return this._unsubscribe('commandsDisabled', 423); }

  // MID 0008 generic subscription. The header revision is MID 0008's own;
  // `revision` is the wanted revision of the data MID. MID 0005 answers
  // with the data MID.
  subscribe(mid, revision = 1, extraData = '') {
    const payload = digits(mid, 4, 'MID') + digits(revision, 3, 'revision') +
      digits(extraData.length, 2, 'extra data length') + extraData;
    return this.sendMID(8, payload, true, 1, { ackMid: mid });
  }

  // MID 0009 generic unsubscribe.
  unsubscribe(mid, revision = 1, extraData = '') {
    const payload = digits(mid, 4, 'MID') + digits(revision, 3, 'revision') +
      digits(extraData.length, 2, 'extra data length') + extraData;
    return this.sendMID(9, payload, true, 1, { ackMid: mid });
  }

  /* =======================================================
     Public API — Commands
     ======================================================= */

  // Open Protocol has no "start" command: this enables the tool (MID 0043)
  // after the interlock checks, and the operator starts the tightening.
  startTightening() {
    this._check('startTightening');
    return this.sendMID(this.profile.toolEnableMid, '', true);
  }

  // MID 0050: VIN download, up to 25 characters.
  downloadVIN(vin) {
    if (vin.length > 25) throw new Error('VIN exceeds 25 characters');
    this._pendingVin = vin;
    return this.sendMID(50, vin, true);
  }

  // MID 0038: rev 1 has a 2-digit Job ID, rev 2 a 4-digit one.
  selectJob(jobId, { revision = jobId > 99 ? 2 : 1 } = {}) {
    const width = revision >= 2 ? 4 : 2;
    const id = digits(jobId, width, 'Job ID');
    this._pendingJobId = Number(jobId);
    return this.sendMID(this.profile.jobSelectMid, id, true, revision);
  }

  // MID 0039: restart a Job.
  restartJob(jobId, { revision = jobId > 99 ? 2 : 1 } = {}) {
    return this.sendMID(39, digits(jobId, revision >= 2 ? 4 : 2, 'Job ID'), true, revision);
  }

  selectParameterSet(paramSetId) {
    this._pendingParamSetId = Number(paramSetId);
    return this.sendMID(18, digits(paramSetId, 3, 'Parameter set ID'), true);
  }

  // MID 0042: rev 1 disables the tool; rev 2 targets a tool number with a
  // disable type (0 disable, 1 inhibit NOK, 2 inhibit OK, 3 inhibit no result).
  disableTool({ toolNumber = null, type = 0 } = {}) {
    if (toolNumber === null) return this.sendMID(this.profile.toolDisableMid, '', true);
    const payload = '01' + digits(toolNumber, 4, 'tool number') + '02' + digits(type, 2, 'disable type');
    return this.sendMID(this.profile.toolDisableMid, payload, true, 2);
  }

  // MID 0043: rev 2 releases a given tool number (9999 = all tools).
  enableTool({ toolNumber = null } = {}) {
    if (toolNumber === null) return this.sendMID(this.profile.toolEnableMid, '', true);
    return this.sendMID(this.profile.toolEnableMid, '01' + digits(toolNumber, 4, 'tool number'), true, 2);
  }

  // MID 0044: ask to disconnect (hot-swap) the tool.
  requestToolDisconnect() { return this.sendMID(44, '', true); }

  // MID 0045: set the tool calibration value. unit: 1 Nm ... 8 Ncm.
  setCalibrationValue(value, { unit = 1, channel = null } = {}) {
    let payload = '01' + digits(unit, 1, 'unit', 1) + '02' + digits(Math.trunc(value * 100), 6, 'calibration value');
    if (channel !== null) payload += '03' + digits(channel, 2, 'channel');
    return this.sendMID(45, payload, true, channel !== null ? 2 : 1);
  }

  // MID 0046: set primary tool (01 cable, 02 IRC-B, 03 IRC-W). Needs
  // programming control and takes effect after a controller reboot.
  setPrimaryTool(primaryTool) {
    return this.sendMID(46, '01' + digits(primaryTool, 2, 'primary tool', 1), true);
  }

  // MID 0047: tool pairing (1 start, 2 abort/disconnect, 3 fetch status).
  // Progress arrives as MID 0048 ('toolPairingStatus').
  toolPairing(type) {
    return this.sendMID(47, '01' + digits(type, 2, 'pairing handling type', 1), true);
  }

  // MID 0020: reset the batch counter of a parameter set (default: the
  // currently selected one).
  resetBatch(paramSetId = this.state.job.paramSetId) {
    if (paramSetId === null || paramSetId === undefined) {
      throw new Error('resetBatch needs a parameter set ID (MID 0020)');
    }
    const p = this.sendMID(20, digits(paramSetId, 3, 'Parameter set ID'), true);
    this.state.batch.pendingReset = true;
    return p;
  }

  // MID 0019: set a parameter set's batch size. Sizes up to 99 use rev 1
  // (2 digits); larger ones rev 2 (4 digits).
  setBatchSize(paramSetId, size) {
    const psetStr = digits(paramSetId, 3, 'Parameter set ID');
    const rev     = size > 99 ? 2 : 1;
    return this.sendMID(19, psetStr + digits(size, rev === 2 ? 4 : 2, 'batch size', 1), true, rev);
  }

  // MID 0127: abort the running Job.
  abortJob() { return this.sendMID(127, '', true); }

  // MID 0128: Job batch increment.
  incrementJobBatch() { return this.sendMID(128, '', true); }
  skipBolt()          { return this.incrementJobBatch(); }

  // MID 0129: Job batch decrement. Rev 1 decrements the last tightening;
  // rev 2 a given channel and parameter set.
  decrementJobBatch({ channelId = null, paramSetId = null } = {}) {
    if (channelId === null) return this.sendMID(129, '', true);
    const payload = '01' + digits(channelId, 2, 'channel ID') + '02' + digits(paramSetId, 3, 'Parameter set ID');
    return this.sendMID(129, payload, true, 2);
  }
  decrementBatch(opts) { return this.decrementJobBatch(opts); }

  // MID 0130: Job off (true sets Job off, false resets it).
  setJobOff(off = true) { return this.sendMID(130, off ? '0' : '1', true); }

  // MID 0082: set the controller clock.
  setTime(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const t = typeof date === 'string' ? date
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}:` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    if (!/^\d{4}-\d{2}-\d{2}:\d{2}:\d{2}:\d{2}$/.test(t)) throw new Error('Time must be YYYY-MM-DD:HH:MM:SS');
    return this.sendMID(82, t, true);
  }

  // MID 0200: ten externally controlled relays, each 0 off, 1 on,
  // 2 flashing, 3 keep current status.
  setRelays(statuses) {
    if (!Array.isArray(statuses) || statuses.length > 10) throw new Error('setRelays takes up to 10 statuses');
    const s = Array.from({ length: 10 }, (_, i) => digits(statuses[i] ?? 3, 1, `relay ${i + 1}`));
    return this.sendMID(200, s.join(''), true);
  }

  // MID 0224 / MID 0225: set / reset a digital input function.
  setDigitalInputFunction(fn)   { return this.sendMID(224, digits(fn, 3, 'digital input function'), true); }
  resetDigitalInputFunction(fn) { return this.sendMID(225, digits(fn, 3, 'digital input function'), true); }

  // MID 0113: flash the green light on the tool.
  flashGreenLight() { return this.sendMID(113, '', true); }

  /* =======================================================
     Public API — Data Requests
     ======================================================= */

  // MID 0010 → MID 0011: the parameter set IDs present in the controller.
  requestParameterSetIds(revision = 1) { return this.sendMID(10, '', true, revision); }

  // MID 0012 → MID 0013: one parameter set's data.
  requestParameterSetData(paramSetId, revision = 1) {
    return this.sendMID(12, digits(paramSetId, 3, 'Parameter set ID'), true, revision);
  }

  // MID 0030 → MID 0031: the Job IDs present (rev 2: 4-digit IDs).
  requestJobIds(revision = 1) { return this.sendMID(30, '', true, revision); }

  // MID 0032 → MID 0033: one Job's data.
  requestJobData(jobId, revision = jobId > 99 ? 2 : 1) {
    return this.sendMID(32, digits(jobId, revision >= 2 ? 4 : 2, 'Job ID'), true, revision);
  }

  // MID 0040 → MID 0041 tool data reply (resolves with the parsed data,
  // also emitted as 'toolData'). A MID 0004 rejects the promise.
  requestToolData(revision = 1) {
    return this.sendMID(40, '', true, revision);
  }

  // MID 0064 → MID 0065 old tightening result reply ('oldTighteningResult').
  // tighteningId 0 requests the most recent result; with `offline` (rev 10)
  // the most recent result done offline.
  requestOldTighteningResult(tighteningId = 0, { offline = false, revision = offline ? 10 : 1 } = {}) {
    const id = digits(tighteningId, 10, 'Tightening ID');
    return this.sendMID(64, revision >= 10 ? id + (offline ? '1' : '0') : id, true, revision);
  }

  // MID 0080 → MID 0081: the controller time.
  readTime() { return this.sendMID(80, '', true); }

  // MID 0214 → MID 0215: status of an I/O device (0 internal, 1-15 expanders).
  requestIoDeviceStatus(device = 0) { return this.sendMID(214, digits(device, 2, 'device'), true); }

  // MID 0410 → MID 0411: AutoDisable settings.
  requestAutoDisableSettings() { return this.sendMID(410, '', true); }

  // MID 0006 generic request: the reply is the requested MID itself. The
  // header revision is MID 0006's own; `revision` is the data MID's.
  requestData(mid, revision = 1, extraData = '') {
    const payload = digits(mid, 4, 'MID') + digits(revision, 3, 'revision') +
      digits(extraData.length, 2, 'extra data length') + extraData;
    return this.sendMID(6, payload, true, 1, { replyMid: mid });
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

module.exports = {
  OpenProtocolNutrunner, InterlockError, ProtocolError, CommandError,
  ERROR_CODES, PUSH_ACK, REPLY_FOR
};
