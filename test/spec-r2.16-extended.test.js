'use strict';

// Open Protocol R2.16.0 MIDs beyond the core flow: variable data fields
// (chapter 6), traces (0900/0901), operation results (1201/1202), PowerMACS
// (0105-0109), identifiers (0150-0157, 1601), tightening programs and modes
// (2500-2606), tools, job line control, PLC user data, selectors and the
// controller commands. Fixtures follow the spec examples where it has them.

const test   = require('node:test');
const assert = require('node:assert/strict');
const { createClient, frame } = require('./helpers');
const { encodeVariableFields, parseVariableFields } = require('..');

const rx = (client, ...frames) => client._onData(Buffer.from(frames.join(''), 'latin1'));

function sent(writes) {
  return writes.map(w => {
    const s = Buffer.isBuffer(w) ? w.toString('latin1') : w;
    return { mid: Number(s.slice(4, 8)), rev: Number(s.slice(8, 11)), data: s.slice(20, -1) };
  });
}

// One variable data field: PID(5) Length(3) Type(2) Unit(3) Step(4) Value.
const vf = (pid, value, type = 4, unit = 0, step = 0) =>
  pid + String(value.length).padStart(3, '0') + String(type).padStart(2, '0') +
  String(unit).padStart(3, '0') + String(step).padStart(4, '0') + value;
const section = (...fields) => String(fields.length).padStart(3, '0') + fields.join('');

// Answer the outstanding command with MID 0005.
const ok = (client, mid) => rx(client, frame(5, String(mid).padStart(4, '0')));

/* ── variable data fields (chapter 6) ──────────────────────────────────── */

test('variable data fields round-trip and convert by data type', () => {
  const enc = encodeVariableFields([
    { pid: 2000, value: '10.0', dataType: 3, unit: 1 },
    { pid: 2100, value: '1', dataType: 1 },
    { pid: 1700, value: 'Tool hot', dataType: 4 },
    { pid: 100, value: true, dataType: 6 },
    { pid: 5, value: [1, 22], dataType: 51 }
  ]);
  assert.equal(enc.slice(0, 3), '005');
  assert.equal(enc.slice(3, 24), '0200000403001000010.0');

  const { fields } = parseVariableFields(0, enc, 3, 5);
  assert.deepEqual(fields.map(f => [f.pid, f.dataTypeName, f.unit, f.value]), [
    ['02000', 'F', 1, 10],
    ['02100', 'UI', 0, 1],
    ['01700', 'S', 0, 'Tool hot'],
    ['00100', 'B', 0, true],
    ['00005', 'UA', 0, [1, 22]]
  ]);
});

/* ── MID 1201 / 1202 operation results ─────────────────────────────────── */

const MID1201_REV1 =
  '002' + '001' + '0000001234' + '2026-10-12:08:00:00' + '1' + '00' +
  '001' + '0001' + '1' +
  section(vf('00050', '1', 1), vf('00051', '1234', 1));

const MID1202_REV1 =
  '002' + '002' + '0000001234' + '0001' +
  section(vf('02001', '12.50', 3, 1), vf('02011', '180', 1, 50), vf('02001', '6.00', 3, 1, 1));

test('MID 1201 + 1202 assemble one operation result, each ACKed with MID 1203', () => {
  const { client, writes } = createClient();
  const done = [];
  client.on('operationResultComplete', d => done.push(d));
  rx(client, frame(1201, MID1201_REV1), frame(1202, MID1202_REV1));

  assert.deepEqual(sent(writes).map(f => f.mid), [1203, 1203]);
  assert.equal(done.length, 1);
  const op = done[0];
  assert.equal(op.resultDataId, 1234);
  assert.equal(op.ok, true);
  assert.deepEqual(op.objects, [{ objectId: 1, ok: true }]);
  assert.equal(op.values['00051'], 1234);
  assert.equal(op.objectData.length, 1);
  assert.equal(op.objectData[0].values['02001'], 12.5, 'final torque');
  assert.equal(op.objectData[0].values['02001.1'], 6, 'step 1 torque keyed by step');
  assert.equal(op.objectData[0].fields[1].unit, 50, 'degrees');
});

