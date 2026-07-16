/** Sends the ETA mail once and exits. Usage: npm run eta */
import { loadConfig } from './config.js';
import { sendEtaMail } from './eta.js';
import { PositionStore } from './store.js';

const config = loadConfig();
const store = new PositionStore(config.dataDir);

const mail = await sendEtaMail(config, store);
if (config.smtpHost && config.mailTo) {
  console.log(`ETA mail sent to ${config.mailTo}: "${mail.subject}"`);
}
