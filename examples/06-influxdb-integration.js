// Storing tightening data into a time-series database for analytics.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const writeApi = new InfluxDB({ url: 'http://localhost:8086', token: 'TOKEN' }).getWriteApi('org', 'bucket');
const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100' });

nutrunner.on('tighteningCycleCompleted', ({ results }) => {
  results.forEach(r => {
    const p = new Point('torque_data')
      .tag('spindle', r.spindle.toString())
      .floatField('torque', r.torque)
      .floatField('angle', r.angle);
    writeApi.writePoint(p);
  });
  writeApi.flush();
});

nutrunner.connect();