test('MID 1201 rev 3 objects carry type and reference; 1202 rev 2 a node GUID', () => {
  const { client } = createClient();
  const rev3 = '002' + '001' + '0000000007' + '2026-10-12:08:00:00' + '0' + '01' + '0008' +
    '002' + '0001' + '1' + '2' + '0000' + '0002' + '0' + '2' + '0001' + '000';
  const d = client._parseMID(1201, rev3, 3);
  assert.equal(d.requestMid, 8);
  assert.deepEqual(d.objects, [
    { objectId: 1, ok: true, objectType: 2, referenceObjectId: 0 },
    { objectId: 2, ok: false, objectType: 2, referenceObjectId: 1 }
  ]);
  const guid = '123e4567-e89b-12d3-a456-426614174000';
  const o = client._parseMID(1202, '002002' + '0000000007' + '0001' + guid + '000', 2);
  assert.equal(o.nodeGuid, guid);
});

test('subscribeOperationResults sends MID 0008 with the Table 127 extra data', async () => {
  const { client, writes } = createClient();
  const p = client.subscribeOperationResults({ sendAlternative: 1, index: 42 });
  const f = sent(writes)[0];
  assert.equal(f.mid, 8);
  assert.equal(f.data, '1201' + '001' + '31' + '1' + '0'.repeat(19) + '0000000042' + '1');
  ok(client, 1201);
  await p;
});

test('requestOperationResult resolves with MID 1201 and does not ACK the reply', async () => {
  const { client, writes } = createClient();
  const p = client.requestOperationResult(1234);
  assert.equal(sent(writes)[0].data, '1201' + '001' + '10' + '0000001234');
  rx(client, frame(1201, MID1201_REV1));
  const d = await p;
  assert.equal(d.resultDataId, 1234);
  assert.deepEqual(sent(writes).map(f => f.mid), [6]);
});

test('MID 0067 result list', async () => {
  const { client, writes } = createClient();
  const p = client.requestTighteningResultList(100, 2);
  assert.equal(sent(writes)[0].data, '0067001' + '13' + '0000000100' + '002');
  rx(client, frame(67, '002' + '0000000100' + '2026-10-12:08:00:00' + '1' + '0000000101' + '2026-10-12:08:01:00' + '0'));
  const d = await p;
  assert.deepEqual(d.results.map(r => [r.index, r.ok]), [[100, true], [101, false]]);
});

/* ── MID 0900 / 0901 traces ────────────────────────────────────────────── */

function traceFrame({ rev = 1, samples = [5610, -200, 0], coefficient = '100', coefPid = '02213' } = {}) {
  const bin = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => bin.writeInt16BE(s, i * 2));
  let p = '0012345678' + '2013-11-10:17:32:16';
  if (rev >= 3) p += '0001' + '2' + '0000';
  p += section(vf('01301', '003', 1));
  p += '02';                                 // torque trace
  if (rev >= 3) p += '01';
  p += '01' + '001';                         // transducer 1, Nm
  if (rev >= 2) p += '0008';
  p += section(vf(coefPid, coefficient, rev === 1 ? 1 : 3));
  p += '001' + '00001' + '00003' + '003' + '03' + '202' + '0.5';
  p += String(samples.length).padStart(5, '0') + '\0' + bin.toString('latin1');
  return frame(900, p, rev);
}

test('MID 0900 decodes binary trace samples and applies the PID 02213 coefficient', () => {
  const { client, writes } = createClient();
  const traces = [];
  client.on('trace', d => traces.push(d));
  rx(client, traceFrame());

  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[5, '0900']]);
  const t = traces[0];
  assert.equal(t.resultDataId, 12345678);
  assert.equal(t.traceTypeName, 'torque');
  assert.equal(t.unit, 1);
  assert.deepEqual(t.samples, [5610, -200, 0]);
  assert.deepEqual(t.values, [56.1, -2, 0], '5610 / 100 = 56.1 Nm (spec p.282)');
  assert.deepEqual(t.resolutions, [{ firstIndex: 1, lastIndex: 3, dataType: 3, unit: 202, value: 0.5 }]);
});

