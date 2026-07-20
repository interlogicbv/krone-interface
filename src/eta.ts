import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import { fetchEtaTargets, isDbConfigured, type EtaTarget } from './db.js';
import type { PositionStore } from './store.js';

const USER_AGENT = 'krone-interface (Interlogic trailer tracking)';

/** Within this distance of the destination the trailer counts as arrived. */
const ARRIVED_WITHIN_METERS = 2000;
/** Within this remaining driving time the trailer counts as "almost there". */
const ALMOST_THERE_WITHIN_SECONDS = 60 * 60;

const TEAL = '#00b0bd';
const GREY = '#e0e0e0';

interface Coordinates {
  latitude: number;
  longitude: number;
}

interface Route {
  /** Driving time in seconds. */
  durationSeconds: number;
  /** Distance in meters. */
  distanceMeters: number;
}

const geocodeCache = new Map<string, Coordinates>();

/** Resolves an address to coordinates via Nominatim (cached per address). */
async function geocode(address: string): Promise<Coordinates> {
  const cached = geocodeCache.get(address);
  if (cached) return cached;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Nominatim returned HTTP ${response.status}`);
  const results = (await response.json()) as { lat: string; lon: string }[];
  const first = results[0];
  if (!first) throw new Error(`Address not found: ${address}`);
  const coords = { latitude: Number(first.lat), longitude: Number(first.lon) };
  geocodeCache.set(address, coords);
  return coords;
}

/** Fetches the driving route via the public OSRM server. */
async function fetchRoute(from: Coordinates, to: Coordinates): Promise<Route> {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    code: string;
    routes?: { duration: number; distance: number }[];
  };
  const route = body.routes?.[0];
  if (body.code !== 'Ok' || !route) throw new Error(`OSRM could not find a route (${body.code})`);
  return { durationSeconds: route.duration, distanceMeters: route.distance };
}

/** Straight-line distance in meters (haversine). */
function crowFliesMeters(a: Coordinates, b: Coordinates): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/** "today at 14:30", "tomorrow at 06:45" or "18/07/2026 at 06:45". */
function formatArrival(eta: Date, timezone: string): string {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: timezone });
  const time = eta.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (day(eta) === day(now)) return `today at ${time}`;
  if (day(eta) === day(new Date(now.getTime() + 24 * 60 * 60 * 1000))) return `tomorrow at ${time}`;
  return `${eta.toLocaleDateString('en-GB', { timeZone: timezone })} at ${time}`;
}

function formatTime(date: Date, timezone: string): string {
  return date.toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
}

interface EtaMailContent {
  subject: string;
  text: string;
  html: string;
}

/** Same house-style wrapper as the other Interlogic mails. */
function renderMail(bodyHtml: string): string {
  return `
    <div style="margin:0; padding:0; background-color:#ffffff;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:800px; margin:0 auto; border:1px solid #e0e0e0; border-top:5px solid ${TEAL}; font-family:'Segoe UI', Arial, sans-serif;">
        <tr>
          <td style="padding:15px; background-color:#f8f9fa;">
            <img src="https://www.inter-logic.eu/wp-content/uploads/2023/10/Logo-Interlogic.png" width="120">
          </td>
        </tr>
        ${bodyHtml}
        <tr>
          <td style="padding:12px; background:#f1f1f1; text-align:center; font-size:11px; color:#999;">
            This is an automated message.
          </td>
        </tr>
      </table>
    </div>
  `;
}

/**
 * PostNL/DHL-style progress tracker: On the way → Almost there → Arrived.
 * Built exclusively from table cells with background colors: Outlook renders
 * mails with the Word engine and drops styled <div> elements entirely.
 */
function renderTracker(step: 0 | 1 | 2): string {
  const labels = ['On the way', 'Almost there', 'Arrived'];
  const segment = (index: number) =>
    `<td width="33%" height="10" bgcolor="${index <= step ? TEAL : GREY}" style="height:10px; background-color:${index <= step ? TEAL : GREY}; font-size:1px; line-height:1px;">&nbsp;</td>`;
  const spacer = `<td width="6" style="font-size:1px; line-height:1px;">&nbsp;</td>`;
  const label = (index: number) =>
    `<td width="33%" align="center" style="padding-top:8px; font-size:12px; color:${index <= step ? '#001a2d' : '#999'}; font-weight:${index === step ? 'bold' : 'normal'};">${index < step ? '&#10003; ' : ''}${labels[index]}</td>`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        ${segment(0)}
        ${spacer}
        ${segment(1)}
        ${spacer}
        ${segment(2)}
      </tr>
      <tr>
        ${label(0)}
        <td></td>
        ${label(1)}
        <td></td>
        ${label(2)}
      </tr>
    </table>
  `;
}

