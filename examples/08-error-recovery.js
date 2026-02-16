// Utilizing the library's InterlockError to handle safety violations gracefully.

const { OpenProtocolNutrunner, InterlockError } = require('node-nutrunner-open-library');

const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100', autoReconnect: true });

nutrunner.on('reconnecting', ({ attempt }) => {
  console.warn(`Connection interrupted. Attempting recovery #${attempt}...`);
});

async function triggerStart() {
  try {
    await nutrunner.startTightening();
  } catch (err) {
    if (err instanceof InterlockError) {
      console.error(`Safety Interlock Active: ${err.code} - ${err.message}`);
    } else {
      console.error('Operational Error:', err.message);
    }
  }
}

nutrunner.connect();