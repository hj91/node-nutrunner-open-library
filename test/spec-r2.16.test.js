'use strict';

// Open Protocol R2.16.0 behaviour beyond framing and MID 0061: application
// level flow (§3.2.1), subscription acknowledges, request replies, command
// layouts, and link-level acknowledging with MID 9997/9998 (§3.2.2).

const test   = require('node:test');
const assert = require('node:assert/strict');
const { createClient, frame, sentMids } = require('./helpers');

const tick = () => new Promise(r => setImmediate(r));

// Frame with an explicit header sequence number / part fields.
function seqFrame(mid, data, { rev = 1, seq = '  ', parts = ' ', part = ' ' } = {}) {
  const s = typeof seq === 'number' ? String(seq).padStart(2, '0') : seq;
  const header = String(mid).padStart(4, '0') + String(rev).padStart(3, '0') + '0' + '01' + '01' + s + parts + part;
  const len = String(4 + header.length + data.length).padStart(4, '0');
  return `${len}${header}${data}\0`;
}

const rx = (client, ...frames) => client._onData(Buffer.from(frames.join(''), 'latin1'));

// Decoded TX frames.
function sent(writes) {
  return writes.map(w => {
    const s = Buffer.isBuffer(w) ? w.toString('latin1') : w;
    return { mid: Number(s.slice(4, 8)), rev: s.slice(8, 11), seq: s.slice(16, 18), data: s.slice(20, -1) };
  });
}

/* ── §3.2.1: one outstanding message at a time ─────────────────────────── */

test('a second command waits until the first is answered', async () => {
  const { client, writes } = createClient();
  const a = client.selectParameterSet(1);
  const b = client.enableTool();
  assert.deepEqual(sentMids(writes), [18], 'MID 0043 held back');

  rx(client, frame(5, '0018'));
  await a;
  await tick();
  assert.deepEqual(sentMids(writes), [18, 43]);

  rx(client, frame(5, '0043'));
  await b;
});

test('MID 0004 rejects with the 2-digit error code and its spec text', async () => {
  const { client } = createClient();
  client.on('commandError', () => {});
  const p = client.selectParameterSet(99);
  rx(client, frame(4, '001802'));
  await assert.rejects(p, err => err.errorCode === 2 && err.message === 'Parameter set ID not present');
});

test('a command with no answer drops the connection (spec §3.3.5)', async () => {
  const { client } = createClient({ commandTimeout: 20 });
  let destroyed = false;
  client.socket.destroy = () => { destroyed = true; };
  const timeout = new Promise(r => client.once('linkTimeout', r));
  const keepAlive = setTimeout(() => {}, 1000);   // library timers are unref'd
  await assert.rejects(client.selectParameterSet(1), /ACK timeout/);
  await timeout;
  clearTimeout(keepAlive);
  assert.equal(destroyed, true);
});

/* ── MID 0001 / 0002 / 0003 ────────────────────────────────────────────── */

const MID0002_REV6 =
  '01' + '0001' + '02' + '01' + '03' + 'PF6000 Station A'.padEnd(25) +
  '04' + 'ACT' + '05' + '2.16.0'.padEnd(19) + '06' + '3.2.1'.padEnd(19) + '07' + '1.0.0'.padEnd(19) +
  '08' + 'RBU'.padEnd(24) + '09' + 'C123456789' + '10' + '003' + '11' + '001' +
  '12' + '1' + '13' + '1' + '14' + '0000000042' + '15' + 'Station 42'.padEnd(25) + '16' + '1';

test('MID 0002 is parsed as tagged controller info', () => {
  const { client } = createClient();
  let info = null;
  client.on('linkEstablished', d => { info = d; });
  rx(client, frame(2, MID0002_REV6, 6));

  assert.equal(info.revision, 6);
  assert.equal(info.controllerName, 'PF6000 Station A');
  assert.equal(info.supplierCode, 'ACT');
  assert.equal(info.openProtocolVersion, '2.16.0');
  assert.equal(info.systemType, 3);
  assert.equal(info.sequenceNumberSupport, true);
  assert.equal(info.stationName, 'Station 42');
  assert.equal(client.state.controller.info.cellId, 1);
});