test('MID 0900 rev 2/3 layouts and the PID 02214 multiplier', () => {
  const { client } = createClient();
  const traces = [];
  client.on('trace', d => traces.push(d));
  rx(client, traceFrame({ rev: 2, samples: [5610], coefPid: '02214', coefficient: '0.001' }));
  rx(client, traceFrame({ rev: 3, samples: [1, 2] }));
  assert.equal(traces[0].requestMid, 8);
  assert.ok(Math.abs(traces[0].values[0] - 5.61) < 1e-9);
  assert.equal(traces[1].objectType, 2);
  assert.equal(traces[1].numberOfTraces, 1);
  assert.deepEqual(traces[1].samples, [1, 2]);
});

test('a trace with a NUL byte in its samples survives framing', () => {
  const { client } = createClient();
  const traces = [];
  client.on('trace', d => traces.push(d));
  rx(client, traceFrame({ samples: [0, 256, 1] }));
  assert.deepEqual(traces[0].samples, [0, 256, 1]);
});

test('subscribeTraces matches the spec MID 0008 example (p.285)', async () => {
  const { client, writes } = createClient();
  const p = client.subscribeTraces([1]);
  // Spec: "006400080010 0900001350 01001NUL" → data 0900 001 35 0 + 29 spaces + 01 001
  assert.equal(sent(writes)[0].data, '0900' + '001' + '35' + '0' + ' '.repeat(29) + '01' + '001');
  ok(client, 900);
  await p;
});

// The spec example (p.286) "09000010601001" says extra data length 06 but
// carries 5 bytes ("01" + "001"); the length here counts the bytes sent.
test('unsubscribeTraces sends the Table 211 extra data', async () => {
  const { client, writes } = createClient();
  const p = client.unsubscribeTraces([1]);
  assert.equal(sent(writes)[0].data, '0900' + '001' + '05' + '01' + '001');
  ok(client, 900);
  await p;
});

test('MID 0006 trace and plot requests are distinct commands', async () => {
  const { client, writes } = createClient();
  const a = client.requestTrace(0, 2, 1);
  const b = client.requestTracePlotParameters(0, 2, 1);
  assert.equal(sent(writes)[0].data, '0900' + '001' + '17' + '0000000000' + '002' + '0001');
  rx(client, traceFrame());
  await a;
  await new Promise(r => setImmediate(r));
  assert.equal(sent(writes)[1].data.slice(0, 4), '0901');
  rx(client, frame(901, '0012345678' + '2013-11-10:17:32:16' + '001' + vf('02000', '10.0', 3, 1)));
  const plot = await b;
  assert.equal(plot.values['02000'], 10);
});

test('MID 0901 rev 3 carries object and trace type', () => {
  const { client } = createClient();
  const d = client._parseMID(901,
    '0000000001' + '2026-10-12:08:00:00' + '001' + '0008' + '0001' + '2' + '0000' + '02' +
    vf('02002', '-1.5,3.0'.padEnd(16), 50), 3);
  assert.equal(d.requestMid, 8);
  assert.equal(d.traceTypeName, 'torque');
  assert.equal(d.fields[0].dataTypeName, 'FA');
});

/* ── MID 1000 alarm ────────────────────────────────────────────────────── */

test('MID 1000 raises an alarm with its variable data, ACK 1001', () => {
  const { client, writes } = createClient();
  const alarms = [];
  client.on('alarm', a => alarms.push(a));
  rx(client, frame(1000, 'E851 ' + '2026-10-12:08:00:00' +
    section(vf('01700', 'Tool overheated'), vf('01701', '3', 1), vf('10101', '0', 6))));
  assert.deepEqual(sent(writes).map(f => f.mid), [1001]);
  assert.equal(alarms[0].alarmCode, 'E851');
  assert.equal(alarms[0].alarmText, 'Tool overheated');
  assert.equal(alarms[0].severity, 3);
  assert.equal(client.state.tool.ready, false);
  assert.equal(client.state.controller.errorActive, true);
});

