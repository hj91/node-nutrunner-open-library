'use strict';

// Framing tests against a mock Open Protocol controller (node:test, no deps).
// Header per spec §2.2.2, 20 bytes including the length field:
// Length(4) MID(4) Rev(3) NoAck(1) StationID(2) SpindleID(2) SeqNo(2) NoOfParts(1) PartNo(1)

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');

const { OpenProtocolNutrunner } = require('..');

/* ---------- mock controller ---------- */

// Builds a controller→integrator frame. `data` is latin1, so 1 char = 1 byte.
function frame(mid, data = '', rev = 1) {
  const body = `${String(mid).padStart(4, '0')}${String(rev).padStart(3, '0')}0        ${data}`;
  return Buffer.from(`${String(body.length + 4).padStart(4, '0')}${body}\0`, 'latin1');
}

function parseFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('latin1', i, i + 4), 10);
    if (i + len + 1 > buf.length) break;
    const raw = buf.toString('latin1', i, i + len);
    frames.push({
      raw,
      length:     len,
      mid:        parseInt(raw.slice(4, 8), 10),
      rev:        raw.slice(8, 11),
      noAck:      raw[11],
      headerTail: raw.slice(12, 20),
      data:       raw.slice(20),
      terminator: buf[i + len]
    });
    i += len + 1;
  }
  return { frames, rest: buf.subarray(i) };
}

class MockController {
  constructor() {
    this.received = [];
    this.waiters  = [];
    this.socket   = null;
    this.server   = net.createServer(sock => {
      this.socket = sock;
      let buf = Buffer.alloc(0);
      sock.on('data', d => {
        const { frames, rest } = parseFrames(Buffer.concat([buf, d]));
        buf = rest;
        for (const f of frames) {
          this.received.push(f);
          this.waiters = this.waiters.filter(w => (w.mid === f.mid ? (w.resolve(f), false) : true));
        }
      });
    });
  }

  async listen() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    return this.server.address().port;
  }

  // Resolves with the next frame of `mid` (or one already received and not yet taken).
  next(mid) {
    const idx = this.received.findIndex(f => f.mid === mid && !f.taken);
    if (idx >= 0) { this.received[idx].taken = true; return Promise.resolve(this.received[idx]); }
    return new Promise(resolve => this.waiters.push({ mid, resolve: f => { f.taken = true; resolve(f); } }));
  }

  send(...bufs) { this.socket.write(Buffer.concat(bufs)); }

  close() {
    if (this.socket) this.socket.destroy();
    return new Promise(r => this.server.close(r));
  }
}

let ctrl, client;

async function setup(opts = {}) {
  ctrl = new MockController();
  const port = await ctrl.listen();
  client = new OpenProtocolNutrunner({ host: '127.0.0.1', port, autoReconnect: false, ...opts });
  client.on('error', () => {});
  client.frameErrors = [];
  client.on('frameError', e => client.frameErrors.push(e));
  await client.connect();
  await ctrl.next(1);
}

afterEach(async () => {
  if (client) { client.disconnect(); client = null; }
  if (ctrl)   { await ctrl.close(); ctrl = null; }
});

/* ---------- TX ---------- */

test('MID 0001 goes out as a 20-byte header-only frame, NUL-terminated', async () => {
  ctrl = new MockController();
  const port = await ctrl.listen();
  client = new OpenProtocolNutrunner({ host: '127.0.0.1', port, autoReconnect: false });
  await client.connect();
  const f = await ctrl.next(1);

  assert.equal(f.raw.slice(0, 4), '0020');
  assert.equal(f.length, 20);
  assert.equal(f.raw.length, 20);
  assert.equal(f.rev, '001');
  assert.equal(f.data, '');
  assert.equal(f.terminator, 0);
});

test('Length counts header + data bytes; data starts at byte 21', async () => {
  await setup();
  client.state.connection.linkLayerReady = true;
  client.selectParameterSet(5).catch(() => {});
  const f = await ctrl.next(18);

  assert.equal(f.raw.slice(0, 4), '0023');
  assert.equal(f.data, '005');
  assert.equal(f.noAck, '0');
  assert.equal(f.headerTail, '0101    ');
});