test('MID 0001 steps its revision down on MID 0004 error 97', () => {
  const { client, writes } = createClient({ communicationRevision: 5 });
  client.on('commandError', () => {});
  client._startCommunication();
  rx(client, frame(4, '000197'));
  const frames = sent(writes);
  assert.deepEqual(frames.map(f => [f.mid, f.rev]), [[1, '005'], [1, '004']]);
});

test('MID 0001 rejected for another reason is reported', () => {
  const { client } = createClient();
  client.on('commandError', () => {});
  let rejected = null;
  client.on('communicationRejected', d => { rejected = d; });
  rx(client, frame(4, '000196'));
  assert.equal(rejected.errorCode, 96);
  assert.equal(rejected.message, 'Reject connection, Client already connected');
});

test('disconnect sends MID 0003 Communication stop', () => {
  const { client, writes } = createClient();
  client.disconnect();
  assert.deepEqual(sentMids(writes), [3]);
});

/* ── subscription acknowledges (spec Table 7) ──────────────────────────── */

const PUSHES = [
  [15,   '001' + '2026-10-11:18:30:00',                                  16],
  [22,   '1',                                                            23],
  [35,   '0101' + '020' + '030' + '040010' + '050004' + '062026-10-11:18:30:00', 36],
  [52,   'WVWZZZ1JZXW000001'.padEnd(25),                                 53],
  [71,   '01E404' + '021' + '031' + '042026-10-11:18:30:00',             72],
  [74,   'E404',                                                         75],
  [76,   '011' + '02E404' + '031' + '041' + '052026-10-11:18:30:00',     77],
  [91,   '0102' + '0200012' + '032026-10-11:18:30:00' + '041' + '05' + '01011' + '02021', 92],
  [211,  '00100111',                                                     212],
  [217,  '01001' + '021',                                                218],
  [221,  '01003' + '020',                                                222],
  [401,  '1',                                                            402],
  [421,  '0',                                                            422]
];

for (const [mid, data, ack] of PUSHES) {
  test(`MID ${String(mid).padStart(4, '0')} is acknowledged with MID ${String(ack).padStart(4, '0')}`, () => {
    const { client, writes } = createClient();
    client.on('parseError', e => assert.fail(e.error));
    rx(client, frame(mid, data));
    assert.deepEqual(sentMids(writes), [ack]);
  });
}

test('generic subscription data (MID 1900) is acknowledged with MID 0005', () => {
  const { client, writes } = createClient();
  rx(client, frame(1900, '000'));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[5, '1900']]);
});

test('request replies are not acknowledged', async () => {
  const { client, writes } = createClient();
  const p = client.requestParameterSetIds();
  rx(client, frame(11, '002001002'));
  assert.deepEqual(await p, { count: 2, paramSetIds: [1, 2] });
  assert.deepEqual(sentMids(writes), [10]);
});

/* ── parameter sets, batch, lock at batch done ─────────────────────────── */

test('MID 0015 rev 1 and rev 2 update the selected parameter set', () => {
  const { client } = createClient();
  rx(client, frame(15, '012' + '2026-10-01:08:00:00'));
  assert.equal(client.state.job.paramSetId, 12);

  const rev2 = '01013' + '02' + 'Wheel nut'.padEnd(25) + '03' + '2026-10-01:08:00:00' + '041' + '0510' +
    '06001200' + '07001800' + '08001500' + '0900030' + '1000090' + '1100060' + '12000500' + '13000300';
  const events = [];
  client.on('parameterSetSelected', d => events.push(d));
  rx(client, frame(15, rev2, 2));
  assert.equal(client.state.job.paramSetId, 13);
  assert.equal(events[0].paramSetName, 'Wheel nut');
  assert.equal(events[0].torqueTarget, 15);
  assert.equal(events[0].batchSize, 10);
});

test('MID 0013 parameter set data reply', async () => {
  const { client, writes } = createClient();
  const p = client.requestParameterSetData(1);
  assert.equal(sent(writes)[0].data, '001');
  rx(client, frame(13, '01001' + '02' + 'Airbag1'.padEnd(25) + '031' + '0405' +
    '05001200' + '06001800' + '07001500' + '0800030' + '0900090' + '1000060'));
  const d = await p;
  assert.equal(d.paramSetName, 'Airbag1');
  assert.equal(d.batchSize, 5);
  assert.equal(d.torqueMax, 18);
});