/* ── PowerMACS 0105-0109 ───────────────────────────────────────────────── */

const pmFloat = v => v.padStart(7, ' ');

const MID0106_REV4 =
  '01' + '02' + '02' + '01' + '03' + '0000000123' + '04' + '01' + '05' + 'Station 1'.padEnd(20) +
  '06' + '2026-10-12:08:00:00' + '07' + '03' + '08' + 'Mode 3'.padEnd(20) + '09' + '1' + '10' + '0' +
  '11' + 'WP-1'.padEnd(40) + '12' + '01' +
  '13' + '01' + '14' + '1' + '15' + '1' + '16' + '1' + '17' + pmFloat('25.1234') + '18' + pmFloat('180.0') +
  '19' + pmFloat('30.0') + '20' + pmFloat('20.0') + '21' + pmFloat('200.0') + '22' + pmFloat('100.0') +
  '23' + '01' + 'Torque Rate'.padEnd(20) + 'F ' + '05' + '1.234' +
  '24' + '001';

const MID0107_REV4 =
  '01' + '02' + '02' + '02' + '03' + '0000000123' + '04' + '01' + '05' + '2026-10-12:08:00:00' +
  '06' + '0001' + '07' + 'Bolt 1'.padEnd(20) + '08' + 'Program A'.padEnd(20) + '09' + '0' +
  '10' + ''.padEnd(50) + '11' + '    ' +
  '12' + '01' + 'Peak T'.padEnd(20) + 'F ' + pmFloat('25.1234') +
  '13' + '001' + '14' + '1' + 'Step T'.padEnd(20) + 'F ' + pmFloat('12.5') + '01' +
  '15' + '01' + 'E1'.padEnd(20) + 'S ' + '04' + 'ABCD' + '00' +
  '16' + '001';

test('MID 0106 station result parses bolts and special values, ACK 0108 asks for bolt data', () => {
  const { client, writes } = createClient();
  const results = [];
  client.on('powerMacsResult', d => results.push(d));
  rx(client, frame(106, MID0106_REV4, 4));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[108, '1']]);
  const d = results[0];
  assert.equal(d.dataNoSystem, 123);
  assert.equal(d.stationName, 'Station 1');
  assert.equal(d.pmStatus, 'OK');
  assert.equal(d.bolts[0].torque, 25.1234);
  assert.equal(d.bolts[0].angleLow, 100);
  assert.deepEqual(d.specialValues, [{ name: 'Torque Rate', type: 'F', value: 1.234 }]);
  assert.equal(d.systemSubtype, 1);
});

test('MID 0107 bolt result parses bolt, step and special values', () => {
  const { client, writes } = createClient({ powerMacsBoltData: false });
  const bolts = [];
  client.on('powerMacsBoltResult', d => bolts.push(d));
  rx(client, frame(107, MID0107_REV4, 4));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[108, '0']]);
  const d = bolts[0];
  assert.equal(d.boltName, 'Bolt 1');
  assert.deepEqual(d.boltResults, [{ name: 'Peak T', type: 'F', value: 25.1234 }]);
  assert.deepEqual(d.stepResults, [{ name: 'Step T', type: 'F', value: 12.5, step: 1 }]);
  assert.deepEqual(d.specialValues, [{ name: 'E1', type: 'S', value: 'ABCD', step: 0 }]);
  assert.equal(d.systemSubtype, 1);
});

test('subscribePowerMacsResults rev 4 sends Data No System and only-new flag', async () => {
  const { client, writes } = createClient();
  const p = client.subscribePowerMacsResults(4, { dataNoSystem: 123, onlyNew: true });
  assert.deepEqual(sent(writes)[0], { mid: 105, rev: 4, data: '0000000123' + '1' });
  ok(client, 105);
  await p;
});

/* ── identifiers ───────────────────────────────────────────────────────── */