export async function buildEtaMail(
  config: Config,
  store: PositionStore,
  target: EtaTarget,
): Promise<EtaMailContent | undefined> {
  const vehicleId = target.vehicle;
  const destinationAddress = target.destinationAddress;
  const tz = config.timezone;
  const destinationShort = destinationAddress.split(',')[0]!.trim();
  const position = store.find(vehicleId);
  if (!position || position.latitude === undefined || position.longitude === undefined) {
    // Trailers without GPS (or without Krone data yet) are simply skipped;
    // the caller decides whether to retry later.
    return undefined;
  }

  const destination =
    target.destinationLat !== undefined && target.destinationLon !== undefined
      ? { latitude: target.destinationLat, longitude: target.destinationLon }
      : await geocode(destinationAddress);

  const current: Coordinates = { latitude: position.latitude, longitude: position.longitude };
  // Arrival is judged by straight-line distance: route distance is unreliable
  // at close range (road snapping around industrial sites can add many km).
  const arrived = crowFliesMeters(current, destination) <= ARRIVED_WITHIN_METERS;
  const route = arrived
    ? { durationSeconds: 0, distanceMeters: 0 }
    : await fetchRoute(current, destination);

  const name = position.assetName ?? position.license ?? position.vehicleKey;
  const eta = new Date(Date.now() + route.durationSeconds * 1000);
  const distanceKm = Math.round(route.distanceMeters / 1000);
  const arrival = formatArrival(eta, tz);
  const routeLink = `https://www.google.com/maps/dir/${position.latitude},${position.longitude}/${destination.latitude},${destination.longitude}`;

  const almostThere = !arrived && route.durationSeconds <= ALMOST_THERE_WITHIN_SECONDS;
  const step: 0 | 1 | 2 = arrived ? 2 : almostThere ? 1 : 0;

  const headline = arrived
    ? `${name} has arrived!`
    : almostThere
      ? `${name} is almost there!`
      : `${name} is on its way`;
  const subject = arrived
    ? `✅ ${name} has arrived at ${destinationShort}`
    : almostThere
      ? `🚚 ${name} is almost there — arrival ${arrival}`
      : `🚚 ${name} is on its way — arrival ${arrival}`;

  const planned = target.plannedAt;
  const minutesLate = planned ? Math.round((eta.getTime() - planned.getTime()) / 60000) : 0;
  const lateNote =
    !arrived && planned && minutesLate > 15
      ? `Currently expected about ${minutesLate} minutes later than the agreed time.`
      : undefined;

  const originRow = target.origin
    ? [['Origin', target.origin] as [string, string]]
    : [];
  const rows: [string, string][] = arrived
    ? [
        ['Trailer', `${name}${position.license && position.license !== name ? ` (${position.license})` : ''}`],
        ...originRow,
        ['Location', position.address ?? `${position.latitude}, ${position.longitude}`],
        ['Destination', destinationAddress],
        ...(planned ? [['Agreed time', formatTime(planned, tz)] as [string, string]] : []),
        ['Position received', formatTime(new Date(position.receivedAt), tz)],
      ]
    : [
        ['Trailer', `${name}${position.license && position.license !== name ? ` (${position.license})` : ''}`],
        ...originRow,
        ['Current location', position.address ?? `${position.latitude}, ${position.longitude}`],
        ['Destination', destinationAddress],
        ...(planned ? [['Agreed time', formatTime(planned, tz)] as [string, string]] : []),
        ['Remaining distance', `${distanceKm} km`],
        ['Remaining driving time', formatDuration(route.durationSeconds)],
        ['Expected arrival', arrival],
        ['Position received', formatTime(new Date(position.receivedAt), tz)],
      ];

  const detailRows = rows
    .map(
      ([label, value], index) => `
      <tr>
        <td width="38%" style="padding:9px 14px; ${index < rows.length - 1 ? 'border-bottom:1px solid #e8ecef;' : ''} font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:#8a94a6; white-space:nowrap; vertical-align:top;">${label}</td>
        <td style="padding:9px 14px; ${index < rows.length - 1 ? 'border-bottom:1px solid #e8ecef;' : ''} font-size:13px; color:#001a2d;">${value}</td>
      </tr>
    `,
    )
    .join('');

  const heroTime = arrived
    ? `<p style="margin:10px 0 0 0; font-size:14px; color:#333;">Your trailer is at</p>
       <p style="margin:2px 0 0 0; font-size:26px; font-weight:bold; color:${TEAL};">${destinationShort}</p>`
    : `<p style="margin:10px 0 0 0; font-size:14px; color:#333;">Expected arrival</p>
       <p style="margin:2px 0 0 0; font-size:26px; font-weight:bold; color:${TEAL};">${arrival}</p>`;

  const bodyHtml = `
        <tr>
          <td style="padding:28px 15px 8px 15px; text-align:center;">
            <p style="margin:0; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:${TEAL}; font-weight:bold;">Trailer update</p>
            <h1 style="margin:6px 0 0 0; font-size:24px; color:#001a2d;">${headline}</h1>
            ${heroTime}
            ${lateNote ? `<p style="margin:12px 0 0 0; font-size:13px; color:#c0392b;"><b>${lateNote}</b></p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:14px 15px 24px 15px;">
            ${renderTracker(step)}
          </td>
        </tr>
        <tr>
          <td style="padding:0 15px 20px 15px;">
            <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f8f9fa" style="border-collapse:collapse; background-color:#f8f9fa;">
              ${detailRows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 15px 22px 15px;" align="center">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="${TEAL}" style="background-color:${TEAL}; border-radius:4px;">
                  <a href="${routeLink}" style="display:inline-block; padding:11px 28px; font-size:13px; font-weight:bold; color:#ffffff; text-decoration:none;">View route in Google Maps</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 15px 18px 15px; text-align:center;">
            <p style="margin:0; color:#999; font-size:11px;">
              Arrival time is an estimate based on the trailer's most recent reported position,<br>
              excluding rest breaks and loading/unloading time.
            </p>
          </td>
        </tr>
  `;

  const text = [
    headline,
    arrived ? `Your trailer is at ${destinationShort}.` : `Expected arrival: ${arrival}.`,
    ...(lateNote ? [lateNote] : []),
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Route: ${routeLink}`,
    '',
    'Arrival time is an estimate based on the most recent reported position, excluding rest breaks and loading/unloading time.',
  ].join('\n');

  return { subject, text, html: renderMail(bodyHtml) };
}

