import { readFileSync } from 'node:fs';
import sql from 'mssql';
import type { Config, CustomerConfig } from './config.js';

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
  /** Loading address the trailer departed from; shown in the mail. */
  origin?: string;
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
 * Replaces the `@customers` placeholder in the query with one bound SQL
 * parameter per configured customer, so names never end up in the SQL text
 * itself. Exported for testing.
 */
export function expandCustomers(
  queryText: string,
  customers: CustomerConfig[],
): { sqlText: string; params: Record<string, string> } {
  if (!/@customers\b/.test(queryText)) return { sqlText: queryText, params: {} };
  if (customers.length === 0) {
    throw new Error(
      'The query uses @customers, but no customers are configured — add CUSTOMER_1_NAME (and CUSTOMER_1_MAIL) to .env',
    );
  }
  const params: Record<string, string> = {};
  const placeholders = customers.map((c, i) => {
    params[`customer${i}`] = c.name;
    return `@customer${i}`;
  });
  return { sqlText: queryText.replace(/@customers\b/g, placeholders.join(', ')), params };
}

/**
 * Runs the ETA query (from config.etaQueryFile) against the MSSQL database and
 * maps the rows to ETA targets.
 *
 * Column contract (case-insensitive): `vehicle` and `destination` are
 * required; `destination_lat`, `destination_lon`, `planned_at`, `origin`,
 * `customer` and `mail_to` are optional. When a row carries a `customer`
 * matching a CUSTOMER_<n>_NAME from .env, that customer's mail addresses are
 * used (an explicit `mail_to` column still wins).
 */
export async function fetchEtaTargets(config: Config): Promise<EtaTarget[]> {
  if (!config.mssqlServer || !config.mssqlDatabase || !config.mssqlUser || !config.mssqlPassword) {
    throw new Error('MSSQL_SERVER, MSSQL_DATABASE, MSSQL_USER and MSSQL_PASSWORD must be configured');
  }
  const queryText = readFileSync(config.etaQueryFile, 'utf8');
  const { sqlText, params } = expandCustomers(queryText, config.customers);

  const pool = await sql.connect({
    server: config.mssqlServer,
    database: config.mssqlDatabase,
    user: config.mssqlUser,
    password: config.mssqlPassword,
    options: {
      encrypt: config.mssqlEncrypt, // set MSSQL_ENCRYPT=true for Azure SQL
      trustServerCertificate: !config.mssqlEncrypt,
    },
    pool: { max: 2, min: 0 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  });

  try {
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) {
      request.input(name, sql.NVarChar, value);
    }
    const result = await request.query<Record<string, unknown>>(sqlText);
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
      const plannedAt = parsePlannedAt(plannedRaw, config.timezone);
      const origin = pick(row, 'origin', 'loading_address', 'from');
      // Recipients: an explicit mail_to column wins; otherwise the addresses
      // configured for the row's customer; otherwise MAIL_TO (in eta.ts).
      const customer = pick(row, 'customer', 'customer_name', 'klant');
      const customerMail =
        typeof customer === 'string'
          ? config.customers.find((c) => c.name.toLowerCase() === customer.trim().toLowerCase())
              ?.mailTo
          : undefined;
      const mailTo = pick(row, 'mail_to', 'email', 'recipient') ?? customerMail;
      targets.push({
        vehicle: vehicle.trim(),
        destinationAddress: destination.trim(),
        // Only use fixed coordinates when both are present and valid.
        ...(lat !== undefined && lon !== undefined && { destinationLat: lat, destinationLon: lon }),
        ...(plannedAt !== undefined && { plannedAt }),
        ...(typeof origin === 'string' && origin.trim() !== '' && { origin: origin.trim() }),
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