test('MID 0152 identifier result parts, ACK 0153', () => {
  const { client, writes } = createClient();
  const got = [];
  client.on('identifierResultParts', d => got.push(d));
  const part = (n, type, inc, st, res) => String(n).padStart(2, '0') + type + inc + st + res.padEnd(25);
  rx(client, frame(152, part(1, '1', '01', '01', 'VIN123') + part(2, '2', '00', '02', '') +
    part(3, '3', '00', '00', '') + part(4, '4', '00', '00', '')));
  assert.deepEqual(sent(writes).map(f => f.mid), [153]);
  assert.deepEqual(got[0].parts[0], { identifierType: 1, includedInWorkOrder: true, status: 'accepted', resultPart: 'VIN123' });
  assert.equal(got[0].parts[1].status, 'bypassed');
  assert.equal(got[0].parts.length, 4);
});

test('identifier commands: 0150, 0151/0154, 0155, 0156, 0157', async () => {
  const { client, writes } = createClient();
  for (const [call, mid] of [
    [() => client.downloadIdentifier('PALLET-7'), 150],
    [() => client.subscribeIdentifierResultParts(), 151],
    [() => client.unsubscribeIdentifierResultParts(), 154],
    [() => client.bypassIdentifier(), 155],
    [() => client.resetLatestIdentifier(), 156],
    [() => client.resetAllIdentifiers(), 157]
  ]) {
    const p = call();
    assert.equal(sent(writes).at(-1).mid, mid);
    ok(client, mid);
    await p;
  }
  assert.equal(sent(writes)[0].data, 'PALLET-7');
  assert.throws(() => client.downloadIdentifier('x'.repeat(101)), RangeError);
});

test('MID 1601 dynamic identifiers (spec p.224 example), ACK 1602', () => {
  const { client, writes } = createClient();
  const got = [];
  client.on('dynamicIdentifiers', d => got.push(d));
  // Spec: 0050160100100000 001001000100010003040000000ABCNUL
  rx(client, '0050160100100000    001001000100010003040000000ABC\0');
  assert.deepEqual(sent(writes).map(f => f.mid), [1602]);
  assert.equal(got[0].totalMessages, 1);
  assert.equal(got[0].values['00010'], 'ABC');
});

test('subscribeDynamicIdentifiers matches the spec MID 0008 examples (p.224-225)', async () => {
  const { client, writes } = createClient();
  let p = client.subscribeDynamicIdentifiers();
  assert.equal(sent(writes)[0].data, '1601' + '001' + '02' + '00');
  ok(client, 1601); await p;
  p = client.subscribeDynamicIdentifiers({ sendAlternative: 2, formatType: 0, pids: [60] });
  // Spec: 003900080010 00 1601001102000100060NUL
  assert.equal(sent(writes)[1].data, '1601' + '001' + '10' + '2000100060');
  ok(client, 1601); await p;
});

/* ── MID 2500 / 2501 tightening programs ───────────────────────────────── */

const SIMPLE_PSET = '0010020210000101000000010200000403001000010.000';
const TREE        = '100000021010010200000403001000010.0001010010200000403001000015.000';

test('downloadTighteningProgram encodes the spec examples (p.99-100)', async () => {
  const { client, writes } = createClient();
  let p = client.downloadTighteningProgram({
    nodeType: 1,
    parameters: [
      { pid: 2100, value: '1', dataType: 1 },
      { pid: 2000, value: '10.0', dataType: 3, unit: 1 }
    ]
  });
  assert.equal(sent(writes)[0].data, SIMPLE_PSET);
  ok(client, 2500); await p;

  p = client.downloadTighteningProgram({
    nodeType: 100,
    children: [10, 15].map(t => ({ nodeType: 101, parameters: [{ pid: 2000, value: `${t}.0`, dataType: 3, unit: 1 }] }))
  });
  assert.equal(sent(writes)[1].data, TREE);
  ok(client, 2500); await p;
});

test('MID 2501 parses the program tree; rev 2 adds JSON per node', () => {
  const { client } = createClient();
  const { program } = client._parseMID(2501, TREE, 1);
  assert.equal(program.nodeTypeName, 'Tightening program');
  assert.equal(program.children.length, 2);
  assert.equal(program.children[1].parameters[0].value, 15);

  const json = '{"a":1}';
  const rev2 = '001' + '000' + '01' + String(json.length).padStart(4, '0') + json + '101' + '000' + '00' + '0000';
  const d = client._parseMID(2501, rev2, 2);
  assert.deepEqual(d.program.json, { a: 1 });
  assert.equal(d.program.children[0].nodeType, 101);
});

