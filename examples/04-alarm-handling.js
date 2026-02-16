// Shows how to handle industrial alarms and perform automated recoveries.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100' });

nutrunner.on('alarm', (alarm) => {
  console.error(`🚨 ALARM [${alarm.alarmCode}]: ${alarm.message}`);
  // Auto-acknowledge safety code '0001'
  if (alarm.alarmCode === '0001') {
    nutrunner.acknowledgeAlarm();
  }
});

nutrunner.on('alarmStatus', ({ alarmStatus }) => {
  console.log(`System Status: ${alarmStatus ? 'CRITICAL' : 'OK'}`);
});

nutrunner.connect();