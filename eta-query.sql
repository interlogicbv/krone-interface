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
--   origin           optioneel  - laadadres; wordt in de mail getoond
--   customer         optioneel  - klantnaam; bepaalt de ontvangers via de
--                                 CUSTOMER_<n>_MAIL-adressen uit de .env
--   mail_to          optioneel  - expliciete ontvanger; wint van customer,
--                                 valt anders terug op MAIL_TO uit .env
--
-- Elke rij levert één ETA-mail op. Rijen zonder planned_at worden alleen
-- verstuurd op de vaste ETA_CRON-tijd (als die is ingesteld).

SELECT DISTINCT
    V.License                           AS vehicle,
    R.Name                              AS customer,
    CONCAT(
        UA.Address, ', ',
        UA.ZIPcode, ' ', UA.Cityname, ', ',
        UA.CountryCode
    )                                   AS destination,
    UA.Latitude                         AS destination_lat,
    UA.Longitude                        AS destination_lon,
    CONVERT(varchar(10), A.Date, 23) + ' ' + CONVERT(varchar(8), A.TimeTill, 108)
                                        AS planned_at,
    CONCAT(
        LA.Address, ', ',
        LA.ZIPcode, ' ', LA.Cityname, ', ',
        LA.CountryCode
    )                                   AS origin
FROM
    SO_LEG L
    INNER JOIN SO_SalesOrder SO ON L.SalesOrder = SO.SalesOrdernr
    INNER JOIN RM_Relation R ON SO.Customer = R.Relationnr
    INNER JOIN SO_Activity A ON L.EndActivity = A.Activitynr
    INNER JOIN RM_Address UA ON A.Address = UA.Addressnr
    LEFT JOIN SO_Activity BA ON L.BeginActivity = BA.Activitynr
    LEFT JOIN RM_Address LA ON BA.Address = LA.Addressnr
    INNER JOIN RP_ResourceCombination RC ON A.ResourceCombination = RC.ResourceCombinationnr
    INNER JOIN RP_Resource RS ON RC.Trailer = RS.Resourcenr
    INNER JOIN VM_Vehicle V ON RS.Vehicle = V.Vehiclenr
WHERE
    -- @customers wordt automatisch gevuld met de CUSTOMER_<n>_NAME-waarden
    -- uit de .env (als veilige SQL-parameters). Klanten en hun mailadressen
    -- beheer je dus in de .env, niet hier.
    R.Name IN (@customers)
    AND CAST(A.Date AS Date) = CAST(CURRENT_TIMESTAMP AS Date)
