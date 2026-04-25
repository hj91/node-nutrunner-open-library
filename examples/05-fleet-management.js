// 05-fleet-management.js
// Manages multiple nutrunner stations across a factory floor.
// Each station can specify its own brand profile.

'use strict';

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const STATIONS = [
  { id: 'Pune-Line-1', host: '192.168.1.101', brand: 'atlas-copco' },
  { id: 'Pune-Line-2', host: '192.168.1.102', brand: 'atlas-copco' },
  { id: 'Pune-Line-3', host: '192.168.1.103', brand: 'stanley'     }
];

STATIONS.forEach(({ id, host, brand }) => {
  const runner = new OpenProtocolNutrunner({
    host,
    brand,
    autoReconnect: true
  });

  runner.on('revisionNegotiated', ({ revision }) =>
    console.log(`[${id}] MID 0061 Rev ${revision} negotiated`));

  runner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
    console.log(`[${id}] Cycle ${overallOk ? 'OK ✓' : 'NOK ✗'}`);
    results.forEach(r =>
      console.log(`  Spindle ${r.spindle}: ${r.torque} Nm  ${r.angle}°`));
  });

  runner.on('tighteningIncomplete', ({ expected, received }) =>
    console.warn(`[${id}] ⚠ Incomplete cycle: ${received}/${expected} spindles`));

  runner.on('alarm', (alarm) =>
    console.error(`[${id}] 🚨 ALARM ${alarm.alarmCode}: ${alarm.message}`));

  runner.on('reconnecting', ({ attempt }) =>
    console.warn(`[${id}] Reconnect attempt #${attempt}...`));

  runner.on('linkEstablished', async () => {
    try {
      await runner.selectJob(1);
      await runner.enableTool();
      console.log(`[${id}] Tool enabled`);
    } catch (err) {
      console.error(`[${id}] Setup failed: ${err.message}`);
    }
  });

  runner.connect().catch(() =>
    console.error(`[${id}] Initial connection failed — autoReconnect active`));
});
