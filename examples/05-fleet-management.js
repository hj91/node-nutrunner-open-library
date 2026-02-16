// Managing multiple nutrunner stations across a factory floor.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const stations = [
  { id: 'Pune-Line-1', host: '192.168.1.101' },
  { id: 'Pune-Line-2', host: '192.168.1.102' }
];

stations.forEach(cfg => {
  const runner = new OpenProtocolNutrunner(cfg);
  runner.on('tighteningCycleCompleted', (data) => {
    console.log(`[${cfg.id}] Result: ${data.overallOk ? 'SUCCESS' : 'FAILURE'}`);
  });
  runner.connect().catch(() => console.error(`[${cfg.id}] Offline`));
});