import { existsSync } from 'node:fs';

/** Configuration via environment variables, with sensible defaults for local development. */

export interface Config {
  host: string;
  port: number;
  /** Path on which Krone pushes are received. */
  webhookPath: string;
  /** When set (together with basicAuthPassword), incoming requests must carry Basic Auth. */
  basicAuthUser: string | undefined;
  /**
   * Expected Basic Auth password. Note: the Krone portal sends the configured
   * password SHA-256 hashed (hex), so configure the hash you set up there —
   * both the raw value and its SHA-256 hash are accepted.
   */
  basicAuthPassword: string | undefined;
  /**
   * When true, only requests from the official Krone push IPs are accepted.
   * Leave off during local development / when running behind a proxy that
   * does not forward the client IP.
   */
  enforceIpAllowlist: boolean;
  /**
   * Only enable when running behind a reverse proxy (nginx/Caddy): the client
   * IP is then taken from X-Forwarded-For. With the server directly exposed
   * this MUST stay off, otherwise the IP allowlist can be spoofed via that
   * header.
   */
  trustProxy: boolean;

  /** Directory for the JSON position store. */
  dataDir: string;
  /** IANA timezone for the schedule and formatted times in the email. */
  timezone: string;

  /** Trailer for the ETA mail (license plate, VH_ID, asset name or box ID). */
  etaVehicle: string | undefined;
  /** Destination address for the ETA calculation. */
  etaDestinationAddress: string | undefined;
  /** Optional fixed destination coordinates; skips geocoding when set. */
  etaDestinationLat: number | undefined;
  etaDestinationLon: number | undefined;
  /** Cron expression for the ETA mail, e.g. "0 6 * * *" (06:00). Empty = no schedule. */
  etaCron: string | undefined;

  /** SMTP settings; without smtpHost the report is printed to the console (dry-run). */
  smtpHost: string | undefined;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | undefined;
  smtpPassword: string | undefined;
  mailFrom: string | undefined;
  /** Recipient of the report email. */
  mailTo: string | undefined;
}

/** Official source IPs of the Krone Push Default Service (per Swagger spec v1.8.1). */
export const KRONE_PUSH_IPS = ['85.236.61.180', '85.236.61.181'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Node 20.12+ can load .env files natively; no dotenv dependency needed.
  // Variables already present in the environment take precedence.
  if (env === process.env && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    webhookPath: env.WEBHOOK_PATH ?? '/krone/push',
    basicAuthUser: env.BASIC_AUTH_USER,
    basicAuthPassword: env.BASIC_AUTH_PASSWORD,
    enforceIpAllowlist: env.ENFORCE_IP_ALLOWLIST === 'true',
    trustProxy: env.TRUST_PROXY === 'true',

    dataDir: env.DATA_DIR ?? 'data',
    timezone: env.TIMEZONE ?? 'Europe/Amsterdam',

    etaVehicle: env.ETA_VEHICLE,
    etaDestinationAddress: env.ETA_DESTINATION_ADDRESS,
    etaDestinationLat: env.ETA_DESTINATION_LAT ? Number(env.ETA_DESTINATION_LAT) : undefined,
    etaDestinationLon: env.ETA_DESTINATION_LON ? Number(env.ETA_DESTINATION_LON) : undefined,
    etaCron: env.ETA_CRON,

    smtpHost: env.SMTP_HOST,
    smtpPort: Number(env.SMTP_PORT ?? 587),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    mailFrom: env.MAIL_FROM,
    mailTo: env.MAIL_TO,
  };
}
