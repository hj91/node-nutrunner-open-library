// 02-vin-traceability.js
// Links a VIN to every tightening result for full assembly traceability.
// VIN is read directly from MID 0061 result data — no separate MID 0051 reply needed.

'use strict';

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:  '192.168.1.36',
  brand: 'atlas-copco'
});

nutrunner.on('vinLocked', (vin) =>
  console.log(`🔒 VIN locked for this cycle: ${vin}`));

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  // VIN is embedded in each result (MID 0061 offset 31-56)
  // getState().product.vin is also kept in sync by the library
  const vin = results[0]?.vin || nutrunner.getState().product.vin || 'N/A';
  console.log(`\nCycle ${overallOk ? 'OK ✓' : 'NOK ✗'}  VIN: ${vin}`);
  results.forEach(r => {
    console.log(`  Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°  id=${r.tighteningId}`);
  });
});

// Wait for link before sending commands — downloadVIN requires linkLayerReady
nutrunner.on('linkEstablished', async () => {
  try {
    await nutrunner.downloadVIN('1HGBH41JXMN109186');
    console.log('  VIN downloaded');
    await nutrunner.selectJob(1);
    await nutrunner.enableTool();
    console.log('  Tool enabled — waiting for operator...');
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
