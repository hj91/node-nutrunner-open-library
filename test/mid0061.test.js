'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { createClient, frame, sentMids } = require('./helpers');

const NAME = 'PF6000-Station-A'.padEnd(25);
const VIN  = 'WVWZZZ1JZXW000001'.padEnd(25);

// MID 0061 rev 1: tagged parameters 01-23 (211 data bytes, frame length 0231).
const REV1 =
  '01' + '0001' +                    // cell ID
  '02' + '01' +                      // channel ID
  '03' + NAME +                      // controller name
  '04' + VIN +                       // VIN
  '05' + '03' +                      // job ID (2)
  '06' + '012' +                     // pset ID
  '07' + '0010' +                    // batch size
  '08' + '0004' +                    // batch counter
  '09' + '1' +                       // tightening status
  '10' + '1' +                       // torque status
  '11' + '2' +                       // angle status (high)
  '12' + '001200' +                  // torque min
  '13' + '001800' +                  // torque max
  '14' + '001500' +                  // torque target
  '15' + '001523' +                  // torque
  '16' + '00030' +                   // angle min
  '17' + '00090' +                   // angle max
  '18' + '00060' +                   // angle target
  '19' + '00062' +                   // angle
  '20' + '2026-10-11:18:30:00' +     // timestamp
  '21' + '2026-10-01:08:00:00' +     // last pset change
  '22' + '0' +                       // batch status
  '23' + '0000012345';               // tightening ID

// MID 0061 rev 2: tagged parameters 01-46 (365 data bytes, frame length 0385).
const REV2 =
  '01' + '0001' +
  '02' + '01' +
  '03' + NAME +
  '04' + VIN +
  '05' + '0042' +                    // job ID (4)
  '06' + '012' +
  '07' + '01' +                      // strategy
  '08' + '10010' +                   // strategy options
  '09' + '0010' +
  '10' + '0004' +
  '11' + '0' +                       // tightening status NOK
  '12' + '0' +                       // batch status
  '13' + '0' +                       // torque status low
  '14' + '1' +                       // angle status
  '15' + '1' +                       // rundown angle status
  '16' + '1' +                       // current monitoring status
  '17' + '1' +                       // self-tap status
  '18' + '1' +                       // prevail torque monitoring status
  '19' + '1' +                       // prevail torque compensate status
  '20' + '0000000004' +              // tightening error status
  '21' + '001200' +
  '22' + '001800' +
  '23' + '001500' +
  '24' + '001150' +                  // torque 11.50
  '25' + '00030' +
  '26' + '00090' +
  '27' + '00060' +
  '28' + '00045' +
  '29' + '00010' +                   // rundown angle min
  '30' + '00500' +                   // rundown angle max
  '31' + '00250' +                   // rundown angle
  '32' + '010' +                     // current monitoring min
  '33' + '120' +                     // current monitoring max
  '34' + '075' +                     // current monitoring value
  '35' + '000100' +                  // self-tap min
  '36' + '000900' +                  // self-tap max
  '37' + '000450' +                  // self-tap torque
  '38' + '000050' +                  // prevail min
  '39' + '000300' +                  // prevail max
  '40' + '000125' +                  // prevail torque
  '41' + '0000067890' +              // tightening ID
  '42' + '00007' +                   // job sequence number
  '43' + '00011' +                   // sync tightening ID
  '44' + 'TS-0000123456 ' +          // tool serial number (14)
  '45' + '2026-10-11:18:31:00' +
  '46' + '2026-10-01:08:00:00';

// Rev 3 adds 47-49, rev 4 adds 50-52.
const REV4 = REV2 +
  '47' + 'Wheel nut M14'.padEnd(25) +
  '48' + '1' +                       // torque unit Nm
  '49' + '01' +                      // result type
  '50' + 'ID-PART-2'.padEnd(25) +
  '51' + 'ID-PART-3'.padEnd(25) +
  '52' + 'ID-PART-4'.padEnd(25);

// Rev 5 adds 53, rev 6 adds 54-55, rev 7 adds 56-57.
const REV7 = REV4 +
  '53' + 'E123' +                    // customer tightening error code
  '54' + '000080' +                  // prevail torque compensate value
  '55' + '0000000002' +              // tightening error status 2
  '56' + '0004512' +                 // compensated angle
  '57' + '0006275';                  // final angle decimal

// Rev 999 ("light"): untagged.
const REV999 =
  VIN + '03' + '012' + '0010' + '0004' + '1' + '1' + '1' + '1' +
  '001523' + '00062' + '2026-10-11:18:30:00' + '2026-10-01:08:00:00' + '0000012345';

