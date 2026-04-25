// 08-error-recovery.js
// Uses InterlockError to handle safety violations and demonstrates
// revision downgrade events during reconnect cycles.

'use strict';

const { OpenProtocolNutrunner, InterlockError } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:          '192.168.1.100',
  brand:         'atlas-copco',
  autoReconnect: true
});

nutrunner.on('revisionNegotiated', ({ revision }) =>
  console.log(`✓ Revision negotiated: Rev ${revision}`));

nutrunner.on('revisionDowngrade', ({ from, to }) =>
  console.warn(`  ↓ Controller rejected Rev ${from} — retrying Rev ${to}`));

nutrunner.on('reconnecting', ({ attempt, delay }) =>
  console.warn(`  Reconnect attempt #${attempt} in ${delay} ms...`));

nutrunner.on('alarm', (alarm) => {
  console.error(`🚨 ALARM [${alarm.alarmCode}]: ${alarm.message}`);
  nutrunner.acknowledgeAlarm();
});

nutrunner.on('commandTimeout', ({ mid }) =>
  console.warn(`  Command MID ${mid} timed out — no ACK received`));

async function attemptTightening() {
  try {
    nutrunner.startTightening();
  } catch (err) {
    if (err instanceof InterlockError) {
      console.error(`Safety interlock [${err.code}]: ${err.message}`);
      // Specific recovery strategies per interlock code
      switch (err.code) {
        case 'TOOL_DISABLED':
          console.log('  → Re-enabling tool...');
          await nutrunner.enableTool();
          break;
        case 'JOB_NOT_ACTIVE':
          console.log('  → Re-selecting job...');
          await nutrunner.selectJob(1);
          break;
        case 'ALARM_ACTIVE':
          console.log('  → Acknowledging alarm and waiting...');
          nutrunner.acknowledgeAlarm();
          break;
        case 'VIN_REQUIRED':
          console.log('  → VIN required before tightening');
          break;
        default:
          console.error('  Unhandled interlock — manual intervention needed');
      }
    } else {
      console.error('Operational error:', err.message);
    }
  }
}

nutrunner.on('linkEstablished', async () => {
  try {
    await nutrunner.selectJob(1);
    await nutrunner.enableTool();
    // Simulate an immediate trigger attempt to demonstrate error handling
    setTimeout(attemptTightening, 500);
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
