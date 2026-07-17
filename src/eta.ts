import nodemailer from 'nodemailer';
import type { Config } from './config.js';
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

let geocodeCache: { address: string; coords: Coordinates } | undefined;

/** Resolves an address to coordinates via Nominatim (cached per address). */
async function geocode(address: string): Promise<Coordinates> {
  if (geocodeCache?.address === address) return geocodeCache.coords;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Nominatim returned HTTP ${response.status}`);
  const results = (await response.json()) as { lat: string; lon: string }[];
  const first = results[0];
  if (!first) throw new Error(`Address not found: ${address}`);
  const coords = { latitude: Number(first.lat), longitude: Number(first.lon) };
  geocodeCache = { address, coords };
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

/** PostNL/DHL-style progress tracker: On the way → Almost there → Arrived. */
function renderTracker(step: 0 | 1 | 2): string {
  const labels = ['On the way', 'Almost there', 'Arrived'];
  const dot = (reached: boolean, current: boolean) =>
    `<td align="center" width="20" style="padding:0;">
      <div style="width:${current ? 20 : 14}px; height:${current ? 20 : 14}px; border-radius:50%; background-color:${reached ? TEAL : GREY}; ${current ? `border:3px solid #b3e6ea;` : ''}"></div>
    </td>`;
  const bar = (reached: boolean) =>
    `<td style="padding:0;"><div style="height:4px; background-color:${reached ? TEAL : GREY};"></div></td>`;
  const label = (index: number) =>
    `<td align="center" width="33%" style="padding-top:6px; font-size:12px; color:${index <= step ? '#001a2d' : '#999'}; font-weight:${index === step ? 'bold' : 'normal'};">${labels[index]}</td>`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:5px 0 0 0;">
      <tr>
        <td width="16%"></td>
        ${dot(true, step === 0)}
        ${bar(step >= 1)}
        ${dot(step >= 1, step === 1)}
        ${bar(step >= 2)}
        ${dot(step >= 2, step === 2)}
        <td width="16%"></td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${label(0)}
        ${label(1)}
        ${label(2)}
      </tr>
    </table>
  `;
}

export async function buildEtaMail(config: Config, store: PositionStore): Promise<EtaMailContent> {
  const vehicleId = config.etaVehicle;
  const destinationAddress = config.etaDestinationAddress;
  if (!vehicleId || !destinationAddress) {
    throw new Error('ETA_VEHICLE and ETA_DESTINATION_ADDRESS must be configured');
  }
  const tz = config.timezone;
  const destinationShort = destinationAddress.split(',')[0]!.trim();
  const position = store.find(vehicleId);

  if (!position || position.latitude === undefined || position.longitude === undefined) {
    const text = `No known position for trailer "${vehicleId}", so no ETA to ${destinationAddress} could be calculated.`;
    return {
      subject: `⚠️ ${vehicleId}: no known position`,
      text,
      html: renderMail(`
        <tr>
          <td style="padding:15px; font-size:13px; color:#333;">
            <h1 style="margin:0 0 10px 0; font-size:20px; color:#001a2d;">No position available</h1>
            <p style="color:#c0392b;">${text}</p>
          </td>
        </tr>
      `),
    };
  }

  const destination =
    config.etaDestinationLat !== undefined && config.etaDestinationLon !== undefined
      ? { latitude: config.etaDestinationLat, longitude: config.etaDestinationLon }
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
  const subline = arrived
    ? `Your trailer is at ${destinationShort}.`
    : `Expected arrival: <b>${arrival}</b>.`;
  const subject = arrived
    ? `✅ ${name} has arrived at ${destinationShort}`
    : almostThere
      ? `🚚 ${name} is almost there — arrival ${arrival}`
      : `🚚 ${name} is on its way — arrival ${arrival}`;

  const rows: [string, string][] = arrived
    ? [
        ['Trailer', `${name}${position.license && position.license !== name ? ` (${position.license})` : ''}`],
        ['Location', position.address ?? `${position.latitude}, ${position.longitude}`],
        ['Destination', destinationAddress],
        ['Position received', formatTime(new Date(position.receivedAt), tz)],
      ]
    : [
        ['Trailer', `${name}${position.license && position.license !== name ? ` (${position.license})` : ''}`],
        ['Current location', position.address ?? `${position.latitude}, ${position.longitude}`],
        ['Destination', destinationAddress],
        ['Remaining distance', `${distanceKm} km`],
        ['Remaining driving time', formatDuration(route.durationSeconds)],
        ['Expected arrival', arrival],
        ['Position received', formatTime(new Date(position.receivedAt), tz)],
      ];

  const detailRows = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:8px; border-bottom:1px solid #eee; white-space:nowrap;"><b>${label}</b></td>
        <td style="padding:8px; border-bottom:1px solid #eee;">${value}</td>
      </tr>
    `,
    )
    .join('');

  const bodyHtml = `
        <tr>
          <td style="padding:20px 15px 5px 15px; text-align:center;">
            <h1 style="margin:0; font-size:24px; color:#001a2d;">${headline}</h1>
            <p style="margin:8px 0 0 0; font-size:14px; color:#333;">${subline}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 15px 20px 15px;">
            ${renderTracker(step)}
          </td>
        </tr>
        <tr>
          <td style="padding:0 15px 15px 15px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px;">
              ${detailRows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 15px 15px 15px; font-size:13px; color:#333;">
            <p>
              <a href="${routeLink}" style="font-weight:bold; color: ${TEAL}">View route in Google Maps</a>
            </p>
            <p style="color:#999; font-size:11px;">
              Arrival time is an estimate based on the trailer's most recent reported position,
              excluding rest breaks and loading/unloading time.
            </p>
          </td>
        </tr>
  `;

  const text = [
    headline,
    arrived ? `Your trailer is at ${destinationShort}.` : `Expected arrival: ${arrival}.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Route: ${routeLink}`,
    '',
    'Arrival time is an estimate based on the most recent reported position, excluding rest breaks and loading/unloading time.',
  ].join('\n');

  return { subject, text, html: renderMail(bodyHtml) };
}

/** Sends the ETA mail; without SMTP configuration it is printed to the console (dry-run). */
export async function sendEtaMail(config: Config, store: PositionStore): Promise<EtaMailContent> {
  const mail = await buildEtaMail(config, store);

  if (!config.smtpHost || !config.mailTo) {
    console.log('--- E-mail (dry-run, no SMTP configured) ---');
    console.log(`To: ${config.mailTo ?? '(MAIL_TO not set)'}`);
    console.log(`Subject: ${mail.subject}`);
    console.log(mail.text);
    console.log('--------------------------------------------');
    return mail;
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    ...(config.smtpUser && config.smtpPassword
      ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
      : {}),
  });

  await transporter.sendMail({
    from: config.mailFrom ?? config.smtpUser ?? config.mailTo,
    to: config.mailTo,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });

  return mail;
}