test('MID 0060 carries the requested revision in the header, not in the data', async () => {
  await setup({ brand: 'atlas-copco' });
  ctrl.send(frame(2, '010001020103Mock Controller           '));
  const f = await ctrl.next(60);

  assert.equal(f.raw.slice(0, 4), '0020');
  assert.equal(f.rev, '004');
  assert.equal(f.data, '');
});

test('MID 0060 NAK downgrades the header revision', async () => {
  await setup({ brand: 'atlas-copco' });
  ctrl.send(frame(2));
  await ctrl.next(60);

  const downgrade = once(client, 'revisionDowngrade');
  ctrl.send(frame(4, '006097'));
  assert.deepEqual((await downgrade)[0], { from: 4, to: 3 });

  const retry = await ctrl.next(60);
  assert.equal(retry.rev, '003');
  assert.equal(retry.data, '');
});

test('sendMID writes an explicit revision into the header', async () => {
  await setup();
  client.sendMID(19, '00512', false, 2);
  const f = await ctrl.next(19);

  assert.equal(f.rev, '002');
  assert.equal(f.raw.slice(0, 4), '0025');
});

/* ---------- RX ---------- */

test('20-byte keep-alive echo followed by MID 0005 is parsed without frame errors', async () => {
  await setup({ brand: 'atlas-copco' });
  ctrl.send(frame(2));
  await ctrl.next(60);

  const negotiated = once(client, 'revisionNegotiated');
  ctrl.send(frame(9999), frame(5, '0060'));
  assert.deepEqual((await negotiated)[0], { revision: 4 });
  assert.deepEqual(client.frameErrors, []);
});

test('data-less MID frames (e.g. 9999) are accepted as valid', async () => {
  await setup();
  const seen = [];
  const orig = client._parseMID.bind(client);
  client._parseMID = (mid, p, h) => { seen.push(mid); return orig(mid, p, h); };

  ctrl.send(frame(9999), frame(9999));
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(seen, [9999, 9999]);
  assert.deepEqual(client.frameErrors, []);
});

test('frames split across TCP chunks are reassembled', async () => {
  await setup();
  client.state.connection.linkLayerReady = true;
  const ack = client.selectParameterSet(7);
  await ctrl.next(18);

  const buf = frame(5, '0018');
  ctrl.send(buf.subarray(0, 3));
  await new Promise(r => setTimeout(r, 20));
  ctrl.send(buf.subarray(3, 22));
  await new Promise(r => setTimeout(r, 20));
  ctrl.send(buf.subarray(22));
  await ack;
});

test('non-ASCII (latin1) data bytes do not desync framing', async () => {
  await setup();
  const accepted = once(client, 'commandAccepted');
  // 0x00E9 'é' is one byte on the wire; Length counts bytes.
  ctrl.send(frame(2, '010001020103Contrôleur Gérard         '), frame(5, '0070'));
  assert.equal((await accepted)[0].mid, 70);
  assert.deepEqual(client.frameErrors, []);
});

test('leading garbage is skipped and framing resyncs', async () => {
  await setup();
  const accepted = once(client, 'commandAccepted');
  ctrl.send(Buffer.from('xx', 'latin1'), frame(5, '0018'));
  assert.equal((await accepted)[0].mid, 18);
});

test('parsers receive the revision from each frame header', async () => {
  await setup();
  const headers = [];
  const orig = client._parseMID.bind(client);
  client._parseMID = (mid, p, h) => { headers.push({ mid, ...h }); return orig(mid, p, h); };
  client.state.protocol.revision = 4; // requested, but the controller answers at rev 1

  ctrl.send(frame(9999, '', 0), frame(5, '0060', 1), frame(5, '0060', 3));
  await new Promise(r => setTimeout(r, 50));

  assert.deepEqual(headers.map(h => [h.mid, h.revision, h.length]), [
    [9999, 1, 20],
    [5, 1, 24],
    [5, 3, 24]
  ]);
  assert.equal(client._rxRevision, 3);
});

test('blank header revision means revision 1', async () => {
  await setup();
  const headers = [];
  const orig = client._parseMID.bind(client);
  client._parseMID = (mid, p, h) => { headers.push(h); return orig(mid, p, h); };

  const blank = Buffer.from('00209999   0        \0', 'latin1');
  assert.equal(blank.length, 21);
  ctrl.send(blank);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(headers[0].revision, 1);
});
