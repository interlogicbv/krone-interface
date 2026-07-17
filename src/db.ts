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
  /** Optional recipient override; falls back to MAIL_TO. */
  mailTo?: string;
}

function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (names.includes(key.toLowerCase())) return value;
  }
  return undefined;
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
    for (const row of result.recordset) {
      const vehicle = pick(row, 'vehicle', 'trailer', 'license');
      const destination = pick(row, 'destination', 'destination_address', 'address');
      if (typeof vehicle !== 'string' || vehicle.trim() === '') continue;
      if (typeof destination !== 'string' || destination.trim() === '') continue;
      const lat = pick(row, 'destination_lat', 'lat', 'latitude');
      const lon = pick(row, 'destination_lon', 'lon', 'longitude');
      const mailTo = pick(row, 'mail_to', 'email', 'recipient');
      targets.push({
        vehicle: vehicle.trim(),
        destinationAddress: destination.trim(),
        ...(typeof lat === 'number' && { destinationLat: lat }),
        ...(typeof lon === 'number' && { destinationLon: lon }),
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
