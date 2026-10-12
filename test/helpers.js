'use strict';

const { OpenProtocolNutrunner } = require('..');

// Client wired to an in-memory socket; written frames are captured as strings.
function createClient(opts = {}) {
  const client = new OpenProtocolNutrunner({ host: '127.0.0.1', autoReconnect: false, ...opts });
  const writes = [];
  client.socket = { write: s => writes.push(s), destroy() {} };
  client.state.connection.connected      = true;
  client.state.connection.linkLayerReady = true;
  return { client, writes };
}

// Spec frame: Length(4) MID(4) Rev(3) NoAck(1) Station(2) Spindle(2) Seq(2) Parts(1) Part(1) data NUL.
function frame(mid, data, rev = 1) {
  const header = String(mid).padStart(4, '0') + String(rev).padStart(3, '0') + '0' + '01' + '01' + '    ';
  const len    = String(4 + header.length + data.length).padStart(4, '0');
  return `${len}${header}${data}\0`;
}

// MIDs of the frames the client wrote.
function sentMids(writes) {
  return writes.map(w => Number(w.slice(4, 8)));
}

module.exports = { createClient, frame, sentMids };
