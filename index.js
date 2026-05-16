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

// Open Protocol minimum frame size:
// 4 bytes (length field) + 20 bytes (minimum header body) = 24 total.
const MIN_FRAME_SIZE = 24;

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
      spindleCountSource: 'default'
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
      // KEY: tighteningId (string) → result object.
      // Rev 1 & Rev 4 do not carry an explicit spindle number field.
      // Using tighteningId as the key is the only reliable way to de-duplicate
      // results from multi-spindle heads at Rev 1.
      // At Rev 2+, results carry an explicit spindle number; the key remains
      // tighteningId for consistency and to avoid duplicate-spindle collisions.
      pendingSpindles: new Map(),
      watchdog:        null
    },

    pendingCommands: new Map()
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
    this.buffer         = '';
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
    this.buffer               = '';
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

  sendMID(mid, payload = '', expectAck = false) {
    this._touchTraffic();

    if (expectAck && !this.allowDuplicateCommands) {
      const hasPending = [...this.state.pendingCommands.values()].some(c => c.mid === mid);
      if (hasPending) {
        throw new CommandError(`Command MID ${mid} already pending - wait for ACK or NAK`, mid);
      }
    }

    const midStr = mid.toString().padStart(4, '0');
    const rev    = '001';
    const noAck  = expectAck ? '0' : '1';
    const station = '01';
    const spindle = '01';
    // FIX: spare must be 8 spaces so that the total header body = 20 bytes:
    // MID(4) + rev(3) + noAck(1) + station(2) + spindle(2) + spare(8) = 20
    const spare = '        ';

    const headerRest = `${rev}${noAck}${station}${spindle}${spare}`;
    const body = `${midStr}${headerRest}${payload}`;
    const len  = (body.length + 4).toString().padStart(4, '0');

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
      this.socket.write(`${len}${body}\0`);
      return promise;
    }

    this.socket.write(`${len}${body}\0`);
  }

  _onData(data) {
    this._touchTraffic();
    this.buffer += data.toString().replace(/\0/g, '');

    while (this.buffer.length >= 4) {
      const lenStr = this.buffer.slice(0, 4);

      if (this.validateFrames && !/^\d{4}$/.test(lenStr)) {
        this.emit('frameError', { type: 'invalid_length', buffer: this.buffer.slice(0, 20) });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const len = parseInt(lenStr, 10);

      // FIX: `len` is the TOTAL frame size including the 4-byte length prefix.
      // Open Protocol minimum = 4 (length) + 20 (header body) = 24 total.
      if (this.validateFrames && (len < MIN_FRAME_SIZE || len > 9999)) {
        this.emit('frameError', { type: 'length_out_of_range', length: len });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      if (this.buffer.length < len) return;

      const frame   = this.buffer.slice(4, len);
      this.buffer   = this.buffer.slice(len);
      const mid     = parseInt(frame.slice(0, 4), 10);
      const payload = frame.slice(16);

      try {
        const parsed = this._parseMID(mid, payload);
        this._handleMID(mid, parsed);
      } catch (err) {
        this.emit('parseError', { mid, error: err.message });
      }
    }
  }

  /* =======================================================
     MID Parsers
     ======================================================= */

  _parseMID(mid, p) {
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

      case 41: {
        const bit = (i) => p.length > i && p[i] === '1';
        const dir = p.length > 4 ? p[4] : null;
        return {
          controllerReady: bit(0),
          toolReady:       bit(1),
          toolEnabled:     bit(2),
          toolRunning:     bit(3),
          direction:       dir === '1' ? 'REVERSE' : dir === '0' ? 'FORWARD' : '—',
          processOn:       bit(5),
          alarmActive:     bit(6),
          emergencyStop:   bit(7)
        };
      }

      case 51: return { vin: p.trim() };
      case 52: return { vinRequired: true };
      case 35: return { jobId: Number(p.slice(0, 4)) };

      case 31:
        return {
          batchId:      Number(p.slice(0, 4)),
          batchSize:    Number(p.slice(4, 8)),
          batchCounter: Number(p.slice(8, 12))
        };

      case 61:  return this._parse0061(p);
      case 65:  return this._parse0065(p);

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

  _parse0061(p) {
    const rev = this.state.protocol.revision;

    if (this.profile.isSimulator) {
      // Simulator profile: tagged field layout with 2-byte field IDs before each value.
      // Angles are whole integers per OP Spec Rev 1 (no scaling).
      return {
        cellId:         Number(p.slice(2, 6)),
        channelId:      Number(p.slice(8, 10)),
        controllerName: p.slice(12, 37).trim(),
        vin:            p.slice(39, 64).trim(),
        jobId:          Number(p.slice(66, 68)),
        paramSetId:     Number(p.slice(70, 73)),
        batchSize:      Number(p.slice(75, 79)),
        batchCounter:   Number(p.slice(81, 85)),
        ok:             p[87] === '1',
        torqueStatus:   p[90],
        angleStatus:    p[93],
        torqueMin:      Number(p.slice(96,  102)) / 100,
        torqueMax:      Number(p.slice(104, 110)) / 100,
        torqueTarget:   Number(p.slice(112, 118)) / 100,
        torque:         Number(p.slice(120, 126)) / 100,
        angleMin:       Number(p.slice(128, 133)),
        angleMax:       Number(p.slice(135, 140)),
        angleTarget:    Number(p.slice(142, 147)),
        angle:          Number(p.slice(149, 154)),
        timestamp:      p.slice(156, 175),
        lastPsetChange: p.slice(177, 196),
        batchStatus:    p[198],
        tighteningId:   p.slice(201, 211),
        spindle:        1
      };
    }

    // ── Standard Open Protocol positional layout ────────────────────────────
    //
    // Rev 1 & Rev 4 share the same field layout. Rev 1 does NOT carry an
    // explicit spindle number — the spindle field is hardcoded to 1 here.
    // For genuine multi-spindle real hardware, subscribe at Rev 2+ so the
    // controller sends an explicit spindle number per result.
    //
    if (rev === 1 || rev === 4) {
      return {
        cellId:         Number(p.slice(0, 4)),
        channelId:      Number(p.slice(4, 6)),
        controllerName: p.slice(6, 31).trim(),
        vin:            p.slice(31, 56).trim(),
        jobId:          Number(p.slice(56, 60)),
        paramSetId:     Number(p.slice(60, 63)),
        batchSize:      Number(p.slice(63, 67)),
        batchCounter:   Number(p.slice(67, 71)),
        ok:             p[71] === '1',
        torqueStatus:   p[72],
        angleStatus:    p[73],
        torqueMin:      Number(p.slice(74, 80))  / 100,
        torqueMax:      Number(p.slice(80, 86))  / 100,
        torqueTarget:   Number(p.slice(86, 92))  / 100,
        torque:         Number(p.slice(92, 98))  / 100,
        angleMin:       Number(p.slice(98,  103)),
        angleMax:       Number(p.slice(103, 108)),
        angleTarget:    Number(p.slice(108, 113)),
        angle:          Number(p.slice(113, 118)),
        timestamp:      p.slice(118, 137),
        lastPsetChange: p.slice(137, 156),
        batchStatus:    p[156],
        tighteningId:   p.slice(157, 167),
        spindle:        1   // Rev 1/4: no spindle field; use tighteningId as Map key
      };
    }

    // Rev 2 & 3 fallback (compact layout)
    const torqueStatus = p.charAt(42) || '0';
    const angleStatus  = p.charAt(43) || '0';
    const batchStatus  = p.charAt(49) || '0';
    return {
      tighteningId: p.slice(0, 10),
      spindle:      Number(p.slice(10, 12)) || 1,
      torque:       Number(p.slice(12, 18)) / 100,
      angle:        Number(p.slice(18, 24)),
      torqueMin:    Number(p.slice(24, 30)) / 100,
      torqueMax:    Number(p.slice(30, 36)) / 100,
      torqueFinal:  Number(p.slice(36, 42)) / 100,
      torqueStatus,
      angleStatus,
      timestamp:    p.slice(44, 63),
      ok:           torqueStatus === '1' && angleStatus === '1',
      batchStatus,
      vin:          p.slice(63, 88).trim(),
      jobId:        Number(p.slice(88, 92)),
      paramSetId:   Number(p.slice(92, 95))
    };
  }

  _parse0065(p) {
    const torqueStatus = p.charAt(24) || '0';
    const angleStatus  = p.charAt(25) || '0';
    return {
      tighteningId: p.slice(0, 10),
      spindle:      Number(p.slice(10, 12)) || 1,
      torque:       Number(p.slice(12, 18)) / 100,
      angle:        Number(p.slice(18, 24)),
      torqueStatus,
      angleStatus,
      ok:           torqueStatus === '1' && angleStatus === '1',
      timestamp:    p.slice(26, 45)
    };
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

      case 41: {
        const prevRunning   = this.state.tool.running;
        const prevDirection = this.state.tool.direction;
        const prevEmergency = this.state.controller.emergencyStop;

        this.state.controller.ready         = d.controllerReady;
        this.state.controller.errorActive   = d.alarmActive;
        this.state.controller.emergencyStop = d.emergencyStop;
        this.state.tool.ready               = d.toolReady;
        this.state.tool.enabled             = d.toolEnabled;
        this.state.tool.running             = d.toolRunning;
        this.state.tool.direction           = d.direction;
        this.state.tool.processOn           = d.processOn;

        if (d.direction !== prevDirection && d.direction !== '—')
          this.emit('directionChanged', { direction: d.direction });

        if (d.emergencyStop && !prevEmergency)
          this.emit('emergencyStop', { active: true });
        else if (!d.emergencyStop && prevEmergency)
          this.emit('emergencyStop', { active: false });

        if (d.toolRunning && !prevRunning && !this.state.tightening.inProgress)
          this._startTighteningCycle();
        break;
      }

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

      // FIX: MID 0061 and MID 0065 require DIFFERENT ACK MIDs.
      // MID 0061 → ACK with MID 0062
      // MID 0065 → ACK with MID 0066
      // Sending MID 0062 for MID 0065 is a protocol violation on real hardware.
      case 61:
        try {
          this._handleTighteningResult(d, 61);
        } catch (err) {
          this.emit('parseError', { mid: 61, error: err.message });
        }
        break;

      case 65:
        try {
          this._handleTighteningResult(d, 65);
        } catch (err) {
          this.emit('parseError', { mid: 65, error: err.message });
        }
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

  _handleTighteningResult(d, sourceMid) {
    if (!this.state.tightening.inProgress || this.state.tightening.cycleStartTs === null) {
      this.state.tightening.pendingSpindles.clear();
      this.state.tightening.inProgress   = true;
      this.state.tightening.cycleStartTs = Date.now();
    }

    if (d.vin && d.vin.length > 0) {
      this.state.product.vin      = d.vin;
      this.state.product.vinValid = true;
    }

    if (!this.state.product.vinLocked && this.state.product.vin) {
      this.state.product.vinLocked = true;
      this.emit('vinLocked', this.state.product.vin);
    }

    // FIX: Use tighteningId as the Map key (not spindle number).
    // Rev 1 & Rev 4 hardcode spindle=1, so using spindle as key would cause
    // every result to overwrite the same map entry — the cycle would never
    // complete for multi-spindle heads. tighteningId is unique per result.
    const key = d.tighteningId || String(d.spindle);

    if (
      this.state.tool.spindleCountSource === 'default' &&
      d.spindle > this.state.tool.spindleCount
    ) {
      this.state.tool.spindleCount       = d.spindle;
      this.state.tool.spindleCountSource = 'mid061';
      this.emit('spindleCountUpdated', { count: d.spindle, source: 'mid061' });
    }

    this.emit('spindleResult', d);
    this.state.tightening.pendingSpindles.set(key, d);

    if (this.state.tightening.pendingSpindles.size < this.state.tool.spindleCount) {
      // Not all spindles received yet — withhold ACK and batch completion.
      return;
    }

    // All spindle results for this cycle have arrived.
    this._clearWatchdog();

    const results   = [...this.state.tightening.pendingSpindles.values()];
    const overallOk = results.every(r => r.ok);

    this.state.tightening.pendingSpindles.clear();
    this.state.tightening.inProgress = false;

    // FIX: Send the correct ACK only ONCE per cycle (after all spindles arrive),
    // not once per individual spindle result. This prevents ACK flooding on
    // strict multi-spindle controllers (e.g. Atlas Copco Power Focus).
    // MID 0062 = ACK for MID 0061
    // MID 0066 = ACK for MID 0065
    this.sendMID(sourceMid === 65 ? 66 : 62);

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
    this.sendMID(60, String(rev).padStart(3, '0'), true).catch(() => {});
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
