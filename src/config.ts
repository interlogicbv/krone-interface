import { existsSync } from 'node:fs';

/** One customer whose trips get ETA mails, configured via CUSTOMER_<n>_NAME/_MAIL. */
export interface CustomerConfig {
  /** Customer name exactly as it appears in the TMS (RM_Relation.Name). */
  name: string;
  /** Recipient(s) for this customer's ETA mails, comma-separated; falls back to MAIL_TO. */
  mailTo: string | undefined;
}

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
  /** Log a summary line for every received push; disable for large fleets to keep the journal small. */
  logPushes: boolean;
  /** IANA timezone for the schedule and formatted times in the email. */
  timezone: string;

  /** Fallback trailer for the ETA mail when no database is configured. */
  etaVehicle: string | undefined;
  /** Fallback destination address when no database is configured. */
  etaDestinationAddress: string | undefined;
  /** Optional fixed destination coordinates; skips geocoding when set. */
  etaDestinationLat: number | undefined;
  etaDestinationLon: number | undefined;
  /** Cron expression for ETA mails of trips WITHOUT an agreed time. Empty = no schedule. */
  etaCron: string | undefined;
  /** How many minutes before the agreed time (planned_at) the ETA mail is sent. */
  etaLeadMinutes: number;
  /** Path to the SQL file that selects the trailer/destination combinations. */
  etaQueryFile: string;
  /** Customers whose trips get ETA mails; fills the @customers placeholder in the query. */
  customers: CustomerConfig[];

  /** MSSQL connection for dynamic ETA targets; leave unset to use the ETA_* fallback. */
  mssqlServer: string | undefined;
  mssqlDatabase: string | undefined;
  mssqlUser: string | undefined;
  mssqlPassword: string | undefined;
  /** TLS-encrypted connection; required for Azure SQL, off for on-prem servers without SSL. */
  mssqlEncrypt: boolean;

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

function loadCustomers(env: NodeJS.ProcessEnv): CustomerConfig[] {
  const customers: { index: number; customer: CustomerConfig }[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = /^CUSTOMER_(\d+)_NAME$/.exec(key);
    if (!match || !value?.trim()) continue;
    const mail = env[`CUSTOMER_${match[1]}_MAIL`]?.trim();
    customers.push({
      index: Number(match[1]),
      customer: { name: value.trim(), mailTo: mail || undefined },
    });
  }
  return customers.sort((a, b) => a.index - b.index).map((c) => c.customer);
}

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
    logPushes: env.LOG_PUSHES !== 'false',
    timezone: env.TIMEZONE ?? 'Europe/Amsterdam',

    etaVehicle: env.ETA_VEHICLE,
    etaDestinationAddress: env.ETA_DESTINATION_ADDRESS,
    etaDestinationLat: env.ETA_DESTINATION_LAT ? Number(env.ETA_DESTINATION_LAT) : undefined,
    etaDestinationLon: env.ETA_DESTINATION_LON ? Number(env.ETA_DESTINATION_LON) : undefined,
    etaCron: env.ETA_CRON,
    etaLeadMinutes: Number(env.ETA_LEAD_MINUTES ?? 60),
    etaQueryFile: env.ETA_QUERY_FILE ?? 'eta-query.sql',
    customers: loadCustomers(env),

    mssqlServer: env.MSSQL_SERVER,
    mssqlDatabase: env.MSSQL_DATABASE,
    mssqlUser: env.MSSQL_USER,
    mssqlPassword: env.MSSQL_PASSWORD,
    mssqlEncrypt: env.MSSQL_ENCRYPT === 'true',

    smtpHost: env.SMTP_HOST,
    smtpPort: Number(env.SMTP_PORT ?? 587),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    mailFrom: env.MAIL_FROM,
    mailTo: env.MAIL_TO,
  };
}