test('program requests, subscription and the 2502/2503 password exchange', async () => {
  const { client, writes } = createClient();
  const p = client.requestTighteningProgram(5, 1);
  assert.equal(sent(writes)[0].data, '2501' + '001' + '07' + '0005' + '001');
  rx(client, frame(2501, SIMPLE_PSET));
  assert.equal((await p).program.parameters.length, 2);

  let asked = false;
  client.on('programPasswordRequest', () => { asked = true; });
  rx(client, frame(2502, ''));
  assert.ok(asked);
  client.sendProgramPassword('secret');
  assert.deepEqual(sent(writes).at(-1), { mid: 2503, rev: 1, data: 'secret' });
});

test('pushed MID 2501 (program versioning) is acknowledged with MID 0005', () => {
  const { client, writes } = createClient();
  rx(client, frame(2501, SIMPLE_PSET));
  assert.deepEqual(sent(writes).map(f => [f.mid, f.data]), [[5, '2501']]);
});

test('MID 2504 / 2505 dynamic pset selection', async () => {
  const { client, writes } = createClient();
  let p = client.selectParameterSetDynamicJob(7);
  assert.deepEqual(sent(writes)[0], { mid: 2504, rev: 1, data: '007' });
  ok(client, 2504); await p;
  p = client.selectParameterSetDynamically(7, [{ pid: 100, value: '5', dataType: 1 }]);
  assert.equal(sent(writes)[1].data, '007' + '001' + '00100001010000000' + '5');
  ok(client, 2505); await p;
});

/* ── modes 2600-2606 ───────────────────────────────────────────────────── */

test('mode IDs, mode data, mode selected and select mode', async () => {
  const { client, writes } = createClient();
  let p = client.requestModeIds();
  rx(client, frame(2601, '002' + '0001' + '06' + 'Mode A' + '0002' + '02' + 'BB'));
  assert.deepEqual((await p).modes, [{ modeId: 1, name: 'Mode A' }, { modeId: 2, name: 'BB' }]);

  p = client.requestModeData(1);
  assert.equal(sent(writes)[1].data, '0001');
  rx(client, frame(2603, '0001' + '06' + 'Mode A' + '001' + '005' + '001' + '0010' + '04' + 'Bolt'));
  assert.deepEqual((await p).bolts, [{ paramSetId: 5, toolNumber: 1, boltNumber: 10, name: 'Bolt' }]);

  rx(client, frame(2604, '0002' + '2026-10-12:08:00:00' + '004'));
  assert.equal(client.state.controller.selectedMode, 2);
  assert.deepEqual(sent(writes).at(-1).mid, 2605);

  p = client.selectMode(2);
  assert.deepEqual(sent(writes).at(-1), { mid: 2606, rev: 1, data: '0002' });
  ok(client, 2606); await p;
});

/* ── tools 0700-0703, tool tag 0260-0265, motor tuning 0500-0504 ──────── */

test('MID 0701 tool list and MID 0702 generic tool data', async () => {
  const { client, writes } = createClient();
  let p = client.requestToolList();
  rx(client, frame(701, '001' + '0001' + 'SN1'.padEnd(30) + 'QST50'.padEnd(30) + '4241 1234 56'.padEnd(30)));
  assert.deepEqual((await p).tools, [{ toolNumber: 1, serialNumber: 'SN1', modelName: 'QST50', articleNumber: '4241 1234 56' }]);

  p = client.requestToolGenericData(1);
  assert.equal(sent(writes)[1].data, '0702' + '001' + '06' + '01' + '0001');
  rx(client, frame(702, section(vf('01213', '45.5', 3, 251))));
  assert.equal((await p).values['01213'], 45.5);
});

