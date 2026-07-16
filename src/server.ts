import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { KRONE_PUSH_IPS, type Config } from './config.js';
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

/** Checks Basic Auth; the password may be sent raw or SHA-256 hashed (Krone sends the hash). */
function isAuthorized(header: string | undefined, user: string, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const sentUser = decoded.slice(0, separator);
  const sentPassword = decoded.slice(separator + 1);
  if (!safeEquals(sentUser, user)) return false;
  return safeEquals(sentPassword, password) || safeEquals(sentPassword, sha256Hex(password));
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

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: process.stdout.isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : true,
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
      const authHeader = request.headers.authorization;
      if (!isAuthorized(authHeader, config.basicAuthUser, config.basicAuthPassword)) {
        request.log.warn('rejected push with missing or invalid Basic Auth');
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

    request.log.info(extractGeoSummary(push), 'trailer position received');

    const body: KroneSuccessResponse = { id: push.id, received, status: 'OK' };
    return reply.code(201).send(body);
  });

  return app;
}
