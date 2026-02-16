//The standard entry point for establishing communication and enabling the tool.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({
  host: '192.168.1.100',
  port: 4545
});

nutrunner.on('connected', () => console.log('✓ Connected to Controller'));
nutrunner.on('linkEstablished', async (rev) => {
  console.log(`✓ Comm Link Active (Rev ${rev.revision})`);
  try {
    await nutrunner.selectJob(1);
    await nutrunner.enableTool();
    console.log('Tool Enabled. Waiting for operator start...');
  } catch (err) {
    console.error('Setup Failed:', err.message);
  }
});

nutrunner.on('tighteningCycleCompleted', ({ results, overallOk }) => {
  console.log(`Status: ${overallOk ? 'OK' : 'NOK'}`);
  results.forEach(r => console.log(`  Spindle ${r.spindle}: ${r.torque} Nm`));
});

nutrunner.connect().catch(console.error);