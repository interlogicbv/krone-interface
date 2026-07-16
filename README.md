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
| `TRACKED_VEHICLE` | *(alle)* | Trailer voor het rapport (kenteken, VH_ID, asset-naam of box-ID) |
| `REPORT_CRON` | *(uit)* | Cron-expressie voor het dagelijkse rapport, bijv. `0 7 * * *` = elke dag 07:00 |
| `TIMEZONE` | `Europe/Amsterdam` | Tijdzone voor het schema en de tijden in de mail |
| `STALE_AFTER_HOURS` | `24` | Na zoveel uur zonder update wordt de trailer met een ⚠️ gemeld |
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

## Dagelijks e-mailrapport

De server stuurt op het tijdstip uit `REPORT_CRON` een e-mail naar `MAIL_TO` met de laatst bekende positie van de gevolgde trailer (`TRACKED_VEHICLE`, of alle trailers als die leeg is), inclusief Google Maps-link. Is de laatste update ouder dan `STALE_AFTER_HOURS` uur, dan krijgt de mail een ⚠️-waarschuwing in het onderwerp. Handmatig testen kan altijd met:

```bash
npm run report
```

Zonder SMTP-configuratie wordt de mail naar de console geprint in plaats van verstuurd (handig om de inhoud te controleren).