test('MID 0700 download status is ACKed with MID 0005; MID 0703 sends variable data', async () => {
  const { client, writes } = createClient();
  rx(client, frame(700, section(vf('00001', '1', 1))));
  assert.deepEqual(sent(writes)[0], { mid: 5, rev: 1, data: '0700' });

  const p = client.setCalibrationValueGeneric(1, [{ pid: 1202, value: 'SN1' }]);
  assert.equal(sent(writes)[1].data, '01' + '0001' + '001' + vf('01202', 'SN1'));
  ok(client, 703); await p;
});

test('tool tag ID: request, push decode, external tag', async () => {
  const { client, writes } = createClient();
  const p = client.requestToolTagId();
  rx(client, frame(262, '01' + '3200078D'));
  const d = await p;
  assert.equal(d.toolTagIdDecoded, '50-0-7-141', 'spec p.260 example');
  assert.deepEqual(sent(writes).map(f => f.mid), [260], 'reply is not ACKed');

  rx(client, frame(262, '01' + '3200078D'));
  assert.equal(sent(writes).at(-1).mid, 263, 'push is ACKed');

  const q = client.sendExternalToolTag('3200078D', 2);
  assert.equal(sent(writes).at(-1).data, '01' + '3200078D' + '02' + '02');
  ok(client, 265); await q;
});

test('motor tuning: 0500 subscribe, 0501 result (ACK 0502), 0504 request', async () => {
  const { client, writes } = createClient();
  const results = [];
  client.on('motorTuningResult', d => results.push(d));
  let p = client.subscribeMotorTuning();
  ok(client, 500); await p;
  rx(client, frame(501, '01' + '1'));
  assert.deepEqual(results, [{ motorTuneOk: true }]);
  assert.equal(sent(writes).at(-1).mid, 502);
  p = client.requestMotorTuning();
  assert.equal(sent(writes).at(-1).mid, 504);
  ok(client, 504); await p;
});

/* ── operator interface, job line control, dynamic job ─────────────────── */

test('MID 0110 / 0111 user text', async () => {
  const { client, writes } = createClient();
  let p = client.displayUserTextCompact('OK');
  assert.equal(sent(writes)[0].data, 'OK  ');
  ok(client, 110); await p;
  p = client.displayUserTextGraph(['HEADER', 'line 2'], { duration: 30, acknowledge: true });
  assert.equal(sent(writes)[1].data,
    '01' + '0030' + '02' + '1' + '03' + 'HEADER'.padEnd(25) + '04' + 'line 2'.padEnd(25) +
    '05' + ''.padEnd(25) + '06' + ''.padEnd(25));
  ok(client, 111); await p;
  assert.throws(() => client.displayUserTextCompact('TOOLONG'), RangeError);
});

test('job line control events are ACKed with MID 0125', () => {
  const { client, writes } = createClient();
  const events = [];
  client.on('jobLineControl', e => events.push(e.event));
  rx(client, frame(121, ''), frame(122, ''), frame(123, ''), frame(124, ''));
  assert.deepEqual(events, ['started', 'alert1', 'alert2', 'done']);
  assert.deepEqual(sent(writes).map(f => f.mid), [125, 125, 125, 125]);
});

test('MID 0140 dynamic job, revision 1 and 999 job list formats', async () => {
  const { client, writes } = createClient();
  const job = {
    jobId: 1, name: 'Dyn', forcedOrder: 1,
    list: [{ channelId: 15, paramSetId: 45, autoSelect: 0, batchSize: 22, maxCoherentNok: 2, batchCounter: 10 }]
  };
  let p = client.executeDynamicJob(job, 1);
  const d1 = sent(writes)[0].data;
  assert.ok(d1.startsWith('01' + '0001' + '02' + 'Dyn'.padEnd(25) + '03' + '01' + '04' + '15:045:0:22:02;' + '05' + '1'));
  assert.ok(d1.endsWith('19' + '0'));
  assert.equal(d1.length, 6 + 27 + 4 + 17 + 15 * 2 + 25, 'parameters 01-19');
  ok(client, 140); await p;

  p = client.executeDynamicJob(job, 999);
  assert.equal(sent(writes)[1].rev, 999);
  assert.ok(sent(writes)[1].data.includes('04' + '15:045:0:22:02:10;' + '05'), 'spec example 15:045:0:22:02:10;');
  ok(client, 140); await p;
});