test('golden payloads have the spec lengths', () => {
  assert.equal(REV1.length + 20, 231);
  assert.equal(REV2.length + 20, 385);
});

test('rev 1 tagged layout', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV1, 1);

  assert.equal(d.revision, 1);
  assert.equal(d.cellId, 1);
  assert.equal(d.channelId, 1);
  assert.equal(d.controllerName, 'PF6000-Station-A');
  assert.equal(d.vin, 'WVWZZZ1JZXW000001');
  assert.equal(d.jobId, 3);
  assert.equal(d.paramSetId, 12);
  assert.equal(d.batchSize, 10);
  assert.equal(d.batchCounter, 4);
  assert.equal(d.tighteningStatus, '1');
  assert.equal(d.ok, true);
  assert.equal(d.torqueStatus, '1');
  assert.equal(d.angleStatus, '2');
  assert.equal(d.torqueMin, 12);
  assert.equal(d.torqueMax, 18);
  assert.equal(d.torqueTarget, 15);
  assert.equal(d.torque, 15.23);
  assert.equal(d.angleMin, 30);
  assert.equal(d.angleMax, 90);
  assert.equal(d.angleTarget, 60);
  assert.equal(d.angle, 62);
  assert.equal(d.timestamp, '2026-10-11:18:30:00');
  assert.equal(d.lastPsetChange, '2026-10-01:08:00:00');
  assert.equal(d.batchStatus, '0');
  assert.equal(d.tighteningId, '0000012345');
  assert.equal(d.spindle, 1);
  assert.equal(d.unparsed, undefined);
});

test('rev 1 is the same layout for every brand profile', () => {
  for (const brand of ['generic', 'atlas-copco', 'stanley', 'desoutter', 'ingersoll-rand', 'simulator']) {
    const { client } = createClient({ brand });
    const d = client._parseMID(61, REV1, 1);
    assert.equal(d.cellId, 1, brand);
    assert.equal(d.torque, 15.23, brand);
    assert.equal(d.tighteningId, '0000012345', brand);
  }
});

test('rev 2 tagged layout', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV2, 2);

  assert.equal(d.revision, 2);
  assert.equal(d.cellId, 1);
  assert.equal(d.controllerName, 'PF6000-Station-A');
  assert.equal(d.vin, 'WVWZZZ1JZXW000001');
  assert.equal(d.jobId, 42);
  assert.equal(d.paramSetId, 12);
  assert.equal(d.strategy, 1);
  assert.equal(d.strategyOptions, '10010');
  assert.equal(d.batchSize, 10);
  assert.equal(d.batchCounter, 4);
  assert.equal(d.ok, false);
  assert.equal(d.batchStatus, '0');
  assert.equal(d.torqueStatus, '0');
  assert.equal(d.angleStatus, '1');
  assert.equal(d.rundownAngleStatus, '1');
  assert.equal(d.tighteningErrorStatus, 4);
  assert.equal(d.torqueMin, 12);
  assert.equal(d.torque, 11.5);
  assert.equal(d.angle, 45);
  assert.equal(d.rundownAngle, 250);
  assert.equal(d.currentMonitoringValue, 75);
  assert.equal(d.selftapTorque, 4.5);
  assert.equal(d.prevailTorque, 1.25);
  assert.equal(d.tighteningId, '0000067890');
  assert.equal(d.jobSequenceNumber, 7);
  assert.equal(d.syncTighteningId, 11);
  assert.equal(d.toolSerialNumber, 'TS-0000123456');
  assert.equal(d.timestamp, '2026-10-11:18:31:00');
  assert.equal(d.lastPsetChange, '2026-10-01:08:00:00');
  assert.equal(d.paramSetName, undefined);
});

test('rev 4 adds pset name, torque unit, result type and identifier parts', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV4, 4);

  assert.equal(d.revision, 4);
  assert.equal(d.torque, 11.5);
  assert.equal(d.paramSetName, 'Wheel nut M14');
  assert.equal(d.torqueUnit, '1');
  assert.equal(d.torqueUnitName, 'Nm');
  assert.equal(d.resultType, 1);
  assert.equal(d.identifierPart2, 'ID-PART-2');
  assert.equal(d.identifierPart4, 'ID-PART-4');
});

