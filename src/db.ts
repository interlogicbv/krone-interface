import { readFileSync } from 'node:fs';
import sql from 'mssql';
import type { Config } from './config.js';

/** One trailer + destination combination for which an ETA mail is sent. */
export interface EtaTarget {
  /** Trailer identifier: license plate, VH_ID, asset name or box ID. */
  vehicle: string;
  /** Destination address for the ETA calculation. */
  destinationAddress: string;
  /** Optional fixed destination coordinates (skips geocoding). */
  destinationLat?: number;
  destinationLon?: number;
  /** Agreed (unloading) time; the mail is sent ETA_LEAD_MINUTES before this. */
  plannedAt?: Date;
  /** Optional recipient override; falls back to MAIL_TO. */
  mailTo?: string;
}

/** Offset (ms) of a timezone relative to UTC at the given instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/**
 * Parses a 'YYYY-MM-DD HH:mm(:ss)' wall-clock string in the given timezone to
 * a UTC instant. The TMS stores local times; the server may run in any zone.
 */
export function parsePlannedAt(value: unknown, timezone: string): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const asIfUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  // Two passes to land on the correct side of a DST transition.
  const refined = asIfUtc - tzOffsetMs(asIfUtc, timezone);
  return new Date(asIfUtc - tzOffsetMs(refined, timezone));
}

function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (names.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

/**
 * Coerces a coordinate that may arrive as number or string; 0 and invalid
 * values count as absent (TMS addresses without geocoding store 0).
 */
function asCoordinate(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

/**
 * Runs the ETA query (from config.etaQueryFile) against the MSSQL database and
 * maps the rows to ETA targets.
 *
 * Column contract (case-insensitive): `vehicle` and `destination` are
 * required; `destination_lat`, `destination_lon` and `mail_to` are optional.
 */
export async function fetchEtaTargets(config: Config): Promise<EtaTarget[]> {
  if (!config.mssqlServer || !config.mssqlDatabase || !config.mssqlUser || !config.mssqlPassword) {
    throw new Error('MSSQL_SERVER, MSSQL_DATABASE, MSSQL_USER and MSSQL_PASSWORD must be configured');
  }
  const queryText = readFileSync(config.etaQueryFile, 'utf8');

  const pool = await sql.connect({
    server: config.mssqlServer,
    database: config.mssqlDatabase,
    user: config.mssqlUser,
    password: config.mssqlPassword,
    options: {
      encrypt: true, // required for Azure SQL
      trustServerCertificate: false,
    },
    pool: { max: 2, min: 0 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  });

  try {
    const result = await pool.request().query<Record<string, unknown>>(queryText);
    const targets: EtaTarget[] = [];
    const seen = new Set<string>();
    for (const row of result.recordset) {
      const vehicle = pick(row, 'vehicle', 'trailer', 'license');
      const destination = pick(row, 'destination', 'destination_address', 'address');
      if (typeof vehicle !== 'string' || vehicle.trim() === '') continue;
      if (typeof destination !== 'string' || destination.trim() === '') continue;
      const plannedRaw = pick(row, 'planned_at', 'planned', 'planned_time');
      const key = `${vehicle.trim().toLowerCase()}|${destination.trim().toLowerCase()}|${String(plannedRaw ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lat = asCoordinate(pick(row, 'destination_lat', 'lat', 'latitude'));
      const lon = asCoordinate(pick(row, 'destination_lon', 'lon', 'longitude'));
      const mailTo = pick(row, 'mail_to', 'email', 'recipient');
      const plannedAt = parsePlannedAt(plannedRaw, config.timezone);
      targets.push({
        vehicle: vehicle.trim(),
        destinationAddress: destination.trim(),
        // Only use fixed coordinates when both are present and valid.
        ...(lat !== undefined && lon !== undefined && { destinationLat: lat, destinationLon: lon }),
        ...(plannedAt !== undefined && { plannedAt }),
        ...(typeof mailTo === 'string' && mailTo.trim() !== '' && { mailTo: mailTo.trim() }),
      });
    }
    return targets;
  } finally {
    await pool.close();
  }
}

/** Whether a database connection is configured (otherwise the ETA_* env fallback is used). */
export function isDbConfigured(config: Config): boolean {
  return Boolean(config.mssqlServer && config.mssqlDatabase && config.mssqlUser && config.mssqlPassword);
}
