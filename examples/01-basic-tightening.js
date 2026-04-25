// 01-basic-tightening.js
// Standard entry point: connect, select a job, enable the tool, and read results.

'use strict';

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:        '127.0.0.1',
  port:         4545,
  brand:       'atlas-copco',   // selects correct MID profile for this controller
  autoReconnect: true
});

nutrunner.on('connected', () =>
  console.log('✓ Connected to controller'));

nutrunner.on('revisionNegotiated', ({ revision }) =>
  console.log(`✓ MID 0061 revision negotiated: Rev ${revision}`));

nutrunner.on('revisionDowngrade', ({ from, to }) =>
  console.log(`  ↓ Controller rejected Rev ${from} — retrying Rev ${to}`));

nutrunner.on('linkEstablished', async ({ revision }) => {
  console.log(`✓ Comm link active (protocol Rev ${revision})`);
  try {
    await nutrunner.selectJob(1);
    console.log('  Job 1 selected');
    await nutrunner.enableTool();
    console.log('  Tool enabled — waiting for operator...');
  } catch (err) {
    console.error('Setup failed:', err.message);
  }
});

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk, duration }) => {
  console.log(`\nCycle ${overallOk ? 'OK ✓' : 'NOK ✗'}  (${duration} ms)`);
  results.forEach(r => {
    console.log(`  Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°  [${r.ok ? 'OK' : 'NOK'}]`);
  });
});

nutrunner.on('tighteningIncomplete', ({ expected, received }) =>
  console.warn(`⚠ Incomplete cycle — expected ${expected} spindles, got ${received}`));

nutrunner.on('error', err =>
  console.error('Socket error:', err.message));

async function main() {
  await nutrunner.connect();
}

main().catch(console.error);
