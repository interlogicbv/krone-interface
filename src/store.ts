import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KronePushRequest } from './types/krone.js';

/** The most recent known position of a single trailer. */
export interface LastPosition {
  /** Key under which the vehicle is tracked (license plate, VH_ID or box ID). */
  vehicleKey: string;
  license?: string;
  assetName?: string;
  chassis?: string;
  boxId?: string;
  latitude?: number;
  longitude?: number;
  /** Reverse-geocoded address as reported by Krone. */
  address?: string;
  speedKmh?: number;
  isMoving?: boolean;
  /** ISO 8601 timestamp of the GPS fix itself. */
  gpsTime?: string;
  /** ISO 8601 timestamp at which we received the push. */
  receivedAt: string;
  /** Total number of pushes received for this vehicle. */
  pushCount: number;
}

/**
 * File-backed store of the latest position per vehicle.
 * Deliberately simple (one JSON file): fine for tracking a handful of
 * trailers; swap for a database when history is needed.
 */
export class PositionStore {
  private positions = new Map<string, LastPosition>();
  private readonly filePath: string;
  private persistTimer: NodeJS.Timeout | undefined;
  private persistPending = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'last-positions.json');
    if (existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as LastPosition[];
      for (const p of parsed) this.positions.set(p.vehicleKey, p);
    }
  }

  /** Extracts the position from a push and stores it as the vehicle's latest. */
  record(push: KronePushRequest): LastPosition | undefined {
    const boxdata = push.data?.boxdata;
    if (!boxdata) return undefined;
    const vehicle = boxdata.vehicle ?? {};
    const gps = boxdata.gps ?? {};

    const vehicleKey = vehicle.VH_LICENSE ?? vehicle.VH_ID ?? boxdata.BD_BOX_ID;
    if (!vehicleKey) return undefined;

    const previous = this.positions.get(vehicleKey);
    const position: LastPosition = {
      vehicleKey,
      receivedAt: new Date().toISOString(),
      pushCount: (previous?.pushCount ?? 0) + 1,
      ...(vehicle.VH_LICENSE !== undefined && { license: vehicle.VH_LICENSE }),
      ...(vehicle.VH_ASSET_NAME !== undefined && { assetName: vehicle.VH_ASSET_NAME }),
      ...(vehicle.VH_CHASSIS !== undefined && { chassis: vehicle.VH_CHASSIS }),
      ...(boxdata.BD_BOX_ID !== undefined && { boxId: boxdata.BD_BOX_ID }),
      ...(gps.BD_GPS_LATITUDE !== undefined && { latitude: gps.BD_GPS_LATITUDE }),
      ...(gps.BD_GPS_LONGITUDE !== undefined && { longitude: gps.BD_GPS_LONGITUDE }),
      ...(gps.BD_GPS_LOCATION !== undefined && { address: gps.BD_GPS_LOCATION }),
      ...(gps.BD_GPS_SPEED !== undefined && { speedKmh: gps.BD_GPS_SPEED }),
      ...(boxdata.BD_IS_MOVING !== undefined && { isMoving: boxdata.BD_IS_MOVING }),
      ...(typeof gps.BD_GPS_TIME === 'number' && {
        gpsTime: new Date(gps.BD_GPS_TIME).toISOString(),
      }),
    };

    // A push without GPS fix should not wipe the last known coordinates.
    if (position.latitude === undefined && previous?.latitude !== undefined) {
      position.latitude = previous.latitude;
      if (previous.longitude !== undefined) position.longitude = previous.longitude;
      if (previous.address !== undefined) position.address = previous.address;
      if (previous.gpsTime !== undefined) position.gpsTime = previous.gpsTime;
    }

    this.positions.set(vehicleKey, position);
    this.persist();
    return position;
  }

  /** All last-known positions, most recently updated first. */
  all(): LastPosition[] {
    return [...this.positions.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  /**
   * Finds a vehicle by license plate, VH_ID, asset name or box ID.
   * Matching is case-insensitive and ignores dashes/spaces, so the TMS
   * notation "OT-84-LL" matches the Krone notation "OT84LL" and vice versa.
   * Composite names like "Interlogic 25 / OT-93-KB" also match on each part.
   */
  find(identifier: string): LastPosition | undefined {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const needle = normalize(identifier);
    if (needle === '') return undefined;
    const matches = (v: string | undefined) =>
      v !== undefined &&
      [v, ...v.split('/')].some((part) => normalize(part) === needle);
    return this.all().find((p) =>
      [p.vehicleKey, p.license, p.assetName, p.boxId, p.chassis].some(matches),
    );
  }

  /**
   * Debounced write: with a full fleet pushing every few minutes, rewriting
   * the file synchronously on every push would needlessly block the event
   * loop. Writes are batched to at most once per second.
   */
  private persist(): void {
    this.persistPending = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      if (!this.persistPending) return;
      this.persistPending = false;
      void writeFile(this.filePath, JSON.stringify(this.all(), null, 2)).catch((err) => {
        console.error('persisting positions failed:', err);
      });
    }, 1000);
    this.persistTimer.unref();
  }

  /** Writes any pending changes synchronously; call on shutdown. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.persistPending) {
      this.persistPending = false;
      writeFileSync(this.filePath, JSON.stringify(this.all(), null, 2));
    }
  }
}
