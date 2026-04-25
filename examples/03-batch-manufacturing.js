// 03-batch-manufacturing.js
// Tracks batch progress — vital for assembly lines managing multiple fasteners per unit.

'use strict';

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:  '192.168.1.100',
  brand: 'atlas-copco'
});

nutrunner.on('batchStarted', (b) =>
  console.log(`📦 Batch ${b.batchId} started  (size: ${b.size})`));

nutrunner.on('batchProgress', ({ counter, size, remaining }) =>
  console.log(`  Progress: ${counter}/${size}  —  ${remaining} remaining`));

nutrunner.on('batchCompleted', (b) =>
  console.log(`✓ Batch ${b.batchId} complete`));

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  results.forEach(r => {
    console.log(`  Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°  [${r.ok ? 'OK' : 'NOK'}]`);
  });
});

nutrunner.on('linkEstablished', async () => {
  try {
    await nutrunner.selectJob(1);
    await nutrunner.enableTool();
    console.log('Tool enabled — waiting for operator...');
  } catch (err) {
    console.error('Setup failed:', err.message);
  }
});

nutrunner.on('error', err =>
  console.error('Socket error:', err.message));

async function main() {
  await nutrunner.connect();
}

main().catch(console.error);