test('MID 0019 batch size is 2 digits at rev 1 and 4 digits at rev 2', async () => {
  const { client, writes } = createClient();
  const a = client.setBatchSize(5, 12);
  rx(client, frame(5, '0019'));
  await a;
  const b = client.setBatchSize(5, 1200);
  rx(client, frame(5, '0019'));
  await b;
  assert.deepEqual(sent(writes).map(f => [f.rev, f.data]), [['001', '00512'], ['002', '0051200']]);
});

test('MID 0020 reset batch carries the parameter set ID', async () => {
  const { client, writes } = createClient();
  assert.throws(() => client.resetBatch(), /parameter set ID/);
  const p = client.resetBatch(7);
  assert.equal(sent(writes)[0].data, '007');
  rx(client, frame(5, '0020'));
  await p;
  assert.equal(client.state.batch.pendingReset, false);
});

test('lock at batch done is MID 0021 subscribe / 0024 unsubscribe', async () => {
  const { client, writes } = createClient();
  const p = client.subscribeLockAtBatchDone();
  rx(client, frame(5, '0021'), frame(22, '1'));
  await p;
  assert.equal(client.state.batch.lockAtBatchDone, true);
  assert.deepEqual(sentMids(writes), [21, 23]);
});

test('decrementBatch is MID 0129 Job batch decrement, not MID 0021', () => {
  const { client, writes } = createClient();
  client.decrementBatch().catch(() => {});
  assert.deepEqual(sentMids(writes), [129]);
});

test('MID 0129 rev 2 carries channel and parameter set', () => {
  const { client, writes } = createClient();
  client.decrementJobBatch({ channelId: 3, paramSetId: 12 }).catch(() => {});
  assert.deepEqual(sent(writes).map(f => [f.mid, f.rev, f.data]), [[129, '002', '0103' + '02012']]);
});

/* ── jobs ──────────────────────────────────────────────────────────────── */

test('MID 0038 Job ID is 2 digits at rev 1 and 4 digits at rev 2', async () => {
  const { client, writes } = createClient();
  const a = client.selectJob(5);
  rx(client, frame(5, '0038'));
  await a;
  assert.equal(client.state.job.jobId, 5);
  assert.equal(client.state.job.active, true);
  const b = client.selectJob(1234);
  rx(client, frame(5, '0038'));
  await b;
  assert.deepEqual(sent(writes).map(f => [f.mid, f.rev, f.data]), [[38, '001', '05'], [38, '002', '1234']]);
});

test('every brand selects a Job with MID 0038 (MID 0034 is Job info subscribe)', () => {
  for (const brand of ['generic', 'atlas-copco', 'stanley', 'desoutter', 'ingersoll-rand']) {
    const { client, writes } = createClient({ brand });
    client.selectJob(1).catch(() => {});
    assert.deepEqual(sentMids(writes), [38], brand);
  }
});

test('MID 0031 Job ID list, rev 1 and rev 2', async () => {
  const { client } = createClient();
  const a = client.requestJobIds();
  rx(client, frame(31, '020102'));
  assert.deepEqual(await a, { count: 2, jobIds: [1, 2] });
  const b = client.requestJobIds(2);
  rx(client, frame(31, '000200010002', 2));
  assert.deepEqual(await b, { count: 2, jobIds: [1, 2] });
});

test('MID 0033 Job data with its Job list', async () => {
  const { client } = createClient();
  const p = client.requestJobData(1);
  rx(client, frame(33, '0101' + '02' + 'Front axle'.padEnd(25) + '031' + '040000' + '0500000' + '060' +
    '071' + '080' + '090' + '100' + '110' + '1202' + '13' + '15:011:0:22;15:012:1:04;'));
  const d = await p;
  assert.equal(d.jobName, 'Front axle');
  assert.equal(d.numberOfParamSets, 2);
  assert.deepEqual(d.jobList[1], { channelId: 15, paramSetId: 12, autoValue: '1', batchSize: 4 });
});

test('MID 0035 Job info rev 1 and rev 2', () => {
  const { client } = createClient();
  const infos = [];
  client.on('jobInfo', d => infos.push(d));
  rx(client, frame(35, '0101' + '020' + '030' + '040010' + '050004' + '062026-10-11:18:30:00'));
  rx(client, frame(35, '010042' + '021' + '031' + '040010' + '050010' + '062026-10-11:18:31:00', 2));

  assert.equal(infos[0].jobId, 1);
  assert.equal(infos[0].jobBatchCounter, 4);
  assert.equal(infos[1].jobId, 42);
  assert.equal(infos[1].jobStatus, '1');
  assert.equal(client.state.job.jobId, 42);
  assert.equal(client.state.job.active, false, 'Job OK = completed');
});

