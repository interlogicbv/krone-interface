import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { fetchEtaTargets, type EtaTarget } from './db.js';
import { computeShipmentStatus, deliverEtaMail, renderEtaMail, type ShipmentStatus } from './eta.js';
import type { PositionStore } from './store.js';

/** How often the planner re-reads the trip list and re-evaluates delays. */
const REFRESH_CRON = '*/5 * * * *';
/** Only start monitoring a trip once it is within this window before its agreed time. */
const MONITOR_LEAD_MS = 6 * 60 * 60 * 1000;
/** Stop monitoring a not-yet-arrived trip this long after its agreed time. */
const MONITOR_TAIL_MS = 6 * 60 * 60 * 1000;
/** Pace between OSRM/Nominatim calls within one pass (~1 req/s policy). */
const PACE_MS = 1200;
/** State entries older than this are pruned. */
const RETENTION_MS = 48 * 60 * 60 * 1000;

/** Persisted per-trip state, so restarts never cause duplicate or missed mails. */
interface TripState {
  /** ISO timestamp of the first delay mail (absent = never reported late). */
  firstLateAt?: string;
  /** Delay (minutes) reported in the most recent delay mail. */
  lastDelayMinutes?: number;
  /** ISO timestamp of the arrival-confirmation mail. */
  arrivalSentAt?: string;
  /** ISO timestamp at which the trip was closed without further mails (on time / gave up). */
  closedAt?: string;
}

type FetchTargets = (config: Config) => Promise<EtaTarget[]>;
type ComputeStatus = typeof computeShipmentStatus;
type Deliver = typeof deliverEtaMail;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Monitors each trip and mails the customer only when the shipment is running
 * late. The first delay triggers one mail; further mails follow only when the
 * delay grows by at least LATE_STEP_MINUTES. A shipment that was late gets a
 * closing arrival mail. Trips that stay on time never generate a mail.
 *
 * The trip list is refreshed every few minutes and per-trip state is
 * persisted, so restarts never duplicate mails.
 */
export class EtaPlanner {
  private readonly stateFile: string;
  private state: Record<string, TripState> = {};
  private job: Cron | undefined;
  private ticking = false;

  constructor(
    private readonly config: Config,
    private readonly store: PositionStore,
    private readonly fetchTargets: FetchTargets = fetchEtaTargets,
    private readonly computeStatus: ComputeStatus = computeShipmentStatus,
    private readonly deliver: Deliver = deliverEtaMail,
  ) {
    mkdirSync(config.dataDir, { recursive: true });
    this.stateFile = join(config.dataDir, 'eta-state.json');
    if (existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            // Tolerate the old string-valued format by treating it as closed.
            this.state[key] =
              typeof value === 'object' && value !== null
                ? (value as TripState)
                : { closedAt: String(value) };
          }
        }
      } catch {
        this.state = {};
      }
    }
  }

  start(log: FastifyBaseLogger): void {
    this.job = new Cron(REFRESH_CRON, { timezone: this.config.timezone }, () => this.tick(log));
    log.info(
      {
        refresh: REFRESH_CRON,
        lateThresholdMinutes: this.config.lateThresholdMinutes,
        lateStepMinutes: this.config.lateStepMinutes,
      },
      'ETA planner started (mails go out only when a shipment runs late)',
    );
    void this.tick(log);
  }

  stop(): void {
    this.job?.stop();
  }

  /** One planner pass: re-evaluate every monitored trip and mail what is due. */
  async tick(log: FastifyBaseLogger): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const targets = await this.fetchTargets(this.config);
      const now = Date.now();
      let calls = 0;

      for (const target of targets) {
        if (!target.plannedAt) continue;
        const key = this.keyFor(target);
        const state = this.state[key] ?? {};
        if (state.closedAt || state.arrivalSentAt) continue;

        const planned = target.plannedAt.getTime();
        if (now < planned - MONITOR_LEAD_MS) continue; // too early to bother
        if (now > planned + MONITOR_TAIL_MS) {
          this.save(key, { ...state, closedAt: `${new Date().toISOString()} gave-up` });
          continue;
        }

        // Pace the external routing calls across the trips we actually evaluate.
        if (calls++ > 0) await sleep(PACE_MS);
        let status;
        try {
          status = await this.computeStatus(this.config, this.store, target);
        } catch (err) {
          log.error({ vehicle: target.vehicle, err: String(err) }, 'ETA status check failed');
          continue;
        }
        if (!status) continue; // no position yet — retry next pass

        if (status.arrived) {
          if (state.firstLateAt) {
            if (await this.send(target, status, log, 'arrived')) {
              this.save(key, { ...state, arrivalSentAt: new Date().toISOString() });
            }
          } else {
            // Arrived on time (or never flagged late): close without mailing.
            this.save(key, { ...state, closedAt: `${new Date().toISOString()} on-time` });
          }
          continue;
        }

        const late = status.minutesLate ?? 0;
        if (late <= this.config.lateThresholdMinutes) continue; // on time within margin

        if (!state.firstLateAt) {
          if (await this.send(target, status, log, 'first delay')) {
            this.save(key, { firstLateAt: new Date().toISOString(), lastDelayMinutes: late });
          }
        } else if (late >= (state.lastDelayMinutes ?? 0) + this.config.lateStepMinutes) {
          if (await this.send(target, status, log, 'delay increased')) {
            this.save(key, { ...state, lastDelayMinutes: late });
          }
        }
        // else: still late but not materially worse — no new mail
      }

      this.prune(now);
    } catch (err) {
      log.error(err, 'ETA planner pass failed');
    } finally {
      this.ticking = false;
    }
  }

  private keyFor(target: EtaTarget): string {
    return `${target.vehicle}|${target.destinationAddress}|${target.plannedAt!.toISOString()}`.toLowerCase();
  }

  private async send(
    target: EtaTarget,
    status: ShipmentStatus,
    log: FastifyBaseLogger,
    reason: string,
  ): Promise<boolean> {
    try {
      const mail = renderEtaMail(this.config, status);
      await this.deliver(this.config, target, mail);
      log.info(
        { vehicle: target.vehicle, reason, minutesLate: status.minutesLate, subject: mail.subject },
        'delay mail sent',
      );
      return true;
    } catch (err) {
      log.error({ vehicle: target.vehicle, reason, err: String(err) }, 'delay mail failed');
      return false;
    }
  }

  private save(key: string, state: TripState): void {
    this.state[key] = state;
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private prune(now: number): void {
    let changed = false;
    for (const [key, value] of Object.entries(this.state)) {
      const newest = [value.firstLateAt, value.arrivalSentAt, value.closedAt]
        .map((v) => Date.parse((v ?? '').split(' ')[0] ?? ''))
        .filter((n) => Number.isFinite(n));
      const latest = newest.length ? Math.max(...newest) : 0;
      if (latest && now - latest > RETENTION_MS) {
        delete this.state[key];
        changed = true;
      }
    }
    if (changed) writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }
}