/**
 * Resolves the trailer/destination combinations: from the MSSQL database when
 * configured, otherwise the single ETA_* env fallback.
 */
async function resolveTargets(config: Config): Promise<EtaTarget[]> {
  if (isDbConfigured(config)) return fetchEtaTargets(config);
  if (config.etaVehicle && config.etaDestinationAddress) {
    return [
      {
        vehicle: config.etaVehicle,
        destinationAddress: config.etaDestinationAddress,
        ...(config.etaDestinationLat !== undefined && { destinationLat: config.etaDestinationLat }),
        ...(config.etaDestinationLon !== undefined && { destinationLon: config.etaDestinationLon }),
      },
    ];
  }
  throw new Error(
    'Configure either the MSSQL_* variables or ETA_VEHICLE and ETA_DESTINATION_ADDRESS',
  );
}

export interface SentEtaMail {
  target: EtaTarget;
  subject: string;
  /** Set when no mail was sent, with the reason (e.g. trailer without GPS data). */
  skipped?: string;
  error?: string;
}

/**
 * Builds and sends the ETA mail for a single target. Without SMTP
 * configuration the mail is printed to the console instead (dry-run).
 */
export async function sendOneEtaMail(
  config: Config,
  store: PositionStore,
  target: EtaTarget,
): Promise<SentEtaMail> {
  try {
    const mail = await buildEtaMail(config, store, target);
    if (!mail) {
      return { target, subject: '(skipped)', skipped: 'no known position for this trailer' };
    }
    const to = target.mailTo ?? config.mailTo;
    if (!config.smtpHost || !to) {
      console.log('--- E-mail (dry-run, no SMTP configured) ---');
      console.log(`To: ${to ?? '(MAIL_TO not set)'}`);
      console.log(`Subject: ${mail.subject}`);
      console.log(mail.text);
      console.log('--------------------------------------------');
    } else {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        ...(config.smtpUser && config.smtpPassword
          ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
          : {}),
      });
      await transporter.sendMail({
        from: config.mailFrom ?? config.smtpUser ?? to,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    }
    return { target, subject: mail.subject };
  } catch (err) {
    return {
      target,
      subject: '(failed)',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sends one ETA mail per trailer/destination combination. With
 * `excludePlanned` the trips that carry an agreed time are skipped —
 * those are handled by the EtaPlanner at their own moment.
 */
export async function sendEtaMails(
  config: Config,
  store: PositionStore,
  options: { excludePlanned?: boolean } = {},
): Promise<SentEtaMail[]> {
  let targets = await resolveTargets(config);
  if (options.excludePlanned) targets = targets.filter((t) => t.plannedAt === undefined);

  const results: SentEtaMail[] = [];
  for (const [index, target] of targets.entries()) {
    // Pace requests to the public OSRM/Nominatim servers (~1 req/s policy).
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    results.push(await sendOneEtaMail(config, store, target));
  }
  return results;
}