/* ── VIN ───────────────────────────────────────────────────────────────── */

test('MID 0051 subscribes to VIN; MID 0052 rev 1 and rev 2 update the product', async () => {
  const { client, writes } = createClient();
  const p = client.subscribeVIN(2);
  rx(client, frame(5, '0051'));
  await p;
  assert.deepEqual(sent(writes).map(f => [f.mid, f.rev]), [[51, '002']]);

  rx(client, frame(52, 'VIN-A'.padEnd(25)));
  assert.equal(client.state.product.vin, 'VIN-A');

  rx(client, frame(52, '01' + 'VIN-B'.padEnd(25) + '02' + 'P2'.padEnd(25) + '03' + 'P3'.padEnd(25) + '04' + 'P4'.padEnd(25), 2));
  assert.equal(client.state.product.vin, 'VIN-B');
  assert.deepEqual(client.state.product.identifiers, { part2: 'P2', part3: 'P3', part4: 'P4' });
});

test('MID 0050 sends the VIN unpadded', () => {
  const { client, writes } = createClient();
  client.downloadVIN('ABC123').catch(() => {});
  assert.equal(sent(writes)[0].data, 'ABC123');
});

/* ── alarms ────────────────────────────────────────────────────────────── */

test('MID 0071 rev 1 / rev 2 alarm codes are 4 / 5 characters', () => {
  const { client } = createClient();
  const alarms = [];
  client.on('alarm', a => alarms.push(a));
  rx(client, frame(71, '01E404' + '020' + '031' + '042026-10-11:18:30:00'));
  rx(client, frame(71, '01E1021' + '021' + '030' + '042026-10-11:18:31:00', 2));

  assert.equal(alarms[0].alarmCode, 'E404');
  assert.equal(alarms[1].alarmCode, 'E1021');
  assert.equal(client.state.controller.errorActive, true);
  assert.equal(client.state.controller.ready, true);
  assert.equal(client.state.tool.ready, false);
});

test('MID 0074 clears the acknowledged alarm', () => {
  const { client } = createClient();
  rx(client, frame(71, '01E404' + '021' + '031' + '042026-10-11:18:30:00'));
  rx(client, frame(74, 'E404'));
  assert.equal(client.state.controller.errorActive, false);
});

test('MID 0076 alarm status is a single tagged status', () => {
  const { client } = createClient();
  let status = null;
  client.on('alarmStatus', d => { status = d; });
  rx(client, frame(76, '011' + '02E404' + '031' + '041' + '052026-10-11:18:30:00'));
  assert.equal(status.alarmActive, true);
  assert.equal(status.alarmCode, 'E404');
  assert.equal(client.state.controller.errorActive, true);

  rx(client, frame(76, '010' + '02    ' + '031' + '041' + '052026-10-11:18:30:00'));
  assert.equal(client.state.controller.errorActive, false);
});

/* ── time ──────────────────────────────────────────────────────────────── */

test('MID 0080/0081 read time and MID 0082 set time', async () => {
  const { client, writes } = createClient();
  const p = client.readTime();
  rx(client, frame(81, '2026-10-11:18:30:00'));
  assert.deepEqual(await p, { time: '2026-10-11:18:30:00' });

  client.setTime('2026-10-12:04:30:00').catch(() => {});
  await tick();
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[80, ''], [82, '2026-10-12:04:30:00']]);
});

/* ── multi-spindle ─────────────────────────────────────────────────────── */

test('MID 0091 multi-spindle status with per-spindle records', () => {
  const { client } = createClient();
  let st = null;
  client.on('multiSpindleStatus', d => { st = d; });
  rx(client, frame(91, '0102' + '0200012' + '032001-06-02:10:14:26' + '041' + '05' + '01041' + '02051'));

  assert.equal(st.spindleCount, 2);
  assert.equal(st.syncTighteningId, 12);
  assert.equal(st.syncOverallOk, true);
  assert.deepEqual(st.spindles, [
    { spindle: 1, channelId: 4, ok: true },
    { spindle: 2, channelId: 5, ok: true }
  ]);
});

