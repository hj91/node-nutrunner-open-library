// A bridge to expose real-time fastener data to a PLC or SCADA system via OPC UA.

const { OpenProtocolNutrunner } = require('node-nutrunner-open-library');
const { OPCUAServer, DataType } = require('node-opcua');

(async () => {
  const server = new OPCUAServer({ port: 4840 });
  await server.initialize();
  const ns = server.engine.addressSpace.getOwnNamespace();

  const torqueNode = ns.addVariable({
    browseName: 'LastFastenerTorque',
    dataType: 'Double',
    value: { dataType: DataType.Double, value: 0.0 }
  });

  const nutrunner = new OpenProtocolNutrunner({ host: '192.168.1.100' });
  nutrunner.on('tighteningCycleCompleted', ({ results }) => {
    torqueNode.setValueFromSource({ dataType: DataType.Double, value: results[0].torque });
  });

  await server.start();
  await nutrunner.connect();
})();