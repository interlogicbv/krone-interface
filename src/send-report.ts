/** Sends the trailer report once and exits. Usage: npm run report */
import { loadConfig } from './config.js';
import { sendReport } from './report.js';
import { PositionStore } from './store.js';

const config = loadConfig();
const store = new PositionStore(config.dataDir);

const report = await sendReport(config, store);
if (config.smtpHost && config.mailTo) {
  console.log(`Rapport verzonden naar ${config.mailTo}: "${report.subject}"`);
}
