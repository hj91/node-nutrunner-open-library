/**
 * Open Protocol Nutrunner Client v1.2.0 (node-nutrunner-open-library) 
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
 * Changelog v1.2.0:
 *   • MID 0041 parser corrected from 4-bit truncated to full 8-bit spec layout
 *     — old: controllerReady(0) toolEnabled(1) toolRunning(2) alarmActive(3)
 *     — new: controllerReady(0) toolReady(1) toolEnabled(2) toolRunning(3)
 *            direction(4) processOn(5) alarmActive(6) emergencyStop(7)
 *   • createInitialState() expanded: tool.ready, tool.direction, tool.processOn,
 *     controller.emergencyStop
 *   • _handleMID case 41: maps all 8 bits into state; emits directionChanged
 *     and emergencyStop events on rising/falling edges
 *   • _startTighteningCycle: direction now included in tighteningCycleStarted payload
 *   • _check('startTightening'): emergencyStop interlock added
 *   • isReady(): includes !controller.emergencyStop
 *   • _onClose(): resets new state fields on disconnect
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

const DEFAULT_PORT = 4545;
const HEARTBEAT_INTERVAL_MS = 7000;
const TIGHTENING_TIMEOUT_MS = 8000;
const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_BACKOFF_FACTOR = 2;
const COMMAND_TIMEOUT_MS = 5000;
const FRAME_VALIDATION_ENABLED = true;

/* =========================================================
   Brand Profiles
========================================================= */

const BRAND_PROFILES = {
  'generic': {
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     4
  },
  'atlas-copco': {
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     4
  },
  'stanley': {
    jobSelectMid:   34,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     2
  },
  'desoutter': {
    jobSelectMid:   38,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     4
  },
  'ingersoll-rand': {
    jobSelectMid:   34,
    toolEnableMid:  43,
    toolDisableMid: 42,
    maxRevision:     2
  }
};

/* =========================================================
   State Factory
========================================================= */

