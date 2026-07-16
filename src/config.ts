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
  };
}
