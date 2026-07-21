# krone-interface

Webhook-ontvanger voor de **KRONE Telematics Push Default Service**: ontvangt de geo-locaties (en overige boxdata) van Krone-trailers en logt deze.

Krone werkt met een *push*-model: je registreert in het Krone DataCenter een provider met de URL van dit programma, en Krone POST't vervolgens JSON-berichten naar dat endpoint. Dit programma implementeert het verwachte request/response-contract (Push Default Service v1.8.1).

## Snel starten

```bash
npm install
npm run dev          # development met auto-reload (poort 3000)
```

Test met het meegeleverde voorbeeld-payload:

```bash
curl -X POST http://localhost:3000/krone/push \
  -H 'Content-Type: application/json' \
  -d @sample/example-request.json
```

Productie:

```bash
npm run build
npm start
```

## Configuratie (omgevingsvariabelen)

| Variabele | Default | Omschrijving |
|---|---|---|
| `PORT` | `3000` | Poort waarop de server luistert |
| `HOST` | `0.0.0.0` | Bind-adres |
| `WEBHOOK_PATH` | `/krone/push` | Pad waarop Krone-pushes binnenkomen |
| `BASIC_AUTH_USER` | *(uit)* | Basic Auth gebruikersnaam; samen met wachtwoord activeert dit authenticatie |
| `BASIC_AUTH_PASSWORD` | *(uit)* | Verwacht wachtwoord. Krone stuurt het in het portaal geconfigureerde wachtwoord als SHA-256-hash; zowel de ruwe waarde als de hash worden geaccepteerd |
| `ENFORCE_IP_ALLOWLIST` | `false` | Bij `true` worden alleen requests van de officiële Krone push-IP's (`85.236.61.180`, `85.236.61.181`) geaccepteerd |
| `TRUST_PROXY` | `false` | Alleen op `true` bij een reverse proxy ervoor (client-IP uit `X-Forwarded-For`). Bij directe exposure uit laten, anders is de IP-allowlist te spoofen |
| `TIMEZONE` | `Europe/Amsterdam` | Tijdzone voor het schema en de tijden in de mail |
| `CUSTOMER_<n>_NAME` / `CUSTOMER_<n>_MAIL` | *(uit)* | Per klant: TMS-naam en ontvangers (kommagescheiden). Vult de `@customers`-placeholder in de query en bepaalt per rit de geadresseerden |
| `MSSQL_SERVER` … `MSSQL_PASSWORD` | *(uit)* | MSSQL-database voor dynamische trailer/bestemming-combinaties |
| `ETA_QUERY_FILE` | `eta-query.sql` | SQL-bestand dat de ETA-targets selecteert (kolommen: `vehicle`, `destination`, optioneel `destination_lat`/`destination_lon`/`mail_to`) |
| `ETA_VEHICLE` | *(uit)* | Fallback-trailer als er geen database is geconfigureerd |
| `ETA_DESTINATION_ADDRESS` | *(uit)* | Fallback-bestemmingsadres |
| `ETA_DESTINATION_LAT` / `ETA_DESTINATION_LON` | *(uit)* | Optionele vaste bestemmings-coördinaten (slaat geocoding over) |
| `LATE_THRESHOLD_MINUTES` | `15` | Een zending geldt als vertraagd als de verwachte aankomst zoveel minuten ná de afgesproken tijd ligt |
| `LATE_STEP_MINUTES` | `30` | Na de eerste vertragingsmail volgt pas een nieuwe mail als de vertraging met minstens dit oploopt |
| `ETA_CRON` | *(uit)* | Cron-expressie (5 velden!) voor ritten zónder afgesproken tijd, bijv. `0 6 * * 1-5` = werkdagen 06:00 |
| `SMTP_HOST` … `SMTP_PASSWORD` | *(uit)* | SMTP-server voor het versturen; zonder `SMTP_HOST` wordt het rapport naar de console geprint (dry-run) |
| `MAIL_FROM` / `MAIL_TO` | *(uit)* | Afzender en ontvanger van het rapport |
| `DATA_DIR` | `data` | Map voor de opslag van laatst bekende posities |

