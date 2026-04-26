// 04-alarm-handling.js
// Handles industrial alarms and performs automated recovery where safe to do so.

'use strict';

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host:          '192.168.1.36',
  brand:         'generic',
  autoReconnect: true
});

nutrunner.on('alarm', (alarm) => {
  console.error(`🚨 ALARM [${alarm.alarmCode}]: ${alarm.message}`);
  // Auto-acknowledge informational alarm code E001
  if (alarm.alarmCode === 'E001') {
    console.log('  Auto-acknowledging alarm E001...');
    nutrunner.acknowledgeAlarm();
  }
});

nutrunner.on('alarmStatus', ({ alarmStatus, currentAlarms }) => {
  if (alarmStatus) {
    console.warn(`  Active alarms: ${currentAlarms.join(', ')}`);
  } else {
    console.log('✓ All alarms cleared — controller ready');
  }
});

nutrunner.on('linkEstablished', async () => {
  try {
  //  await nutrunner.selectJob(1);
    await nutrunner.enableTool();
    console.log('Tool enabled — monitoring alarms...');
  } catch (err) {
    console.error('Setup failed:', err.message);
  }
});

nutrunner.on('reconnecting', ({ attempt, delay }) =>
  console.warn(`  Reconnect attempt #${attempt} in ${delay} ms...`));

nutrunner.on('error', err =>
  console.error('Socket error:', err.message));

async function main() {
  await nutrunner.connect();
}

main().catch(console.error);
