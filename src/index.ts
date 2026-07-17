import { Cron } from 'croner';
import { loadConfig } from './config.js';
import { sendEtaMail } from './eta.js';
import { buildServer } from './server.js';
import { PositionStore } from './store.js';

const config = loadConfig();
const store = new PositionStore(config.dataDir);
const app = buildServer(config, store);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { webhookPath: config.webhookPath, ipAllowlist: config.enforceIpAllowlist },
    'krone-interface ready to receive pushes',
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

let etaJob: Cron | undefined;
if (config.etaCron && config.etaVehicle && config.etaDestinationAddress) {
  etaJob = new Cron(config.etaCron, { timezone: config.timezone }, async () => {
    try {
      const mail = await sendEtaMail(config, store);
      app.log.info({ subject: mail.subject, mailTo: config.mailTo }, 'ETA mail sent');
    } catch (err) {
      app.log.error(err, 'sending ETA mail failed');
    }
  });
  app.log.info(
    {
      cron: config.etaCron,
      vehicle: config.etaVehicle,
      destination: config.etaDestinationAddress,
      nextRun: etaJob.nextRun()?.toISOString(),
    },
    'ETA mail scheduled',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    etaJob?.stop();
    await app.close();
    process.exit(0);
  });
}