## Contract met Krone

- **Succes**: HTTP `201` met body `{ "id": "<uuid uit request>", "received": "<ISO 8601>", "status": "OK" }`
- **Fout**: HTTP `400` met body `{ "id", "received", "status": "ERROR", "error": { "code", "message" } }`
- Zonder geldig antwoord bewaart Krone de data 3 dagen in een queue; daarna stopt de service met sturen. Zorg dus dat het endpoint publiek bereikbaar is en de Krone-IP's niet door een firewall worden geblokkeerd.

## Structuur

- [src/index.ts](src/index.ts) — entrypoint, start de server
- [src/server.ts](src/server.ts) — Fastify-server met het webhook-endpoint, auth en logging
- [src/config.ts](src/config.ts) — configuratie via env-variabelen
- [src/types/krone.ts](src/types/krone.ts) — TypeScript-types van het Krone-payload (Swagger v1.8.1 + Boxdata Fields v1.8.1)
- [sample/example-request.json](sample/example-request.json) — voorbeeld-push zoals Krone die stuurt

## Draaien als service (Ubuntu/systemd)

Zie [deploy/krone-interface.service](deploy/krone-interface.service). Pas daarin `User` en `WorkingDirectory` aan naar jouw situatie en installeer:

```bash
sudo cp deploy/krone-interface.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krone-interface
journalctl -u krone-interface -f   # live meekijken met de logs
```

De service start automatisch bij boot en herstart bij een crash. Na een `git pull`: `npm ci && npm run build && sudo systemctl restart krone-interface`.

## Endpoints

- `POST /krone/push` — ontvangt Krone-pushes; logt per push een samenvatting (voertuig, lat/lon, adres, snelheid, richting, GPS-tijd) en slaat de laatste positie per trailer op
- `GET /positions` — laatst bekende positie per trailer (JSON)
- `GET /health` — healthcheck

## ETA-mail

De trailer/bestemming-combinaties komen uit de MSSQL-database via de query in `ETA_QUERY_FILE` (of anders de vaste `ETA_VEHICLE`/`ETA_DESTINATION_ADDRESS` uit de `.env`). De planner monitort elke rit mét afgesproken tijd (`planned_at`) en **mailt de klant alleen wanneer een zending te laat dreigt te komen**:

- Elke 5 minuten wordt per rit de rijtijd van de laatst bekende positie naar de bestemming berekend (routering via OSRM, geocoding via Nominatim) en vergeleken met de afgesproken tijd.
- Ligt de verwachte aankomst meer dan `LATE_THRESHOLD_MINUTES` (standaard 15) ná de afgesproken tijd, dan gaat er een **vertragingsmail** uit.
- Loopt de vertraging daarna verder op, dan volgt pas een **nieuwe mail** als die met minstens `LATE_STEP_MINUTES` (standaard 30) toeneemt — zo krijgt de klant updates bij materiële verslechtering zonder spam.
- Zodra een vertraagde zending is aangekomen, gaat er een **afsluitende aankomstmail** uit. Zendingen die op tijd zijn, krijgen nooit een mail.

De per-rit-status wordt bewaard in `DATA_DIR`, dus een herstart veroorzaakt nooit dubbele mails. Ritten zónder afgesproken tijd gaan (indien ingesteld) mee op het vaste `ETA_CRON`-tijdstip. De statusbalk in de mail kent drie stappen:

- **On the way** — onderweg, met resterende afstand, rijtijd en verwachte aankomsttijd
- **Almost there** — minder dan een uur rijden van de bestemming
- **Arrived** — binnen 2 km van de bestemming

Handmatig versturen:

```bash
npm run eta
```

Zonder SMTP-configuratie wordt de mail naar de console geprint in plaats van verstuurd. De rijtijd is indicatief (standaard rijprofiel, exclusief rusttijden en laden/lossen).
