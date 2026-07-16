import { Cron } from 'croner';
import { loadConfig } from './config.js';
import { sendEtaMail } from './eta.js';
import { sendReport } from './report.js';
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

let reportJob: Cron | undefined;
if (config.reportCron) {
  reportJob = new Cron(config.reportCron, { timezone: config.timezone }, async () => {
    try {
      const report = await sendReport(config, store);
      app.log.info({ subject: report.subject, mailTo: config.mailTo }, 'daily report sent');
    } catch (err) {
      app.log.error(err, 'sending daily report failed');
    }
  });
  app.log.info(
    { cron: config.reportCron, timezone: config.timezone, nextRun: reportJob.nextRun()?.toISOString() },
    'daily report scheduled',
  );
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
    reportJob?.stop();
    etaJob?.stop();
    await app.close();
    process.exit(0);
  });
}
