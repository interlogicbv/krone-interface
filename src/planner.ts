import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { fetchEtaTargets, type EtaTarget } from './db.js';
import { sendOneEtaMail } from './eta.js';
import type { PositionStore } from './store.js';

/** How often the planner re-reads the trip list from the database. */
const REFRESH_CRON = '*/5 * * * *';
/** A mail whose send moment passed more than this long ago is skipped. */
const GRACE_MS = 60 * 60 * 1000;
/** Sent-administration entries older than this are pruned. */
const RETENTION_MS = 48 * 60 * 60 * 1000;

type FetchTargets = (config: Config) => Promise<EtaTarget[]>;
type SendMail = typeof sendOneEtaMail;

/**
 * Sends each trip's ETA mail ETA_LEAD_MINUTES before its agreed time.
 * Refreshes the trip list from the database every few minutes, so trips
 * planned during the day are picked up automatically. The sent
 * administration is persisted, so a service restart never causes
 * duplicate mails.
 */
export class EtaPlanner {
  private readonly sentFile: string;
  private sent: Record<string, string> = {};
  private job: Cron | undefined;
  private ticking = false;

  constructor(
    private readonly config: Config,
    private readonly store: PositionStore,
    private readonly fetchTargets: FetchTargets = fetchEtaTargets,
    private readonly sendMail: SendMail = sendOneEtaMail,
  ) {
    this.sentFile = join(config.dataDir, 'sent-eta-mails.json');
    if (existsSync(this.sentFile)) {
      this.sent = JSON.parse(readFileSync(this.sentFile, 'utf8')) as Record<string, string>;
    }
  }

  start(log: FastifyBaseLogger): void {
    this.job = new Cron(REFRESH_CRON, { timezone: this.config.timezone }, () => this.tick(log));
    log.info(
      { refresh: REFRESH_CRON, leadMinutes: this.config.etaLeadMinutes },
      'ETA planner started (mails go out before each agreed time)',
    );
    void this.tick(log);
  }

  stop(): void {
    this.job?.stop();
  }

  /** One planner pass: fetch trips and send everything that is due. */
  async tick(log: FastifyBaseLogger): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const targets = await this.fetchTargets(this.config);
      const now = Date.now();
      const leadMs = this.config.etaLeadMinutes * 60 * 1000;

      for (const target of targets) {
        if (!target.plannedAt) continue;
        const key = `${target.vehicle}|${target.destinationAddress}|${target.plannedAt.toISOString()}`.toLowerCase();
        if (this.sent[key]) continue;
        const sendAt = target.plannedAt.getTime() - leadMs;
        if (now < sendAt) continue;

        if (now > sendAt + GRACE_MS) {
          // Too late (service was down, or trip was added after the fact).
          this.markSent(key, 'skipped');
          log.warn(
            { vehicle: target.vehicle, plannedAt: target.plannedAt.toISOString() },
            'ETA mail skipped: send moment passed too long ago',
          );
          continue;
        }

        const result = await this.sendMail(this.config, this.store, target);
        this.markSent(key, result.error ? `failed: ${result.error}` : 'sent');
        if (result.error) {
          log.error({ vehicle: target.vehicle, error: result.error }, 'ETA mail failed');
        } else {
          log.info(
            { vehicle: target.vehicle, subject: result.subject, plannedAt: target.plannedAt.toISOString() },
            'ETA mail sent',
          );
        }
      }

      this.prune(now);
    } catch (err) {
      log.error(err, 'ETA planner pass failed');
    } finally {
      this.ticking = false;
    }
  }

  private markSent(key: string, status: string): void {
    this.sent[key] = `${new Date().toISOString()} ${status}`;
    writeFileSync(this.sentFile, JSON.stringify(this.sent, null, 2));
  }

  private prune(now: number): void {
    let changed = false;
    for (const [key, value] of Object.entries(this.sent)) {
      const timestamp = Date.parse(value.split(' ')[0] ?? '');
      if (Number.isFinite(timestamp) && now - timestamp > RETENTION_MS) {
        delete this.sent[key];
        changed = true;
      }
    }
    if (changed) writeFileSync(this.sentFile, JSON.stringify(this.sent, null, 2));
  }
}
