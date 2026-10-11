'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { createClient, frame, sentMids } = require('./helpers');

const VIN = 'WVWZZZ1JZXW000001'.padEnd(25);

/* ── MID 0041: tool data upload reply ──────────────────────────────────── */

const MID0041_REV1 =
  '01' + 'TS-0000123456 ' +            // tool serial number (14)
  '02' + '0000001234' +                // tightening count
  '03' + '2026-01-15:10:00:00' +       // last calibration date
  '04' + 'C123456789';                 // controller serial number (10)

const MID0041_REV2 = MID0041_REV1 +
  '05' + '001500' +                    // calibration value
  '06' + '2026-06-01:09:00:00' +       // last service date
  '07' + '0000000100' +                // tightenings since service
  '08' + '01' +                        // tool type
  '09' + '03' +                        // motor size
  '10' + '000' +                       // open end data
  '11' + 'PF6000 2.5.1'.padEnd(19);    // controller software version

test('MID 0041 rev 1 parses as tagged tool data', () => {
  const { client } = createClient();
  const d = client._parseMID(41, MID0041_REV1, 1);
  assert.deepEqual(d, {
    toolSerialNumber:       'TS-0000123456',
    tighteningCount:        1234,
    lastCalibrationDate:    '2026-01-15:10:00:00',
    controllerSerialNumber: 'C123456789'
  });
});

test('MID 0041 rev 2 adds service data', () => {
  const { client } = createClient();
  const d = client._parseMID(41, MID0041_REV2, 2);
  assert.equal(d.toolSerialNumber, 'TS-0000123456');
  assert.equal(d.calibrationValue, 15);
  assert.equal(d.lastServiceDate, '2026-06-01:09:00:00');
  assert.equal(d.tighteningsSinceService, 100);
  assert.equal(d.toolType, 1);
  assert.equal(d.motorSize, 3);
  assert.equal(d.openEndData, '000');
  assert.equal(d.controllerSoftwareVersion, 'PF6000 2.5.1');
});

test('MID 0041 does not drive controller or tool status', () => {
  const { client, writes } = createClient();
  const before = client.getState();
  const events = [];
  client.on('toolData', d => events.push(d));
  client.on('tighteningCycleStarted', () => assert.fail('no cycle from tool data'));

  client._onData(Buffer.from(frame(41, MID0041_REV1)));

  const after = client.getState();
  assert.equal(after.controller.ready, before.controller.ready);
  assert.equal(after.controller.emergencyStop, before.controller.emergencyStop);
  assert.equal(after.tool.enabled, before.tool.enabled);
  assert.equal(after.tool.running, before.tool.running);
  assert.equal(after.tool.data.toolSerialNumber, 'TS-0000123456');
  assert.equal(events.length, 1);
  assert.deepEqual(writes, [], 'MID 0041 is a reply and is not acknowledged');
});

test('requestToolData sends MID 0040 and resolves with the MID 0041 reply', async () => {
  const { client, writes } = createClient();
  const p = client.requestToolData();
  assert.deepEqual(sentMids(writes), [40]);

  client._onData(Buffer.from(frame(41, MID0041_REV1)));
  const d = await p;
  assert.equal(d.tighteningCount, 1234);
});

test('requestToolData rejects on MID 0004', async () => {
  const { client } = createClient();
  client.on('commandError', () => {});
  const p = client.requestToolData();
  client._onData(Buffer.from(frame(4, '0040' + '01')));
  await assert.rejects(p);
});

/* ── MID 0065: old tightening result upload reply ──────────────────────── */

const MID0065_REV1 =
  '01' + '0000012345' +                // tightening ID
  '02' + VIN +
  '03' + '012' +                       // pset ID
  '04' + '0004' +                      // batch counter
  '05' + '1' +                         // tightening status
  '06' + '1' +                         // torque status
  '07' + '1' +                         // angle status
  '08' + '001523' +                    // torque
  '09' + '00062' +                     // angle
  '10' + '2026-10-11:18:30:00' +       // timestamp
  '11' + '1';                          // batch status

test('MID 0065 rev 1 parses as tagged data', () => {
  const { client } = createClient();
  for (const rev of [1, undefined]) {
    const d = client._parseMID(65, MID0065_REV1, rev);
    assert.equal(d.revision, 1);
    assert.equal(d.tighteningId, '0000012345');
    assert.equal(d.vin, 'WVWZZZ1JZXW000001');
    assert.equal(d.paramSetId, 12);
    assert.equal(d.batchCounter, 4);
    assert.equal(d.ok, true);
    assert.equal(d.torque, 15.23);
    assert.equal(d.angle, 62);
    assert.equal(d.timestamp, '2026-10-11:18:30:00');
    assert.equal(d.batchStatus, '1');
  }
});

test('MID 0065 is not acknowledged and does not count toward the batch', () => {
  const { client, writes } = createClient();
  client.state.batch.active = true;
  client.state.batch.size   = 10;

  const old = [];
  client.on('oldTighteningResult', d => old.push(d));
  client.on('spindleResult', () => assert.fail('old result is not a live result'));

  client._onData(Buffer.from(frame(65, MID0065_REV1)));

  assert.deepEqual(writes, [], 'no MID 0062 or 0066 for MID 0065');
  assert.equal(old.length, 1);
  assert.equal(client.state.batch.counter, 0);
});

test('requestOldTighteningResult sends MID 0064 and resolves with MID 0065', async () => {
  const { client, writes } = createClient();
  const p = client.requestOldTighteningResult(12345);
  assert.deepEqual(sentMids(writes), [64]);
  assert.ok(writes[0].includes('0000012345'));

  client._onData(Buffer.from(frame(65, MID0065_REV1)));
  const d = await p;
  assert.equal(d.tighteningId, '0000012345');
});

/* ── Tool enable state now comes from MID 0005 ─────────────────────────── */

test('tool.enabled follows MID 0005 for enable/disable', async () => {
  const { client } = createClient();
  const en = client.enableTool();
  client._onData(Buffer.from(frame(5, '0043')));
  await en;
  assert.equal(client.state.tool.enabled, true);

  const dis = client.disableTool();
  client._onData(Buffer.from(frame(5, '0042')));
  await dis;
  assert.equal(client.state.tool.enabled, false);
});
