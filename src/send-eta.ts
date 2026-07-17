/** Sends the ETA mails once and exits. Usage: npm run eta */
import { loadConfig } from './config.js';
import { sendEtaMails } from './eta.js';
import { PositionStore } from './store.js';

const config = loadConfig();
const store = new PositionStore(config.dataDir);

const results = await sendEtaMails(config, store);
for (const r of results) {
  if (r.error) {
    console.error(`FAILED ${r.target.vehicle} -> ${r.target.destinationAddress}: ${r.error}`);
  } else if (config.smtpHost && config.mailTo) {
    console.log(`Sent for ${r.target.vehicle}: "${r.subject}"`);
  }
}
if (results.some((r) => r.error)) process.exit(1);