const MID0101_REV1 =
  '0102' + '02' + 'VIN-1'.padEnd(25) + '0301' + '04012' + '050010' + '060004' + '073' +
  '08001200' + '09001800' + '10001500' + '1100030' + '1200090' + '1300060' +
  '14' + '2026-10-01:08:00:00' + '15' + '2026-10-11:18:30:00' + '1600012' + '171' +
  '18' + '0101' + '1' + '1' + '001523' + '1' + '00062' +
         '0202' + '1' + '1' + '001498' + '1' + '00058';

test('MID 0101 multi-spindle result rev 1', () => {
  const { client, writes } = createClient();
  let r = null;
  client.on('multiSpindleCycleComplete', d => { r = d; });
  rx(client, frame(101, MID0101_REV1));

  assert.deepEqual(sentMids(writes), [102]);
  assert.equal(r.spindleCount, 2);
  assert.equal(r.vin, 'VIN-1');
  assert.equal(r.torqueTarget, 15);
  assert.equal(r.syncOverallOk, true);
  assert.deepEqual(r.spindles[1], {
    spindle: 2, channelId: 2, ok: true, torqueStatus: '1', torque: 14.98, angleStatus: '1', angle: 58
  });
});

test('MID 0101 rev 4/5 add system subtype and Job sequence number', () => {
  const { client } = createClient();
  const d = client._parseMID(101, MID0101_REV1 + '19001' + '2000007', 5);
  assert.equal(d.systemSubtype, 1);
  assert.equal(d.jobSequenceNumber, 7);
});

test('MID 0100 rev 3 carries Data No System and the only-new flag', () => {
  const { client, writes } = createClient();
  client.subscribeMultiSpindleResults(3, { dataNoSystem: 42, onlyNew: true });
  assert.deepEqual(sent(writes).map(f => [f.mid, f.rev, f.data]), [[100, '003', '0000000042' + '1']]);
});

/* ── MID 0065 rev 2 (spec Table 113) ───────────────────────────────────── */

test('MID 0065 rev 2 carries Job ID at 03 and batch size at 07', () => {
  const { client } = createClient();
  const data =
    '01' + '0000012345' + '02' + 'VIN-1'.padEnd(25) + '03' + '0042' + '04' + '012' + '05' + '01' +
    '06' + '00000' + '07' + '0010' + '08' + '0004' + '09' + '1' + '10' + '3' + '11' + '1' + '12' + '1' +
    '13' + '1' + '14' + '1' + '15' + '1' + '16' + '1' + '17' + '1' + '18' + '0000000000' +
    '19' + '001523' + '20' + '00062' + '21' + '00250' + '22' + '075' + '23' + '000450' + '24' + '000125' +
    '25' + '00007' + '26' + '00011' + '27' + 'TS-0000123456 ' + '28' + '2026-10-11:18:30:00';
  const d = client._parseMID(65, data, 2);

  assert.equal(d.jobId, 42);
  assert.equal(d.paramSetId, 12);
  assert.equal(d.batchSize, 10);
  assert.equal(d.batchCounter, 4);
  assert.equal(d.batchStatus, '3');
  assert.equal(d.torque, 15.23);
  assert.equal(d.timestamp, '2026-10-11:18:30:00');
  assert.equal(d.unparsed, undefined);
});

test('MID 0064 rev 10 requests the latest offline result', () => {
  const { client, writes } = createClient();
  client.requestOldTighteningResult(0, { offline: true }).catch(() => {});
  assert.deepEqual(sent(writes).map(f => [f.rev, f.data]), [['010', '0000000000' + '1']]);
});

/* ── batch from MID 0061 ───────────────────────────────────────────────── */

test('batch state mirrors the batch fields of MID 0061', () => {
  const { client } = createClient();
  const events = [];
  for (const e of ['batchStarted', 'batchProgress', 'batchCompleted']) client.on(e, d => events.push([e, d.counter]));
  const result = (counter, status, id) =>
    frame(61, '01' + '0001' + '02' + '01' + '03' + 'C'.padEnd(25) + '04' + 'V'.padEnd(25) + '05' + '01' +
      '06' + '012' + '07' + '0002' + '08' + counter + '09' + '1' + '10' + '1' + '11' + '1' +
      '12' + '001200' + '13' + '001800' + '14' + '001500' + '15' + '001523' + '16' + '00030' + '17' + '00090' +
      '18' + '00060' + '19' + '00062' + '20' + '2026-10-11:18:30:00' + '21' + '2026-10-01:08:00:00' +
      '22' + status + '23' + id);

  rx(client, result('0001', '3', '0000000001'));
  rx(client, result('0002', '1', '0000000002'));

  assert.deepEqual(events, [
    ['batchStarted', 1], ['batchProgress', 1], ['batchProgress', 2], ['batchCompleted', 2]
  ]);
  assert.equal(client.state.batch.complete, true);
});

