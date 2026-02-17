/**
 * Open Protocol Nutrunner Client v1.0.4 (node-nutrunner-open-library) 
 * * Production-grade Atlas Copco Open Protocol client for Node.js
 * Handles nutrunner communication, tightening cycles, VIN traceability,
 * batch manufacturing, and industrial safety interlocks.
 *
 * Copyright (c) 2026 Bufferstack.IO Analytics Technology LLP
 * Copyright (c) 2026 Harshad Joshi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * * http://www.apache.org/licenses/LICENSE-2.0
 * * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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
      alarms: []
    },

    tool: {
      enabled: false,
      running: false,
      spindleCount: 1,
      spindleCountSource: 'default' // 'default', 'mid101', 'mid061', 'config', 'manual'
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
    port = DEFAULT_PORT,
    autoReconnect = true,
    validateFrames = FRAME_VALIDATION_ENABLED,
    spindleCount = null, // Override for controllers without MID 101
    allowDuplicateCommands = false // Set true to disable one-per-MID enforcement
  }) {
    super();
    this.host = host;
    this.port = port;
    this.autoReconnect = autoReconnect;
    this.validateFrames = validateFrames;
    this.configuredSpindleCount = spindleCount;
    this.allowDuplicateCommands = allowDuplicateCommands;

    this.socket = null;
    this.buffer = '';
    this.state = createInitialState();

    this.lastTrafficTs = Date.now();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

    this.commandSeq = 0;
    this._lastCommandId = null;
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

          // Apply configured spindle count if provided
          if (this.configuredSpindleCount !== null) {
            this.state.tool.spindleCount = this.configuredSpindleCount;
            this.state.tool.spindleCountSource = 'config';
          }

          this.emit('connected');
          this._startHeartbeat();
          this.sendMID(1); // Comm start
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
      this.sendMID(2); // Comm stop
      this.socket.destroy();
    }
  }

  _onClose() {
    const wasConnected = this.state.connection.connected;
    
    this._stopHeartbeat();
    this._clearWatchdog();
    this._clearPendingCommands();
    
    this.state.connection.connected = false;
    this.state.connection.linkLayerReady = false;
    this.buffer = '';

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
      this.connect().catch(err => {
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
    
    // Enforce one pending command per MID (industrial safety)
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
    
    const midStr = mid.toString().padStart(4, '0');
    
    // Standard Header Construction (12 chars after MID)
    // Rev(3) NoAck(1) Station(2) Spindle(2) Spare(4)
    const rev = '001';
    // NoAck Flag: '0' = Ack Required (Default), '1' = No Ack
    // If expectAck is TRUE, we send '0' (Please Ack).
    // If expectAck is FALSE, we send '1' (Don't Ack).
    // NOTE: This logic is inverted in the protocol spec (0=Ack, 1=NoAck)
    const noAck = expectAck ? '0' : '1'; 
    const station = '01';
    const spindle = '01';
    const spare = '    ';

    const headerRest = `${rev}${noAck}${station}${spindle}${spare}`;
    const body = `${midStr}${headerRest}${payload}`;
    
    const len = (body.length + 4).toString().padStart(4, '0');
    
    if (expectAck) {
      const cmdId = ++this.commandSeq;
      this.state.pendingCommands.set(cmdId, {
        mid,
        timestamp: Date.now(),
        timeout: setTimeout(() => {
          this.state.pendingCommands.delete(cmdId);
          this.emit('commandTimeout', { mid, cmdId });
        }, COMMAND_TIMEOUT_MS)
      });
      
      this._lastCommandId = cmdId;
    }

    this.socket.write(`${len}${body}`);
    return this._lastCommandId;
  }

  _onData(data) {
    this._touchTraffic();
    // Clean null terminators (common in simulators/TCP streams)
    this.buffer += data.toString().replace(/\0/g, '');

    while (this.buffer.length >= 4) {
      const lenStr = this.buffer.slice(0, 4);
      
      if (this.validateFrames && !/^\d{4}$/.test(lenStr)) {
        this.emit('frameError', { 
          type: 'invalid_length', 
          buffer: this.buffer.slice(0, 20) 
        });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const len = parseInt(lenStr, 10);
      
      if (this.validateFrames && (len < 20 || len > 9999)) {
        this.emit('frameError', { 
          type: 'length_out_of_range', 
          length: len 
        });
        this.buffer = this.buffer.slice(1);
        continue;
      }

      if (this.buffer.length < len) return;

      const frame = this.buffer.slice(4, len);
      this.buffer = this.buffer.slice(len);

      const mid = parseInt(frame.slice(0, 4), 10); // Standard offset: 0
      // Standard Payload starts at index 16 (4 MID + 12 Header)
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

      case 2: // Comm start ACK (some controllers use MID 2 instead of 3)
      case 3: // Comm start ACK
        // Safely parse revision, handle padding/whitespace
        const revStr = p.slice(0, 2).trim();
        const revision = parseInt(revStr, 10);
        return { 
          revision: isNaN(revision) ? 1 : revision 
        };

      case 4: // Command error
        return {
          failedMid: Number(p.slice(0, 4)),
          errorCode: Number(p.slice(4, 8)),
          message: p.slice(8).trim()
        };

      case 5: // Command accepted
        return { acceptedMid: Number(p.slice(0, 4)) };

      case 11: // Parameter set ID reply
        return { paramSetId: Number(p.slice(0, 3)) };

      case 21: // Batch decrement ACK
        return { batchCounter: Number(p.slice(0, 4)) };

      case 41: // Tool status
        return {
          controllerReady: p[0] === '1',
          toolEnabled: p[1] === '1',
          toolRunning: p[2] === '1',
          alarmActive: p[3] === '1'
        };

      case 51: // VIN download reply
        return { vin: p.trim() };

      case 52: // VIN required
        return { vinRequired: true };

      case 35: // Job ID reply
        return { jobId: Number(p.slice(0, 4)) };

      case 31: // Batch reply
        return {
          batchId: Number(p.slice(0, 4)),
          batchSize: Number(p.slice(4, 8)),
          batchCounter: Number(p.slice(8, 12))
        };

      case 61: // Last tightening result
        return this._parse0061(p);

      case 65: // Old tightening result
        return this._parse0065(p);

      case 70: // Alarm
        return {
          alarmCode: p.slice(0, 4),
          controllerReady: p[4] === '1',
          toolReady: p[5] === '1',
          timestamp: p.slice(6, 25),
          message: p.slice(25).trim()
        };

      case 76: // Alarm status
        return {
          alarmStatus: p[0] === '1',
          currentAlarms: this._parseAlarmList(p.slice(1))
        };

      case 101: // Multi-spindle cycle complete
        return {
          cycleId: p.slice(0, 10),
          spindleCount: Number(p.slice(10, 12)),
          overallOk: p[12] === '1',
          timestamp: p.slice(13, 32)
        };

      default:
        return { raw: p };
    }
  }

  _parse0061(p) {
    const rev = this.state.protocol.revision;

    // --- REVISION 1 (Basic) ---
    if (rev === 1) {
      const torqueStatus = p[22];
      const angleStatus = p[23];
      
      return {
        tighteningId: p.slice(0, 10),
        spindle: 1,
        torque: Number(p.slice(10, 16)) / 100,
        angle: Number(p.slice(16, 22)),
        torqueStatus,
        angleStatus,
        ok: torqueStatus === '1' && angleStatus === '1'
      };
    }
    
    // --- REVISION 4 (Advanced - Per Official Spec R 2.16.0 Table 101) ---
    if (rev === 4) {
      return {
        // Controller identification (0-30)
        cellId: Number(p.slice(0, 4)),
        channelId: Number(p.slice(4, 6)),
        controllerName: p.slice(6, 31).trim(),
        
        // Traceability (31-70)
        vin: p.slice(31, 56).trim(),
        jobId: Number(p.slice(56, 60)),
        paramSetId: Number(p.slice(60, 63)),
        batchSize: Number(p.slice(63, 67)),
        batchCounter: Number(p.slice(67, 71)),
        
        // Status flags (71-73)
        ok: p[71] === '1',
        torqueStatus: p[72],
        angleStatus: p[73],
        
        // Torque data (74-97) - Nm × 0.01
        torqueMin: Number(p.slice(74, 80)) / 100,
        torqueMax: Number(p.slice(80, 86)) / 100,
        torqueTarget: Number(p.slice(86, 92)) / 100,
        torque: Number(p.slice(92, 98)) / 100,
        
        // Angle data (98-117) - degrees
        angleMin: Number(p.slice(98, 103)),
        angleMax: Number(p.slice(103, 108)),
        angleTarget: Number(p.slice(108, 113)),
        angle: Number(p.slice(113, 118)),
        
        // Timestamps and unique ID (118-167)
        timestamp: p.slice(118, 137),        // YYYY-MM-DD:HH:MM:SS
        lastPsetChange: p.slice(137, 156),   // When pset was last modified
        batchStatus: p[156],                 // Batch OK/NOK
        tighteningId: p.slice(157, 167),     // 10-digit unique result ID
        
        // Rev 4 doesn't include spindle number in MID 61
        spindle: 1
      };
    }

    // --- REVISION 2 & 3 (Legacy Traceability) ---
    // Default fallback for Rev 2 and 3
    const spindleNum = Number(p.slice(10, 12)) || 1;
    const torqueStatus = p.charAt(42) || '0';
    const angleStatus = p.charAt(43) || '0';
    const batchStatus = p.charAt(49) || '0';
    
    return {
      tighteningId: p.slice(0, 10),
      spindle: spindleNum,
      torque: Number(p.slice(12, 18)) / 100,
      angle: Number(p.slice(18, 24)),
      torqueMin: Number(p.slice(24, 30)) / 100,
      torqueMax: Number(p.slice(30, 36)) / 100,
      torqueFinal: Number(p.slice(36, 42)) / 100,
      torqueStatus,
      angleStatus,
      timestamp: p.slice(44, 63),
      ok: torqueStatus === '1' && angleStatus === '1',
      batchStatus,
      vin: p.slice(63, 88).trim(),
      jobId: Number(p.slice(88, 92)),
      paramSetId: Number(p.slice(92, 95))
    };
  }

  _parse0065(p) {
    // MID 65 has different layout than 61
    const torqueStatus = p.charAt(24) || '0';
    const angleStatus = p.charAt(25) || '0';
    
    return {
      tighteningId: p.slice(0, 10),
      spindle: Number(p.slice(10, 12)) || 1,
      torque: Number(p.slice(12, 18)) / 100,
      angle: Number(p.slice(18, 24)),
      torqueStatus,
      angleStatus,
      ok: torqueStatus === '1' && angleStatus === '1',
      timestamp: p.slice(26, 45)
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

      case 2: // Some controllers send MID 2 as ACK
      case 3: // Comm start ACK
        this.state.protocol.revision = d.revision;
        this.state.connection.linkLayerReady = true;
        this.emit('linkEstablished', { revision: d.revision });
        
        // Auto-subscribe to tightening results
        this.subscribeTighteningResults();
        // Auto-subscribe to alarms
        this.subscribeAlarms();
        break;

      case 4: // Command error
        this._resolvePendingCommand(d.failedMid, false, d);
        this.emit('commandError', d);
        
        // Handle batch reset failure specifically
        if (this.state.batch.pendingReset) {
          this.state.batch.pendingReset = false;
          this.emit('batchResetFailed', d);
        }
        break;

      case 5: // Command accepted
        this._resolvePendingCommand(d.acceptedMid, true);
        this.emit('commandAccepted', { mid: d.acceptedMid });
        
        // Handle batch reset success
        if (this.state.batch.pendingReset && d.acceptedMid === 20) {
          this.state.batch.counter = 0;
          this.state.batch.complete = false;
          this.state.batch.pendingReset = false;
          this.emit('batchResetConfirmed');
        }
        break;

      case 11: // Parameter set ID
        this.state.job.paramSetId = d.paramSetId;
        break;

      case 21: // Batch decrement ACK
        this.state.batch.counter = d.batchCounter;
        break;

      case 41: // Tool status
        this.state.controller.ready = d.controllerReady;
        this.state.tool.enabled = d.toolEnabled;
        this.state.tool.running = d.toolRunning;
        this.state.controller.errorActive = d.alarmActive;

        if (d.toolRunning && !this.state.tightening.inProgress) {
          this._startTighteningCycle();
        }
        break;

      case 51: // VIN reply
        this.state.product.vin = d.vin;
        this.state.product.vinValid = true;
        break;

      case 52: // VIN required
        this.state.product.vinRequired = true;
        this.emit('vinRequired');
        break;

      case 35: // Job selected
        this.state.job.jobId = d.jobId;
        this.state.job.active = true;
        this.state.job.locked = true;
        
        // Clear VIN lock on job change (prevents stale lock across jobs)
        this.state.product.vinLocked = false;
        
        this.emit('jobSelected', { jobId: d.jobId });
        break;

      case 31: // Batch started
        this.state.batch = {
          batchId: d.batchId,
          size: d.batchSize,
          counter: d.batchCounter,
          active: true,
          complete: false,
          locked: true,
          pendingReset: false
        };
        
        // Clear VIN lock on batch start (new traceability context)
        this.state.product.vinLocked = false;
        
        this.emit('batchStarted', this.state.batch);
        break;

      case 61:
      case 65:
        // Always ACK result, even if handler throws
        try {
          this._handleTighteningResult(d);
        } finally {
          this.sendMID(62); // ACK must always be sent
        }
        break;

      case 70: // Alarm
        this.state.controller.alarms.push(d);
        this.state.controller.errorActive = true;
        this.emit('alarm', d);
        break;

      case 76: // Alarm status
        if (!d.alarmStatus) {
          this.state.controller.alarms = [];
          this.state.controller.errorActive = false;
        }
        this.emit('alarmStatus', d);
        break;

      case 101: // Multi-spindle cycle complete
        // Update spindle count from controller if not manually configured
        if (this.state.tool.spindleCountSource !== 'config' && 
            this.state.tool.spindleCountSource !== 'manual' &&
            d.spindleCount > 0) {
          this.state.tool.spindleCount = d.spindleCount;
          this.state.tool.spindleCountSource = 'mid101';
          this.emit('spindleCountUpdated', { 
            count: d.spindleCount, 
            source: 'mid101' 
          });
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
        this.emit(success ? 'commandSuccess' : 'commandFailed', { 
          mid, 
          cmdId, 
          data 
        });
        break; // Only resolve first matching command
      }
    }
  }

  _clearPendingCommands() {
    for (const [cmdId, cmd] of this.state.pendingCommands.entries()) {
      clearTimeout(cmd.timeout);
      this.emit('commandAborted', { mid: cmd.mid, cmdId });
    }
    this.state.pendingCommands.clear();
  }

  /* =======================================================
     Tightening Lifecycle
  ======================================================= */

  _startTighteningCycle() {
    this.state.tightening.inProgress = true;
    this.state.tightening.cycleStartTs = Date.now();
    this._startWatchdog();
    this.emit('tighteningCycleStarted', { 
      timestamp: this.state.tightening.cycleStartTs 
    });
  }

  _handleTighteningResult(d) {
    if (!this.state.product.vinLocked && this.state.product.vin) {
      this.state.product.vinLocked = true;
      this.emit('vinLocked', this.state.product.vin);
    }

    // Auto-detect spindle count from results (for controllers without MID 101)
    if (this.state.tool.spindleCountSource === 'default' && 
        d.spindle > this.state.tool.spindleCount) {
      this.state.tool.spindleCount = d.spindle;
      this.state.tool.spindleCountSource = 'mid061';
      this.emit('spindleCountUpdated', { 
        count: d.spindle, 
        source: 'mid061' 
      });
    }

    this.emit('spindleResult', d);
    this.state.tightening.pendingSpindles.set(d.spindle, d);

    if (this.state.tightening.pendingSpindles.size <
        this.state.tool.spindleCount) {
      return;
    }

    this._clearWatchdog();

    const results = [...this.state.tightening.pendingSpindles.values()];
    const overallOk = results.every(r => r.ok);
    
    this.state.tightening.pendingSpindles.clear();
    this.state.tightening.inProgress = false;

    // Handle batch progress
    if (this.state.batch.active && !this.state.batch.complete) {
      this.state.batch.counter++;
      
      this.emit('batchProgress', {
        counter: this.state.batch.counter,
        size: this.state.batch.size,
        remaining: this.state.batch.size - this.state.batch.counter
      });

      if (this.state.batch.counter >= this.state.batch.size) {
        this.state.batch.complete = true;
        this.state.batch.active = false;
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
      
      // NOTE: tighteningIncomplete is emitted instead of tighteningCycleCompleted
      // Upper layers MUST handle both completion paths
      this.emit('tighteningIncomplete', { 
        expected: this.state.tool.spindleCount,
        received: partialResults.length,
        results: partialResults
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

  subscribeTighteningResults() {
    this.sendMID(60, '', true);
    this.state.protocol.subscriptions.tighteningResults = true;
  }

  unsubscribeTighteningResults() {
    this.sendMID(63);
    this.state.protocol.subscriptions.tighteningResults = false;
  }

  subscribeAlarms() {
    this.sendMID(70, '', true);
    this.state.protocol.subscriptions.alarms = true;
  }

  unsubscribeAlarms() {
    this.sendMID(73);
    this.state.protocol.subscriptions.alarms = false;
  }

  acknowledgeAlarm() {
    this.sendMID(78, '', true);
  }

  /* =======================================================
     Public API - Commands
  ======================================================= */

  startTightening() {
    this._check('startTightening');
    return this.sendMID(43, '', true);
  }

  downloadVIN(vin) {
    if (vin.length > 25) {
      throw new Error('VIN exceeds 25 characters');
    }
    return this.sendMID(50, vin.padEnd(25), true);
  }

  selectJob(jobId) {
    const payload = jobId.toString().padStart(4, '0');
    return this.sendMID(34, payload, true);
  }

  selectParameterSet(paramSetId) {
    const payload = paramSetId.toString().padStart(3, '0');
    return this.sendMID(18, payload, true);
  }

  enableTool() {
    return this.sendMID(42, '', true);
  }

  disableTool() {
    return this.sendMID(45, '', true);
  }

  resetBatch() {
    // Mark as pending reset; only update state on MID 0005 ACK
    this.state.batch.pendingReset = true;
    return this.sendMID(20, '', true);
  }

  decrementBatch() {
    // Manual batch decrement
    return this.sendMID(21, '', true);
  }

  /* =======================================================
     Public API - Configuration
  ======================================================= */

  setSpindleCount(count) {
    if (count < 1 || count > 99) {
      throw new Error('Spindle count must be between 1 and 99');
    }
    this.state.tool.spindleCount = count;
    this.state.tool.spindleCountSource = 'manual';
    this.emit('spindleCountUpdated', { count, source: 'manual' });
  }

  /* =======================================================
     Public API - State
  ======================================================= */

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  isConnected() {
    return this.state.connection.connected;
  }

  isReady() {
    return this.state.connection.connected && 
           this.state.connection.linkLayerReady &&
           this.state.controller.ready &&
           !this.state.controller.errorActive;
  }

  getSpindleCount() {
    return {
      count: this.state.tool.spindleCount,
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