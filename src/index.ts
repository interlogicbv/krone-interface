import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer(config);

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