/* ── I/O and modes ─────────────────────────────────────────────────────── */

test('MID 0211 digital inputs, MID 0200 relays, MID 0401 mode, MID 0421 commands disabled', () => {
  const { client, writes } = createClient();
  rx(client, frame(211, '00100111'));
  assert.deepEqual(client.state.io.digitalInputs, [false, false, true, false, false, true, true, true]);

  rx(client, frame(401, '1'));
  assert.equal(client.state.controller.mode, 'manual');
  rx(client, frame(421, '1'));
  assert.equal(client.state.controller.commandsDisabled, true);

  writes.length = 0;
  client.setRelays([0, 1, 2, 3, 3, 0, 1, 2, 3, 0]).catch(() => {});
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[200, '0123301230']]);
});

/* ── generic MID 0006 / 0008 / 0009 ────────────────────────────────────── */

test('MID 0006 generic request resolves with the requested MID', async () => {
  const { client, writes } = createClient();
  const p = client.requestData(66, 2);
  assert.deepEqual(sent(writes).map(f => [f.mid, f.rev, f.data]), [[6, '001', '0066' + '002' + '00']]);
  rx(client, frame(66, '01003' + '02001', 2));
  assert.deepEqual(await p, { offlineResults: 3, offlineCurves: 1 });
  assert.deepEqual(sentMids(writes), [6], 'reply not acknowledged');
});

test('MID 0008 generic subscribe is accepted by MID 0005 carrying the data MID', async () => {
  const { client, writes } = createClient();
  const p = client.subscribe(900, 1, '001390');
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[8, '0900' + '001' + '06' + '001390']]);
  rx(client, frame(5, '0900'));
  await p;
});

test('a subscription NAKed for its revision is retried one revision lower', async () => {
  const { client, writes } = createClient();
  client.on('commandError', () => {});
  const other = client.selectParameterSet(1);
  const p = client.subscribeJobInfo(5);
  rx(client, frame(5, '0018'));
  await other;
  await tick();
  rx(client, frame(4, '003474'));
  await tick(); await tick();
  rx(client, frame(5, '0034'));
  await p;
  assert.deepEqual(sent(writes).map(f => [f.mid, f.rev]), [[18, '001'], [34, '005'], [34, '004']]);
});

/* ── multi-part messages (§2.2.6) ──────────────────────────────────────── */

test('a linked multi-part message is reassembled before parsing', () => {
  const { client } = createClient();
  let st = null;
  client.on('multiSpindleStatus', d => { st = d; });
  const data = '0102' + '0200012' + '032001-06-02:10:14:26' + '041' + '05' + '01041' + '02051';
  rx(client,
    seqFrame(91, data.slice(0, 30), { parts: '2', part: '1' }),
    seqFrame(91, data.slice(30),    { parts: '2', part: '2' }));
  assert.equal(st.spindles.length, 2);
});

/* ── link-level acknowledging (§2.2.5, §3.2.2) ─────────────────────────── */

function linkClient() {
  const { client, writes } = createClient({ linkLevelAck: true });
  client.on('linkError', () => {});
  client._startCommunication();
  rx(client, frame(2, MID0002_REV6, 6));
  return { client, writes };
}

test('linkLevelAck starts communication with MID 0001 rev 6', () => {
  const { client, writes } = linkClient();
  assert.deepEqual(sent(writes)[0].mid, 1);
  assert.equal(sent(writes)[0].rev, '006');
  assert.equal(client.state.connection.linkLevelAck, true);
});

