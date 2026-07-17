-- ETA-targets: welke trailers vandaag naar welke loslocatie onderweg zijn.
--
-- Contract (kolomnamen zijn hoofdletterongevoelig):
--   vehicle          verplicht  - kenteken van de trailer (streepjes/spaties maken
--                                 niet uit; matching met Krone is genormaliseerd)
--   destination      verplicht  - bestemmingsadres (gegeocodeerd als er geen
--                                 coordinaten zijn meegegeven)
--   destination_lat  optioneel  - vaste latitude van de bestemming
--   destination_lon  optioneel  - vaste longitude van de bestemming
--   mail_to          optioneel  - afwijkende ontvanger; anders MAIL_TO uit .env
--
-- Elke rij levert één ETA-mail op.

SELECT DISTINCT
    V.License                           AS vehicle,
    CONCAT(
        UA.Address, ', ',
        UA.ZIPcode, ' ', UA.Cityname, ', ',
        UA.CountryCode
    )                                   AS destination,
    UA.Latitude                         AS destination_lat,
    UA.Longitude                        AS destination_lon
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
    R.Name = 'Kramp Groep B.V.'
    AND CAST(A.Date AS Date) = CAST(CURRENT_TIMESTAMP AS Date)
