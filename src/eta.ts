import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { LastPosition, PositionStore } from './store.js';

const USER_AGENT = 'krone-interface (Interlogic trailer tracking)';

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

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function formatTime(date: Date, timezone: string): string {
  return date.toLocaleString('en-GB', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
}

interface EtaMailContent {
  subject: string;
  text: string;
  html: string;
}

/** Same house-style wrapper as the position report. */
function renderMail(title: string, bodyHtml: string): string {
  return `
    <div style="margin:0; padding:0; background-color:#ffffff;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:800px; margin:0 auto; border:1px solid #e0e0e0; border-top:5px solid #00b0bd; font-family:'Segoe UI', Arial, sans-serif;">
        <tr>
          <td style="padding:15px; background-color:#f8f9fa;">
            <img src="https://www.inter-logic.eu/wp-content/uploads/2023/10/Logo-Interlogic.png" width="120">
            <h1 style="margin:10px 0 0 0; font-size:20px; color:#001a2d;">
              ${title}
            </h1>
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

export async function buildEtaMail(config: Config, store: PositionStore): Promise<EtaMailContent> {
  const vehicleId = config.etaVehicle;
  const destinationAddress = config.etaDestinationAddress;
  if (!vehicleId || !destinationAddress) {
    throw new Error('ETA_VEHICLE and ETA_DESTINATION_ADDRESS must be configured');
  }
  const tz = config.timezone;
  const position = store.find(vehicleId);

  if (!position || position.latitude === undefined || position.longitude === undefined) {
    const text = `No known position for trailer "${vehicleId}", so no ETA to ${destinationAddress} could be calculated.`;
    return {
      subject: `⚠️ ETA ${vehicleId}: no known position`,
      text,
      html: renderMail('Trailer ETA Report', `
        <tr>
          <td style="padding:15px; font-size:13px; color:#333;">
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

  const route = await fetchRoute(
    { latitude: position.latitude, longitude: position.longitude },
    destination,
  );

  const name = position.assetName ?? position.license ?? position.vehicleKey;
  const eta = new Date(Date.now() + route.durationSeconds * 1000);
  const distanceKm = Math.round(route.distanceMeters / 1000);
  const drivingTime = formatDuration(route.durationSeconds);
  const routeLink = `https://www.google.com/maps/dir/${position.latitude},${position.longitude}/${destination.latitude},${destination.longitude}`;

  const rows: [string, string][] = [
    ['Trailer', `${name}${position.license && position.license !== name ? ` (${position.license})` : ''}`],
    ['Current location', `${position.address ?? `${position.latitude}, ${position.longitude}`}`],
    ['Position received', formatTime(new Date(position.receivedAt), tz)],
    ['Destination', destinationAddress],
    ['Remaining distance', `${distanceKm} km`],
    ['Driving time', drivingTime],
    ['Estimated arrival', `${formatTime(eta, tz)}`],
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
          <td style="padding:15px; font-size:13px; color:#333;">
            <p>Estimated time of arrival for trailer <b>${name}</b>, based on its most recent known position.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:15px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px;">
              ${detailRows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:15px; font-size:13px; color:#333;">
            <p>
              <a href="${routeLink}" style="font-weight:bold; color: #00b0bd">View route in Google Maps</a>
            </p>
            <p style="color:#999; font-size:11px;">
              Driving time is an estimate (standard driving profile), excluding rest breaks and loading/unloading time.
            </p>
          </td>
        </tr>
  `;

  const text = [
    `Estimated time of arrival for trailer ${name}:`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Route: ${routeLink}`,
    '',
    'Driving time is an estimate (standard driving profile), excluding rest breaks and loading/unloading time.',
  ].join('\n');

  return {
    subject: `ETA ${name}: ${formatTime(eta, tz)} at ${destinationAddress.split(',')[0]}`,
    text,
    html: renderMail('Trailer ETA Report', bodyHtml),
  };
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
