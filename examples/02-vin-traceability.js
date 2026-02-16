// Demonstrates how to link a vehicle identification number to the tightening data.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100' });

nutrunner.on('vinLocked', (vin) => {
  console.log(`🔒 Traceability: VIN ${vin} is now locked for this cycle.`);
});

nutrunner.on('tighteningCycleCompleted', ({ results }) => {
  const vin = nutrunner.getState().product.vin;
  console.log(`Saving results for VIN ${vin}:`, results);
});

nutrunner.connect().then(async () => {
  await nutrunner.downloadVIN('1HGBH41JXMN109186');
  await nutrunner.enableTool();
});