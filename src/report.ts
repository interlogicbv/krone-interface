import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { LastPosition, PositionStore } from './store.js';

function formatTime(iso: string | undefined, timezone: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function mapsLink(p: LastPosition): string | undefined {
  if (p.latitude === undefined || p.longitude === undefined) return undefined;
  return `https://www.google.com/maps?q=${p.latitude},${p.longitude}`;
}

function displayName(p: LastPosition): string {
  return p.assetName ?? p.license ?? p.vehicleKey;
}

interface ReportContent {
  subject: string;
  text: string;
  html: string;
}

/** Wraps body rows in the Interlogic house-style mail layout. */
function renderMail(title: string, bodyHtml: string): string {
  return `
    <div style="margin:0; padding:0; background-color:#ffffff;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:800px; margin:0 auto; border:1px solid #e0e0e0; border-top:5px solid #00b0bd; font-family:'Segoe UI', Arial, sans-serif;">

        <!-- HEADER -->
        <tr>
          <td style="padding:15px; background-color:#f8f9fa;">
            <img src="https://www.inter-logic.eu/wp-content/uploads/2023/10/Logo-Interlogic.png" width="120">
            <h1 style="margin:10px 0 0 0; font-size:20px; color:#001a2d;">
              ${title}
            </h1>
          </td>
        </tr>

        ${bodyHtml}

        <!-- FOOTER -->
        <tr>
          <td style="padding:12px; background:#f1f1f1; text-align:center; font-size:11px; color:#999;">
            This is an automated message.
          </td>
        </tr>

      </table>
    </div>
  `;
}

/** Builds the report email for one or more vehicles. */
export function buildReport(config: Config, store: PositionStore): ReportContent {
  const positions =
    config.trackedVehicles.length > 0
      ? config.trackedVehicles
          .map((v) => store.find(v))
          .filter((p): p is LastPosition => p !== undefined)
      : store.all();
  const missing =
    config.trackedVehicles.length > 0
      ? config.trackedVehicles.filter((v) => store.find(v) === undefined)
      : [];
  const tz = config.timezone;
  const now = Date.now();
  const staleMs = config.staleAfterHours * 60 * 60 * 1000;

  if (positions.length === 0) {
    const who =
      config.trackedVehicles.length > 0
        ? `trailer${config.trackedVehicles.length === 1 ? '' : 's'} ${config.trackedVehicles.map((v) => `"${v}"`).join(', ')}`
        : 'any trailer';
    const text = [
      `No location update has been received yet for ${who}.`,
      '',
      'Please check whether the sharing in the KRONE DataCenter is active and the receiver service is running.',
    ].join('\n');
    const html = `
        <!-- INTRO -->
        <tr>
          <td style="padding:15px; font-size:13px; color:#333;">
            <p>No location update has been received yet for <b>${who}</b>.</p>
            <p>Please check whether the sharing in the KRONE DataCenter is active and the receiver service is running.</p>
          </td>
        </tr>
    `;
    return {
      subject: '⚠️ Trailer check: no location data received',
      text,
      html: renderMail('Trailer Position Report', html),
    };
  }

  const isStale = (p: LastPosition) => now - Date.parse(p.receivedAt) > staleMs;
  const staleVehicles = positions.filter(isStale);

  const detailRows = positions
    .map((p) => {
      const stale = isStale(p);
      const link = mapsLink(p);
      const status = p.isMoving ? `Moving (${p.speedKmh ?? '?'} km/h)` : 'Parked';
      const updateCell = stale
        ? `<span style="color:#c0392b; font-weight:bold;">&#9888; ${formatTime(p.receivedAt, tz)}</span>`
        : formatTime(p.receivedAt, tz);
      return `
      <tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">
          ${displayName(p)}${p.license && p.license !== displayName(p) ? `<br><span style="color:#999; font-size:11px;">${p.license}</span>` : ''}
        </td>
        <td style="padding:8px; border-bottom:1px solid #eee;">
          ${updateCell}
        </td>
        <td style="padding:8px; border-bottom:1px solid #eee;">
          ${p.address ?? '-'}
          ${p.latitude !== undefined ? `<br><span style="color:#999; font-size:11px;">${p.latitude}, ${p.longitude}</span>` : ''}
        </td>
        <td style="padding:8px; border-bottom:1px solid #eee;">
          ${status}
        </td>
        <td style="padding:8px; border-bottom:1px solid #eee;">
          ${link ? `<a href="${link}" style="font-weight:bold; color: #00b0bd">View map</a>` : '-'}
        </td>
      </tr>
    `;
    })
    .join('');

  const staleWarning =
    staleVehicles.length > 0
      ? `<p style="color:#c0392b;"><b>Please note:</b> ${staleVehicles
          .map(displayName)
          .join(', ')} ${staleVehicles.length === 1 ? 'has' : 'have'} not sent an update in the last ${config.staleAfterHours} hours.</p>`
      : '';

  const missingWarning =
    missing.length > 0
      ? `<p style="color:#c0392b;"><b>Please note:</b> no location data has been received yet for ${missing.map((v) => `"${v}"`).join(', ')}.</p>`
      : '';

  const bodyHtml = `
        <!-- INTRO -->
        <tr>
          <td style="padding:15px; font-size:13px; color:#333;">
            <p>Please find below the most recent known position${positions.length === 1 ? '' : 's'} of your trailer${positions.length === 1 ? '' : 's'}, as received from KRONE Telematics.</p>
            ${staleWarning}
            ${missingWarning}
          </td>
        </tr>

        <!-- DETAILS TABLE -->
        <tr>
          <td style="padding:15px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px;">
              <tr>
                <th style="text-align:left; padding:8px; border-bottom:2px solid #ddd;">Trailer</th>
                <th style="text-align:left; padding:8px; border-bottom:2px solid #ddd;">Last update</th>
                <th style="text-align:left; padding:8px; border-bottom:2px solid #ddd;">Location</th>
                <th style="text-align:left; padding:8px; border-bottom:2px solid #ddd;">Status</th>
                <th style="text-align:left; padding:8px; border-bottom:2px solid #ddd;">Map</th>
              </tr>

              ${detailRows}

            </table>
          </td>
        </tr>
  `;

  const textBlocks = positions.map((p) => {
    const link = mapsLink(p);
    return [
      `Trailer: ${displayName(p)}${p.license && p.license !== displayName(p) ? ` (${p.license})` : ''}`,
      `Last update: ${formatTime(p.receivedAt, tz)}${isStale(p) ? ` — WARNING: more than ${config.staleAfterHours} hours ago!` : ''}`,
      `GPS time: ${formatTime(p.gpsTime, tz)}`,
      `Location: ${p.address ?? '-'}`,
      `Coordinates: ${p.latitude ?? '?'}, ${p.longitude ?? '?'}`,
      `Status: ${p.isMoving ? `moving (${p.speedKmh ?? '?'} km/h)` : 'parked'}`,
      `Updates received: ${p.pushCount}`,
      ...(link ? [`Map: ${link}`] : []),
    ].join('\n');
  });

  const first = positions[0]!;
  const attention = [...staleVehicles.map(displayName), ...missing];
  const subject =
    attention.length > 0
      ? `⚠️ Trailer check: no recent update from ${attention.join(', ')}`
      : positions.length === 1
        ? `Trailer check ${displayName(first)}: ${first.address ?? 'position received'}`
        : `Trailer check: last positions of ${positions.length} trailers`;

  if (missing.length > 0) {
    textBlocks.push(
      `WARNING: no location data has been received yet for ${missing.map((v) => `"${v}"`).join(', ')}.`,
    );
  }

  return {
    subject,
    text: textBlocks.join('\n\n---\n\n'),
    html: renderMail('Trailer Position Report', bodyHtml),
  };
}

/**
 * Sends the report by email. Without SMTP configuration the email is printed
 * to the console instead (dry-run), so the flow can be tested end-to-end.
 */
export async function sendReport(config: Config, store: PositionStore): Promise<ReportContent> {
  const report = buildReport(config, store);

  if (!config.smtpHost || !config.mailTo) {
    console.log('--- E-mail (dry-run, no SMTP configured) ---');
    console.log(`To: ${config.mailTo ?? '(MAIL_TO not set)'}`);
    console.log(`Subject: ${report.subject}`);
    console.log(report.text);
    console.log('--------------------------------------------');
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