test('MID 0140 revision 3 and 4 job list entries are 63 and 67 bytes', async () => {
  const { client, writes } = createClient();
  const job = { jobId: 1, name: 'Dyn', list: [{ channelId: 15, paramSetId: 45, batchSize: 22, maxCoherentNok: 2 }] };
  for (const [rev, len] of [[2, 52], [3, 63], [4, 67]]) {
    const p = client.executeDynamicJob(job, rev);
    const data = sent(writes).at(-1).data;
    const list = data.slice(data.indexOf('04', 33) + 2, data.indexOf(';') + 1);
    assert.equal(list.length, len, `rev ${rev}`);
    ok(client, 140); await p;
  }
});

/* ── PLC user data, selectors, histogram, controller ───────────────────── */

test('user data: 0240 download, 0242 push (ACK 0243), 0245 offset', async () => {
  const { client, writes } = createClient();
  let p = client.userDataDownload('8600000000000000');
  assert.equal(sent(writes)[0].data, '8600000000000000');
  ok(client, 240); await p;

  const got = [];
  client.on('userData', d => got.push(d));
  rx(client, frame(242, '7834fece5678a2b7'));
  assert.equal(got[0].bytes.readUInt32BE(3), 0xce5678a2, 'OUT_3 from the spec example');
  assert.equal(sent(writes).at(-1).mid, 243);

  p = client.userDataDownloadWithOffset(10, '1234');
  assert.equal(sent(writes).at(-1).data, '010' + '1234');
  ok(client, 245); await p;
  assert.throws(() => client.userDataDownload('123'), RangeError);
});

test('selectors: 0251 push (ACK 0252), 0254/0255 lights, 1900 variable data', async () => {
  const { client, writes } = createClient();
  const got = [];
  client.on('selectorSocketInfo', d => got.push(d));
  rx(client, frame(251, '01' + '03' + '02' + '04' + '03' + '0100'));
  assert.deepEqual(got[0].sockets, [false, true, false, false]);
  assert.equal(sent(writes).at(-1).mid, 252);

  let p = client.setSelectorGreenLights(3, [1, 0, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(sent(writes).at(-1), { mid: 254, rev: 1, data: '01' + '03' + '02' + '10000002' });
  ok(client, 254); await p;
  p = client.setSelectorRedLights(3, [1, 2]);
  assert.deepEqual(sent(writes).at(-1), { mid: 255, rev: 2, data: '01' + '03' + '02' + '02' + '03' + '12' });
  ok(client, 255); await p;

  rx(client, frame(1900, section(vf('01800', '3', 1), vf('01801', '0000000000000001', 51))));
  assert.deepEqual(got[1].values['01801'], [0, 1]);
  assert.deepEqual(sent(writes).at(-1), { mid: 5, rev: 1, data: '1900' });
});

test('MID 0300 histogram request and MID 0301 reply (spec example p.266)', async () => {
  const { client, writes } = createClient();
  const p = client.requestHistogram(1, 0);
  // Spec: 002903000000 010010200NUL
  assert.equal(sent(writes)[0].data, '01' + '001' + '02' + '00');
  let body = '01' + '001' + '02' + '00' + '03' + '000150' + '04' + '002510' + '05' + '000100';
  for (let i = 1; i <= 9; i++) body += String(5 + i).padStart(2, '0') + String(i).padStart(4, '0');
  rx(client, frame(301, body));
  const d = await p;
  assert.equal(d.sigma, 1.5);
  assert.equal(d.mean, 25.1);
  assert.deepEqual(d.bars, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('MID 0270 reboot and MID 2100 device command', async () => {
  const { client, writes } = createClient();
  let p = client.rebootController();
  assert.deepEqual(sent(writes)[0], { mid: 270, rev: 1, data: '' });
  ok(client, 270); await p;
  p = client.deviceCommand(2);
  assert.deepEqual(sent(writes)[1], { mid: 2100, rev: 1, data: '0002' + '000' });
  ok(client, 2100); await p;
});