function createInitialState() {
  return {
    connection: {
      connected: false,
      linkLayerReady: false,
      lastMID: null,
      reconnecting: false,
      reconnectAttempts: 0
    },

    protocol: {
      revision: 1,
      subscriptions: {
        tighteningResults: false,
        alarms: false,
        multiSpindleStatus: false
      }
    },

    controller: {
      ready: false,
      errorActive: false,
      errorCode: null,
      alarms: [],
      emergencyStop: false    // ← v1.2.0: from MID 0041 bit[7]
    },

    tool: {
      ready: false,           // ← v1.2.0: from MID 0041 bit[1] (was missing)
      enabled: false,         //            now correctly bit[2] (was bit[1])
      running: false,         //            now correctly bit[3] (was bit[2])
      direction: '—',        // ← v1.2.0: from MID 0041 bit[4]; 'FORWARD', 'REVERSE', or '—'
      processOn: false,       // ← v1.2.0: from MID 0041 bit[5]
      spindleCount: 1,
      spindleCountSource: 'default'
    },

    product: {
      vin: null,
      vinRequired: false,
      vinValid: false,
      vinLocked: false
    },

    job: {
      jobId: null,
      paramSetId: null,
      active: false,
      locked: false
    },

    batch: {
      batchId: null,
      size: null,
      counter: 0,
      active: false,
      complete: false,
      locked: false,
      pendingReset: false
    },

    tightening: {
      inProgress: false,
      cycleStartTs: null,
      pendingSpindles: new Map(),
      watchdog: null
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
    port             = DEFAULT_PORT,
    autoReconnect    = true,
    validateFrames   = FRAME_VALIDATION_ENABLED,
    spindleCount     = null,
    allowDuplicateCommands = false,
    brand            = 'generic',
    jobSelectMid     = null,
    toolEnableMid    = null,
    toolDisableMid   = null,
    maxRevision      = null
  }) {
    super();
    this.host = host;
    this.port = port;
    this.autoReconnect = autoReconnect;
    this.validateFrames = validateFrames;
    this.configuredSpindleCount = spindleCount;
    this.allowDuplicateCommands = allowDuplicateCommands;

    const baseProfile = BRAND_PROFILES[brand] || BRAND_PROFILES['generic'];
    this.profile = {
      jobSelectMid:   jobSelectMid   !== null ? jobSelectMid   : baseProfile.jobSelectMid,
      toolEnableMid:  toolEnableMid  !== null ? toolEnableMid  : baseProfile.toolEnableMid,
      toolDisableMid: toolDisableMid !== null ? toolDisableMid : baseProfile.toolDisableMid,
      maxRevision:    maxRevision    !== null ? maxRevision    : baseProfile.maxRevision
    };
    this._pendingRevision = this.profile.maxRevision;

    this.socket = null;
    this.buffer = '';
    this.state = createInitialState();

    this.lastTrafficTs = Date.now();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

    this.commandSeq = 0;
    this._lastCommandId = null;
    this._pendingVin    = null;
  }

  /* =======================================================
     Connection
  ======================================================= */

  connect() {
    return new Promise((resolve, reject) => {
      if (this.state.connection.connected) {
        return resolve();
      }

      this.socket = net.createConnection(
        { host: this.host, port: this.port },
        () => {
          this.state.connection.connected = true;
          this.state.connection.reconnecting = false;
          this.state.connection.reconnectAttempts = 0;
          this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

          if (this.configuredSpindleCount !== null) {
            this.state.tool.spindleCount = this.configuredSpindleCount;
            this.state.tool.spindleCountSource = 'config';
          }

          this.emit('connected');
          this._startHeartbeat();
          this.sendMID(1);
          resolve();
        }
      );

      this.socket.on('data', d => this._onData(d));
      this.socket.on('close', () => this._onClose());
      this.socket.on('error', e => {
        this.emit('error', e);
        if (!this.state.connection.connected) {
          reject(e);
        }
      });
    });
  }

  disconnect() {
    this.autoReconnect = false;
    this._stopReconnect();
    if (this.socket) {
      this.sendMID(2);
      this.socket.destroy();
    }
  }

  _onClose() {
    const wasConnected = this.state.connection.connected;

    this._stopHeartbeat();
    this._clearWatchdog();
    this._clearPendingCommands();

    this.state.connection.connected      = false;
    this.state.connection.linkLayerReady = false;
    this.buffer = '';
    this._pendingRevision = this.profile.maxRevision;

    // Reset operational state — user must re-run selectJob/enableTool
    // inside the linkEstablished handler after reconnect.
    this.state.controller.ready         = false;
    this.state.controller.emergencyStop = false;  // ← v1.2.0
    this.state.tool.enabled             = false;
    this.state.tool.running             = false;
    this.state.tool.ready               = false;  // ← v1.2.0
    this.state.tool.direction           = '—';   // ← v1.2.0
    this.state.tool.processOn           = false;  // ← v1.2.0
    this.state.job.active               = false;
    this.state.job.locked               = false;
    this.state.product.vinValid         = false;
    this.state.product.vinLocked        = false;
    this.state.product.vinRequired      = false;
    this._pendingVin                    = null;

    this.emit('disconnected');

    if (this.autoReconnect && wasConnected) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._stopReconnect();
    this.state.connection.reconnecting = true;
    this.state.connection.reconnectAttempts++;

    this.emit('reconnecting', {
      attempt: this.state.connection.reconnectAttempts,
      delay: this.reconnectDelay
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* =======================================================
     Heartbeat
  ======================================================= */

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.state.connection.connected) return;
      const idle = Date.now() - this.lastTrafficTs;
      if (idle >= HEARTBEAT_INTERVAL_MS) {
        this.sendMID(9999);
      }
    }, 1000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _touchTraffic() {
    this.lastTrafficTs = Date.now();
  }

  /* =======================================================
     Framing
  ======================================================= */

  sendMID(mid, payload = '', expectAck = false) {
    this._touchTraffic();

    if (expectAck && !this.allowDuplicateCommands) {
      const hasPending = [...this.state.pendingCommands.values()]
        .some(c => c.mid === mid);

      if (hasPending) {
        throw new CommandError(
          `Command MID ${mid} already pending - wait for ACK or NAK`,
          mid
        );
      }
    }

    const midStr  = mid.toString().padStart(4, '0');
    const rev     = '001';
    const noAck   = expectAck ? '0' : '1';
    const station = '01';
    const spindle = '01';
    const spare   = '    ';

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

      if (this.validateFrames && (len < 20 || len > 9999)) {
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
        const revStr   = p.slice(0, 2).trim();
        const revision = parseInt(revStr, 10);
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
        // ── Full 8-bit parse — corrected from truncated 4-bit version ─────────
        //
        //  Bit  Old parser   Correct spec field
        //  ---  ----------   ------------------
        //  [0]  ✓            controllerReady
        //  [1]  toolEnabled  toolReady       ← was misidentified
        //  [2]  toolRunning  toolEnabled     ← was off by one
        //  [3]  alarmActive  toolRunning     ← was off by one
        //  [4]  (missing)    direction       ← 0=FORWARD, 1=REVERSE
        //  [5]  (missing)    processOn
        //  [6]  (missing)    alarmActive     ← was at wrong position
        //  [7]  (missing)    emergencyStop
        //
        // Bounds-checked: controllers may send fewer than 8 bytes.
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

      case 51:
        return { vin: p.trim() };

      case 52:
        return { vinRequired: true };

      case 35:
        return { jobId: Number(p.slice(0, 4)) };

      case 31:
        return {
          batchId:      Number(p.slice(0, 4)),
          batchSize:    Number(p.slice(4, 8)),
          batchCounter: Number(p.slice(8, 12))
        };

      case 61:
        return this._parse0061(p);

      case 65:
        return this._parse0065(p);

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

    if (rev === 1) {
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
        angleMin:       Number(p.slice(98, 103)),
        angleMax:       Number(p.slice(103, 108)),
        angleTarget:    Number(p.slice(108, 113)),
        angle:          Number(p.slice(113, 118)),
        timestamp:      p.slice(118, 137),
        lastPsetChange: p.slice(137, 156),
        batchStatus:    p[156],
        tighteningId:   p.slice(157, 167),
        spindle:        1
      };
    }

    if (rev === 4) {
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
        angleMin:       Number(p.slice(98, 103)),
        angleMax:       Number(p.slice(103, 108)),
        angleTarget:    Number(p.slice(108, 113)),
        angle:          Number(p.slice(113, 118)),
        timestamp:      p.slice(118, 137),
        lastPsetChange: p.slice(137, 156),
        batchStatus:    p[156],
        tighteningId:   p.slice(157, 167),
        spindle:        1
      };
    }

    // Rev 2 & 3 fallback
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
        this.subscribeAlarms();
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
        // ── Corrected MID 0041 state handler ─────────────────────────────────
        const prevRunning   = this.state.tool.running;
        const prevDirection = this.state.tool.direction;
        const prevEmergency = this.state.controller.emergencyStop;

        this.state.controller.ready         = d.controllerReady;
        this.state.controller.errorActive   = d.alarmActive;
        this.state.controller.emergencyStop = d.emergencyStop;  // ← v1.2.0
        this.state.tool.ready               = d.toolReady;      // ← v1.2.0
        this.state.tool.enabled             = d.toolEnabled;
        this.state.tool.running             = d.toolRunning;
        this.state.tool.direction           = d.direction;      // ← v1.2.0
        this.state.tool.processOn           = d.processOn;      // ← v1.2.0

        // Emit directionChanged on genuine edge; suppress '—' (unknown state)
        if (d.direction !== prevDirection && d.direction !== '—') {
          this.emit('directionChanged', { direction: d.direction });
        }

        // Emit emergencyStop on rising and falling edge
        if (d.emergencyStop && !prevEmergency)
          this.emit('emergencyStop', { active: true });
        else if (!d.emergencyStop && prevEmergency)
          this.emit('emergencyStop', { active: false });

        // Start tightening cycle on toolRunning rising edge only
        if (d.toolRunning && !prevRunning && !this.state.tightening.inProgress) {
          this._startTighteningCycle();
        }
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
        this.state.job.jobId  = d.jobId;
        this.state.job.active = true;
        this.state.job.locked = true;
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

      case 61:
      case 65:
        try {
          this._handleTighteningResult(d);
        } finally {
          this.sendMID(62);
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

      case 101:
        if (this.state.tool.spindleCountSource !== 'config' &&
            this.state.tool.spindleCountSource !== 'manual' &&
            d.spindleCount > 0) {
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
    this.state.tightening.inProgress  = true;
    this.state.tightening.cycleStartTs = Date.now();
    this._startWatchdog();
    this.emit('tighteningCycleStarted', { 
      timestamp: this.state.tightening.cycleStartTs,
      direction: this.state.tool.direction    // ← v1.2.0: FORWARD / REVERSE / —
    });
  }

  _handleTighteningResult(d) {
    if (!this.state.tightening.inProgress || this.state.tightening.cycleStartTs === null) {
      this.state.tightening.inProgress  = true;
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

    if (this.state.tool.spindleCountSource === 'default' &&
        d.spindle > this.state.tool.spindleCount) {
      this.state.tool.spindleCount       = d.spindle;
      this.state.tool.spindleCountSource = 'mid061';
      this.emit('spindleCountUpdated', { count: d.spindle, source: 'mid061' });
    }

    this.emit('spindleResult', d);
    this.state.tightening.pendingSpindles.set(d.spindle, d);

    if (this.state.tightening.pendingSpindles.size < this.state.tool.spindleCount) {
      return;
    }

    this._clearWatchdog();

    const results   = [...this.state.tightening.pendingSpindles.values()];
    const overallOk = results.every(r => r.ok);

    this.state.tightening.pendingSpindles.clear();
    this.state.tightening.inProgress = false;

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

    if (!s.connection.connected) {
      throw new InterlockError('NOT_CONNECTED', 'Controller not connected');
    }
    if (!s.connection.linkLayerReady) {
      throw new InterlockError('LINK_NOT_READY', 'Link layer not established');
    }

    if (cmd === 'startTightening') {
      if (!s.tool.enabled) {
        throw new InterlockError('TOOL_DISABLED', 'Tool is disabled');
      }
      if (s.tool.running) {
        throw new InterlockError('TOOL_RUNNING', 'Tool already running');
      }
      if (!s.controller.ready) {
        throw new InterlockError('CTRL_NOT_READY', 'Controller not ready');
      }
      if (s.controller.errorActive) {
        throw new InterlockError('ALARM_ACTIVE', 'Controller alarm active');
      }
      if (s.controller.emergencyStop) {                         // ← v1.2.0
        throw new InterlockError('EMERGENCY_STOP', 'Emergency stop is active');
      }
      if (s.product.vinRequired && !s.product.vinValid) {
        throw new InterlockError('VIN_REQUIRED', 'Valid VIN required');
      }
      if (!s.job.active) {
        throw new InterlockError('JOB_NOT_ACTIVE', 'No job selected');
      }
    }
  }

  /* =======================================================
     Public API - Subscriptions
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

  /* =======================================================
     Public API - Commands
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

  decrementBatch() {
    return this.sendMID(21, '', true);
  }

  /* =======================================================
     Public API - Configuration
  ======================================================= */

  setSpindleCount(count) {
    if (count < 1 || count > 99) throw new Error('Spindle count must be between 1 and 99');
    this.state.tool.spindleCount       = count;
    this.state.tool.spindleCountSource = 'manual';
    this.emit('spindleCountUpdated', { count, source: 'manual' });
  }

  /* =======================================================
     Public API - State
  ======================================================= */

  getState() {
    return JSON.parse(JSON.stringify(this.state, (key, val) => {
      if (val instanceof Map) return [...val.values()];
      if (val instanceof Object && val.constructor?.name === 'Timeout') return undefined;
      return val;
    }));
  }

  isConnected() {
    return this.state.connection.connected;
  }

  isReady() {
    return this.state.connection.connected
        && this.state.connection.linkLayerReady
        && this.state.controller.ready
        && !this.state.controller.errorActive
        && !this.state.controller.emergencyStop;  // ← v1.2.0
  }

  getSpindleCount() {
    return {
      count:  this.state.tool.spindleCount,
      source: this.state.tool.spindleCountSource
    };
  }
}

module.exports = {
  OpenProtocolNutrunner,
  InterlockError,
  ProtocolError,
  CommandError
};