test('without a header revision, the layout is inferred from the data', () => {
  const { client } = createClient({ brand: 'atlas-copco' });
  client.state.protocol.revision = 4;            // stale negotiated value must not matter

  const r1 = client._parseMID(61, REV1);
  assert.equal(r1.revision, 1);
  assert.equal(r1.jobId, 3);
  assert.equal(r1.tighteningId, '0000012345');

  const r2 = client._parseMID(61, REV2);
  assert.equal(r2.revision, 2);
  assert.equal(r2.jobId, 42);

  const r4 = client._parseMID(61, REV4);
  assert.equal(r4.revision, 4);
  assert.equal(r4.identifierPart3, 'ID-PART-3');
});

test('rev 5-7 fields', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV7, 7);

  assert.equal(d.revision, 7);
  assert.equal(d.identifierPart4, 'ID-PART-4');
  assert.equal(d.customerErrorCode, 'E123');
  assert.equal(d.prevailTorqueCompensateValue, 0.8);
  assert.equal(d.tighteningErrorStatus2, 2);
  assert.equal(d.compensatedAngle, 45.12);
  assert.equal(d.finalAngleDecimal, 62.75);
  assert.equal(d.unparsed, undefined);
});

test('parameters newer than the implemented table are kept as unparsed', () => {
  const { client } = createClient();
  const extra = '58' + '02' + '59' + '0012345';
  const d = client._parseMID(61, REV7 + extra, 8);

  assert.equal(d.revision, 8);
  assert.equal(d.finalAngleDecimal, 62.75);
  assert.equal(d.unparsed, extra);
});

test('rev 999 light layout', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV999, 999);

  assert.equal(d.revision, 999);
  assert.equal(d.vin, 'WVWZZZ1JZXW000001');
  assert.equal(d.jobId, 3);
  assert.equal(d.paramSetId, 12);
  assert.equal(d.batchSize, 10);
  assert.equal(d.batchCounter, 4);
  assert.equal(d.ok, true);
  assert.equal(d.torque, 15.23);
  assert.equal(d.angle, 62);
  assert.equal(d.tighteningId, '0000012345');
});

test('malformed data is reported, not thrown', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV1.slice(0, 100), 1);
  assert.match(d.parseError, /truncated/);
  assert.equal(d.raw, REV1.slice(0, 100));
});

test('a rev 2 result is not accepted by the rev 1 table', () => {
  const { client } = createClient();
  const d = client._parseMID(61, REV2, 1);
  assert.ok(d.parseError);
});

/* ── MID 0062 acknowledgement ───────────────────────────────────────────── */

test('every MID 0061 is acknowledged with one MID 0062', () => {
  const { client, writes } = createClient();
  client._onData(Buffer.from(frame(61, REV1)));
  assert.deepEqual(sentMids(writes), [62]);
});

test('multi-spindle: each result is acknowledged before the cycle completes', () => {
  const { client, writes } = createClient({ spindleCount: 2 });
  client.setSpindleCount(2);

  const results = [];
  let cycle = null;
  client.on('spindleResult', d => results.push(d));
  client.on('tighteningCycleCompleted', c => { cycle = c; });

  client._onData(Buffer.from(frame(61, REV1)));
  assert.deepEqual(sentMids(writes), [62], 'first result ACKed immediately');
  assert.equal(cycle, null);

  const second = REV1.replace('0000012345', '0000012346');
  client._onData(Buffer.from(frame(61, second)));
  assert.deepEqual(sentMids(writes), [62, 62], 'second result ACKed');
  assert.equal(results.length, 2);
  assert.ok(cycle);
  assert.equal(cycle.results.length, 2);
  assert.equal(cycle.overallOk, true);
});

test('a malformed MID 0061 is still acknowledged', () => {
  const { client, writes } = createClient();
  const errors = [];
  client.on('parseError', e => errors.push(e));

  client._onData(Buffer.from(frame(61, '01' + '00')));
  assert.deepEqual(sentMids(writes), [62]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].mid, 61);
});

test('results arriving back to back in one TCP chunk get one ACK each', () => {
  const { client, writes } = createClient();
  const second = REV1.replace('0000012345', '0000012346');
  client._onData(Buffer.from(frame(61, REV1) + frame(61, second)));
  assert.deepEqual(sentMids(writes), [62, 62]);
});

test('the frame header revision selects the layout', () => {
  const { client, writes } = createClient();
  const results = [];
  client.on('spindleResult', d => results.push(d));

  client._onData(Buffer.from(frame(61, REV4, 4)));
  assert.deepEqual(sentMids(writes), [62]);
  assert.equal(results[0].revision, 4);
  assert.equal(results[0].paramSetName, 'Wheel nut M14');
});
