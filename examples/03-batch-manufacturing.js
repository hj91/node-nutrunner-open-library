// Tracks batch progress, which is vital for assembly lines managing multiple fasteners per unit.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100' });

nutrunner.on('batchStarted', (b) => console.log(`📦 Batch ${b.batchId} (Size: ${b.size}) started.`));

nutrunner.on('batchProgress', ({ counter, size, remaining }) => {
  console.log(`Progress: ${counter}/${size} completed. ${remaining} to go.`);
});

nutrunner.on('batchCompleted', (b) => {
  console.log(`✓ Batch ${b.batchId} finished!`);
});

nutrunner.connect();