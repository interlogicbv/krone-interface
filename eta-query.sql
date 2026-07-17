-- ETA-targets: welke trailers naar welke bestemming onderweg zijn.
--
-- Contract (kolomnamen zijn hoofdletterongevoelig):
--   vehicle          verplicht  - kenteken, VH_ID, asset-naam of box-ID van de trailer
--   destination      verplicht  - bestemmingsadres (wordt gegeocodeerd via Nominatim)
--   destination_lat  optioneel  - vaste latitude van de bestemming (slaat geocoding over)
--   destination_lon  optioneel  - vaste longitude van de bestemming
--   mail_to          optioneel  - afwijkende ontvanger; anders MAIL_TO uit .env
--
-- Elke rij levert één ETA-mail op. Pas deze query aan op het eigen datamodel;
-- dit is een placeholder die de vaste trailer/bestemming van de pilot teruggeeft.

SELECT
    'OT-84-LL'                                  AS vehicle,
    'Siemensstraße 1, 96129 Strullendorf, DE'   AS destination,
    49.8450569                                  AS destination_lat,
    10.9540135                                  AS destination_lon;
