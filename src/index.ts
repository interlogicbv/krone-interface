import { Cron } from 'croner';
import { loadConfig } from './config.js';
import { isDbConfigured } from './db.js';
import { sendEtaMails } from './eta.js';
import { EtaPlanner } from './planner.js';
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

// Trips with an agreed time (planned_at) are monitored by the planner, which
// mails the customer only when the shipment is running late.
let planner: EtaPlanner | undefined;
if (isDbConfigured(config)) {
  planner = new EtaPlanner(config, store);
  planner.start(app.log);
}

// Trips without an agreed time (and the env fallback) go out on the fixed
// ETA_CRON schedule, if configured.
let etaJob: Cron | undefined;
if (config.etaCron) {
  etaJob = new Cron(config.etaCron, { timezone: config.timezone }, async () => {
    try {
      const results = await sendEtaMails(config, store, { excludePlanned: isDbConfigured(config) });
      for (const r of results) {
        if (r.error) {
          app.log.error({ vehicle: r.target.vehicle, error: r.error }, 'ETA mail failed');
        } else {
          app.log.info({ vehicle: r.target.vehicle, subject: r.subject }, 'ETA mail sent');
        }
      }
    } catch (err) {
      app.log.error(err, 'sending ETA mails failed');
    }
  });
  app.log.info(
    { cron: config.etaCron, nextRun: etaJob.nextRun()?.toISOString() },
    'ETA mail scheduled',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    planner?.stop();
    etaJob?.stop();
    await app.close();
    store.flush();
    process.exit(0);
  });
}
