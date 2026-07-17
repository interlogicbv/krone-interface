-- ETA-targets: welke trailers vandaag naar welke loslocatie onderweg zijn.
--
-- Contract (kolomnamen zijn hoofdletterongevoelig):
--   vehicle          verplicht  - kenteken van de trailer (streepjes/spaties maken
--                                 niet uit; matching met Krone is genormaliseerd)
--   destination      verplicht  - bestemmingsadres (gegeocodeerd als er geen
--                                 coordinaten zijn meegegeven)
--   destination_lat  optioneel  - vaste latitude van de bestemming
--   destination_lon  optioneel  - vaste longitude van de bestemming
--   planned_at       optioneel  - afgesproken (los)tijd als 'YYYY-MM-DD HH:mm:ss'
--                                 in TIMEZONE; de mail wordt ETA_LEAD_MINUTES
--                                 (standaard 60) minuten hiervoor verstuurd
--   mail_to          optioneel  - afwijkende ontvanger; anders MAIL_TO uit .env
--
-- Elke rij levert één ETA-mail op. Rijen zonder planned_at worden alleen
-- verstuurd op de vaste ETA_CRON-tijd (als die is ingesteld).

SELECT DISTINCT
    V.License                           AS vehicle,
    CONCAT(
        UA.Address, ', ',
        UA.ZIPcode, ' ', UA.Cityname, ', ',
        UA.CountryCode
    )                                   AS destination,
    UA.Latitude                         AS destination_lat,
    UA.Longitude                        AS destination_lon,
    CONVERT(varchar(10), A.Date, 23) + ' ' + CONVERT(varchar(8), A.TimeTill, 108)
                                        AS planned_at
FROM
    SO_LEG L
    INNER JOIN SO_SalesOrder SO ON L.SalesOrder = SO.SalesOrdernr
    INNER JOIN RM_Relation R ON SO.Customer = R.Relationnr
    INNER JOIN SO_Activity A ON L.EndActivity = A.Activitynr
    INNER JOIN RM_Address UA ON A.Address = UA.Addressnr
    INNER JOIN RP_ResourceCombination RC ON A.ResourceCombination = RC.ResourceCombinationnr
    INNER JOIN RP_Resource RS ON RC.Trailer = RS.Resourcenr
    INNER JOIN VM_Vehicle V ON RS.Vehicle = V.Vehiclenr
WHERE
    -- Klant toevoegen? Zet de naam erbij in deze lijst. Het bestand wordt
    -- elke 5 minuten opnieuw ingelezen; een herstart is niet nodig.
    R.Name IN (
        'Kramp Groep B.V.'
        -- , 'Volgende Klant B.V.'
    )
    AND CAST(A.Date AS Date) = CAST(CURRENT_TIMESTAMP AS Date)

-- Tip: wil je per klant een andere ontvanger, voeg dan in de SELECT een
-- mail_to-kolom toe, bijvoorbeeld:
--   CASE R.Name
--       WHEN 'Kramp Groep B.V.' THEN 'planning@kramp.com'
--       ELSE NULL  -- NULL = standaard MAIL_TO uit .env
--   END AS mail_to