test('data messages carry sequence numbers and wait for MID 9997', async () => {
  const { client, writes } = linkClient();
  // MID 0060 (auto-subscribe) goes out with seq 01; nothing else until 9997.
  let tx = sent(writes).slice(1);
  assert.deepEqual(tx.map(f => [f.mid, f.seq]), [[60, '01']]);

  rx(client, seqFrame(9997, '0060', { seq: 2 }));
  rx(client, seqFrame(5, '0060', { seq: 1 }));
  await tick();
  tx = sent(writes).slice(1);
  assert.deepEqual(tx.map(f => [f.mid, f.seq, f.data]), [
    [60, '01', ''],
    [9997, '02', '0005'],      // our link ACK of the controller's MID 0005
    [70, '02', '']             // next command, next sequence number
  ]);
});

test('subscription data is acknowledged with MID 9997, not its special ACK', () => {
  const { client, writes } = linkClient();
  writes.length = 0;
  rx(client, seqFrame(211, '00100111', { seq: 1 }));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.seq, f.data]), [[9997, '02', '0211']]);
});

test('a retransmission is re-acknowledged but not handled twice', () => {
  const { client, writes } = linkClient();
  const seen = [];
  client.on('digitalInputs', d => seen.push(d));
  writes.length = 0;
  rx(client, seqFrame(211, '00100111', { seq: 1 }), seqFrame(211, '00100111', { seq: 1 }));
  assert.equal(seen.length, 1);
  assert.deepEqual(sent(writes).map(f => [f.mid, f.seq]), [[9997, '02'], [9997, '02']]);
});

test('an out-of-sequence message gets MID 9998 error 0003 with the expected number', () => {
  const { client, writes } = linkClient();
  const seen = [];
  client.on('digitalInputs', d => seen.push(d));
  writes.length = 0;
  rx(client, seqFrame(211, '00100111', { seq: 5 }));
  assert.equal(seen.length, 0);
  assert.deepEqual(sent(writes).map(f => [f.mid, f.seq, f.data]), [[9998, '01', '0211' + '0003']]);
});

test('MID 9998 error 0003 makes the client retransmit with the expected number', () => {
  const { client, writes } = linkClient();
  writes.length = 0;
  rx(client, seqFrame(9998, '0060' + '0003', { seq: 7 }));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.seq]), [[60, '07']]);
});

test('sequence numbers wrap 99 → 1', () => {
  const { client, writes } = linkClient();
  client._link.rxExpected = 99;
  writes.length = 0;
  rx(client, seqFrame(211, '00100111', { seq: 99 }), seqFrame(211, '00100110', { seq: 1 }));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.seq]), [[9997, '01'], [9997, '02']]);
});

/* ── end to end over TCP against a mock controller ─────────────────────── */

test('startup over TCP: 0001 → 0002, subscriptions one at a time, 0061 → 0062', async () => {
  const net = require('node:net');
  const { once } = require('node:events');
  const { OpenProtocolNutrunner } = require('..');

  const got = [];
  let sock;
  const server = net.createServer(s => {
    sock = s;
    s.on('data', d => {
      for (const f of d.toString('latin1').split('\0').filter(Boolean)) {
        const mid = Number(f.slice(4, 8));
        got.push(mid);
        if (mid === 1)  s.write(frame(2, '010001020103' + 'Mock'.padEnd(25)));
        if (mid === 60) s.write(frame(5, '0060'));
        if (mid === 70) s.write(frame(5, '0070') + frame(76, '010' + '02    ' + '031' + '041' + '052026-10-11:18:30:00'));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const client = new OpenProtocolNutrunner({ host: '127.0.0.1', port: server.address().port, autoReconnect: false });
  const status = once(client, 'alarmStatus');
  await client.connect();
  await status;

  const result = once(client, 'spindleResult');
  sock.write(frame(61, '01' + '0001' + '02' + '01' + '03' + 'C'.padEnd(25) + '04' + 'V'.padEnd(25) + '05' + '01' +
    '06' + '012' + '07' + '0002' + '08' + '0001' + '09' + '1' + '10' + '1' + '11' + '1' +
    '12' + '001200' + '13' + '001800' + '14' + '001500' + '15' + '001523' + '16' + '00030' + '17' + '00090' +
    '18' + '00060' + '19' + '00062' + '20' + '2026-10-11:18:30:00' + '21' + '2026-10-01:08:00:00' +
    '22' + '3' + '23' + '0000000001'));
  await result;
  await new Promise(r => setTimeout(r, 30));

  assert.deepEqual(got, [1, 60, 70, 77, 62]);
  assert.equal(client.state.controller.info.controllerName, 'Mock');
  client.disconnect();
  await new Promise(r => server.close(r));
});
