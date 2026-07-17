/**
 * Sends the ETA mails once and exits.
 *
 * Usage:
 *   npm run eta           - send all of today's trips NOW (regardless of
 *                           agreed times; the planner may send them again
 *                           at their normal moment)
 *   npm run eta -- --dry  - print the mails to the console without sending
 */
import { loadConfig } from './config.js';
import { sendEtaMails } from './eta.js';
import { PositionStore } from './store.js';

const dry = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const config = loadConfig();
// Without an SMTP host the send path falls back to printing to the console.
const effectiveConfig = dry ? { ...config, smtpHost: undefined } : config;
const store = new PositionStore(effectiveConfig.dataDir);

if (dry) console.log('DRY RUN: er wordt niets verstuurd.\n');
const results = await sendEtaMails(effectiveConfig, store);
for (const r of results) {
  if (r.error) {
    console.error(`FAILED ${r.target.vehicle} -> ${r.target.destinationAddress}: ${r.error}`);
  } else if (!dry && effectiveConfig.smtpHost && effectiveConfig.mailTo) {
    console.log(`Sent for ${r.target.vehicle}: "${r.subject}"`);
  }
}
if (results.length === 0) console.log('Geen ritten gevonden (query gaf geen rijen terug).');
if (results.some((r) => r.error)) process.exit(1);
