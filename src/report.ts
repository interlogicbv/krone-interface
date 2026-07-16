import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { LastPosition, PositionStore } from './store.js';

function formatTime(iso: string | undefined, timezone: string): string {
  if (!iso) return 'onbekend';
  return new Date(iso).toLocaleString('nl-NL', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' });
}

function mapsLink(p: LastPosition): string | undefined {
  if (p.latitude === undefined || p.longitude === undefined) return undefined;
  return `https://www.google.com/maps?q=${p.latitude},${p.longitude}`;
}

interface ReportContent {
  subject: string;
  text: string;
  html: string;
}

/** Builds the report email for one or more vehicles. */
export function buildReport(config: Config, store: PositionStore): ReportContent {
  const positions = config.trackedVehicle
    ? [store.find(config.trackedVehicle)].filter((p): p is LastPosition => p !== undefined)
    : store.all();
  const tz = config.timezone;
  const now = Date.now();
  const staleMs = config.staleAfterHours * 60 * 60 * 1000;

  if (positions.length === 0) {
    const who = config.trackedVehicle ? `trailer "${config.trackedVehicle}"` : 'nog geen enkele trailer';
    const text = `Er is nog geen locatie-update ontvangen voor ${who}.\n\nControleer of de sharing in het Krone DataCenter actief is en of de service draait.`;
    return {
      subject: `⚠️ Trailer-check: nog geen locatiedata ontvangen`,
      text,
      html: `<p>${text.replaceAll('\n', '<br>')}</p>`,
    };
  }

  const staleVehicles = positions.filter((p) => now - Date.parse(p.receivedAt) > staleMs);
  const textBlocks: string[] = [];
  const htmlBlocks: string[] = [];

  for (const p of positions) {
    const name = p.assetName ?? p.license ?? p.vehicleKey;
    const isStale = now - Date.parse(p.receivedAt) > staleMs;
    const link = mapsLink(p);
    const lines = [
      `Trailer: ${name}${p.license && p.license !== name ? ` (${p.license})` : ''}`,
      `Laatste update ontvangen: ${formatTime(p.receivedAt, tz)}${isStale ? ` — LET OP: langer dan ${config.staleAfterHours} uur geleden!` : ''}`,
      `GPS-tijd: ${formatTime(p.gpsTime, tz)}`,
      `Locatie: ${p.address ?? 'onbekend'}`,
      `Coördinaten: ${p.latitude ?? '?'}, ${p.longitude ?? '?'}`,
      `Status: ${p.isMoving ? `rijdend (${p.speedKmh ?? '?'} km/u)` : 'stilstaand'}`,
      `Aantal ontvangen updates: ${p.pushCount}`,
      ...(link ? [`Kaart: ${link}`] : []),
    ];
    textBlocks.push(lines.join('\n'));
    htmlBlocks.push(
      `<h3 style="margin-bottom:4px">${name}</h3><table cellpadding="2">` +
        `<tr><td><b>Laatste update</b></td><td>${formatTime(p.receivedAt, tz)}${isStale ? ' ⚠️' : ''}</td></tr>` +
        `<tr><td><b>GPS-tijd</b></td><td>${formatTime(p.gpsTime, tz)}</td></tr>` +
        `<tr><td><b>Locatie</b></td><td>${p.address ?? 'onbekend'}</td></tr>` +
        `<tr><td><b>Coördinaten</b></td><td>${p.latitude ?? '?'}, ${p.longitude ?? '?'}</td></tr>` +
        `<tr><td><b>Status</b></td><td>${p.isMoving ? `rijdend (${p.speedKmh ?? '?'} km/u)` : 'stilstaand'}</td></tr>` +
        `<tr><td><b>Updates</b></td><td>${p.pushCount}</td></tr>` +
        (link ? `<tr><td><b>Kaart</b></td><td><a href="${link}">Open in Google Maps</a></td></tr>` : '') +
        `</table>`,
    );
  }

  const first = positions[0]!;
  const firstName = first.assetName ?? first.license ?? first.vehicleKey;
  const subject =
    staleVehicles.length > 0
      ? `⚠️ Trailer-check: geen recente update van ${staleVehicles.map((p) => p.assetName ?? p.license ?? p.vehicleKey).join(', ')}`
      : positions.length === 1
        ? `Trailer-check ${firstName}: ${first.address ?? 'positie ontvangen'}`
        : `Trailer-check: ${positions.length} trailers, laatste posities`;

  return {
    subject,
    text: textBlocks.join('\n\n---\n\n'),
    html: htmlBlocks.join('<hr>'),
  };
}

/**
 * Sends the report by email. Without SMTP configuration the email is printed
 * to the console instead (dry-run), so the flow can be tested end-to-end.
 */
export async function sendReport(config: Config, store: PositionStore): Promise<ReportContent> {
  const report = buildReport(config, store);

  if (!config.smtpHost || !config.mailTo) {
    console.log('--- E-mail (dry-run, geen SMTP geconfigureerd) ---');
    console.log(`Aan: ${config.mailTo ?? '(MAIL_TO niet gezet)'}`);
    console.log(`Onderwerp: ${report.subject}`);
    console.log(report.text);
    console.log('--------------------------------------------------');
    return report;
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
    subject: report.subject,
    text: report.text,
    html: report.html,
  });

  return report;
}
