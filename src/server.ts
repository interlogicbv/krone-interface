import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { KRONE_PUSH_IPS, type Config } from './config.js';
import type { PositionStore } from './store.js';
import type {
  KroneErrorResponse,
  KronePushRequest,
  KroneSuccessResponse,
} from './types/krone.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

interface AuthResult {
  ok: boolean;
  /** Diagnostic detail for the log on failure; never contains the password itself. */
  reason?: string;
  sentUser?: string;
}

/** Checks Basic Auth; the password may be sent raw or SHA-256 hashed (Krone sends the hash). */
function checkAuth(header: string | undefined, user: string, password: string): AuthResult {
  if (!header) return { ok: false, reason: 'no authorization header' };
  if (!header.startsWith('Basic ')) return { ok: false, reason: 'not basic auth' };
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return { ok: false, reason: 'malformed basic auth value' };
  const sentUser = decoded.slice(0, separator);
  const sentPassword = decoded.slice(separator + 1);
  if (!safeEquals(sentUser, user)) {
    return { ok: false, reason: 'unknown username', sentUser };
  }
  const looksHashed = /^[0-9a-fA-F]{64}$/.test(sentPassword);
  const ok =
    safeEquals(sentPassword, password) ||
    safeEquals(sentPassword.toLowerCase(), sha256Hex(password)) ||
    safeEquals(sentPassword.toLowerCase(), sha256Hex(password.trim()));
  if (ok) return { ok: true };
  return {
    ok: false,
    sentUser,
    reason: looksHashed
      ? 'password mismatch (received a SHA-256 hash, but not of the configured password)'
      : 'password mismatch (received a plain password)',
  };
}

/** Renders the parts of a push we care about (geo location) as a single log-friendly object. */
function extractGeoSummary(push: KronePushRequest) {
  const boxdata = push.data?.boxdata ?? {};
  const vehicle = boxdata.vehicle ?? {};
  const gps = boxdata.gps ?? {};
  return {
    pushId: push.id,
    sharingId: push.sharingId,
    boxId: boxdata.BD_BOX_ID,
    vehicle: {
      id: vehicle.VH_ID,
      license: vehicle.VH_LICENSE,
      chassis: vehicle.VH_CHASSIS,
      assetName: vehicle.VH_ASSET_NAME,
    },
    position: {
      latitude: gps.BD_GPS_LATITUDE,
      longitude: gps.BD_GPS_LONGITUDE,
      address: gps.BD_GPS_LOCATION,
      speedKmh: gps.BD_GPS_SPEED,
      directionDeg: gps.BD_GPS_DIRECTION,
      gpsTime: typeof gps.BD_GPS_TIME === 'number' ? new Date(gps.BD_GPS_TIME).toISOString() : undefined,
    },
    isMoving: boxdata.BD_IS_MOVING,
    coupled: boxdata.BD_COUPLED,
    receivedByKrone:
      typeof boxdata.BD_TIME_RECEIVED === 'number'
        ? new Date(boxdata.BD_TIME_RECEIVED).toISOString()
        : undefined,
  };
}

export function buildServer(config: Config, store: PositionStore): FastifyInstance {
  const app = Fastify({
    logger: process.stdout.isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : true,
    // Our own summary line per push is more informative than the default
    // incoming/completed pair, and scanners probing the public port would
    // otherwise fill the journal with 404 noise.
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post(config.webhookPath, async (request, reply) => {
    const received = new Date().toISOString();
    const push = request.body as KronePushRequest | null;
    const pushId = push?.id ?? '';

    if (config.enforceIpAllowlist && !KRONE_PUSH_IPS.includes(request.ip)) {
      request.log.warn({ ip: request.ip }, 'rejected push from non-Krone IP');
      const body: KroneErrorResponse = {
        id: pushId,
        received,
        status: 'ERROR',
        error: { code: 403, message: 'Source IP not allowed.' },
      };
      return reply.code(403).send(body);
    }

    if (config.basicAuthUser && config.basicAuthPassword) {
      const auth = checkAuth(request.headers.authorization, config.basicAuthUser, config.basicAuthPassword);
      if (!auth.ok) {
        request.log.warn(
          { ip: request.ip, sentUser: auth.sentUser, reason: auth.reason },
          'rejected push: Basic Auth failed',
        );
        return reply
          .code(401)
          .header('www-authenticate', 'Basic realm="krone-interface"')
          .send();
      }
    }

    if (!push || typeof push !== 'object' || !push.id) {
      const body: KroneErrorResponse = {
        id: pushId,
        received,
        status: 'ERROR',
        error: { code: 400, message: 'Invalid push payload: missing id.' },
      };
      return reply.code(400).send(body);
    }

    if (config.logPushes) {
      request.log.info(extractGeoSummary(push), 'trailer position received');
    }
    store.record(push);

    const body: KroneSuccessResponse = { id: push.id, received, status: 'OK' };
    return reply.code(201).send(body);
  });

  // Read-only overview of the last known position per trailer.
  app.get('/positions', async () => store.all());

  return app;
}
