/**
 * Types for the KRONE Telematics "Push Default Service" (v1.8.1).
 *
 * Based on the official Swagger spec
 * (https://www.krone-trailer.com/swagger-ui/push_external_default_service_customer.json)
 * and the "Boxdata Fields" documentation v1.8.1 (Datineo GmbH).
 *
 * The boxdata object can contain many more fields than the ones typed here;
 * only the groups relevant for geo-location tracking are fully typed. Unknown
 * fields are preserved via index signatures.
 */

/** GPS group — the core geo-location data of a trailer box. */
export interface KroneGps {
  /** Latitude of the box position. Positive is north. */
  BD_GPS_LATITUDE?: number;
  /** Longitude of the box position. Positive is east. */
  BD_GPS_LONGITUDE?: number;
  /** Reverse-geocoded address as a single string, e.g. "Auf d. Imlage 7, 32351 Stemwede, DE". */
  BD_GPS_LOCATION?: string;
  /** UNIX timestamp (ms) of the GPS fix. */
  BD_GPS_TIME?: number;
  /** Speed in km/h. */
  BD_GPS_SPEED?: number;
  /** Direction of travel in degrees (0-359). */
  BD_GPS_DIRECTION?: number;
  /** Compass heading; may differ from BD_GPS_DIRECTION (e.g. trailer on a ferry). */
  BD_GPS_HEADING?: number;
  /** Height above sea level in meters. */
  BD_GPS_HEIGHT?: number;
  /** Number of GPS satellites in view. */
  BD_GPS_SATELLITES?: number;
  /** ISO country code derived from the GPS position. */
  BD_GPS_COUNTRY_CODE?: string;
  [field: string]: unknown;
}

/** Detailed (reverse-geocoded) location group. */
export interface KroneDetailedLocation {
  BD_DETAILED_LOCATION_ISO_COUNTRY_CODE?: string;
  BD_DETAILED_LOCATION_COUNTRY?: string;
  BD_DETAILED_LOCATION_POSTAL_CODE?: string;
  BD_DETAILED_LOCATION_CITY?: string;
  BD_DETAILED_LOCATION_STREET?: string;
  BD_DETAILED_LOCATION_STREET_NUMBER?: string;
  [field: string]: unknown;
}

/** Vehicle identification group. */
export interface KroneVehicle {
  /** Krone-internal vehicle ID, e.g. "HD305081". */
  VH_ID?: string;
  /** Chassis / VIN number, e.g. "WKESD000001040923". */
  VH_CHASSIS?: string;
  /** License plate. */
  VH_LICENSE?: string;
  VH_INTERNAL_NUMBER?: string;
  /** Asset name as configured in the Krone portal. */
  VH_ASSET_NAME?: string;
  [field: string]: unknown;
}

/**
 * The boxdata object. Besides the groups typed below, Krone can send many
 * more groups (ebs, reefer, tpms, door, batteryPack, ...) depending on the
 * sharing configuration — they are kept as unknown.
 */
export interface KroneBoxdata {
  /** ID of the telematics box that produced this record. */
  BD_BOX_ID?: string;
  /** UNIX timestamp (ms) at which the box data was received by Krone. */
  BD_TIME_RECEIVED?: number;
  BD_DATA_TYPE?: number;
  BD_IS_MOVING?: boolean;
  BD_COUPLED?: boolean;
  vehicle?: KroneVehicle;
  gps?: KroneGps;
  location?: KroneDetailedLocation;
  [field: string]: unknown;
}

export interface KroneProvider {
  name?: string;
  url?: string;
}

export interface KroneRequestData {
  provider?: KroneProvider;
  externalCustomerIdentification?: string;
  boxdata?: KroneBoxdata;
}

/** Top-level body of every push request Krone sends to our endpoint. */
export interface KronePushRequest {
  apiVersion?: string;
  /** UUID v4 of this push message; must be echoed back in the response. */
  id?: string;
  /** Sharing ID of the sharing configuration connected to this push. */
  sharingId?: number;
  /** ISO 8601 creation timestamp of the push message. */
  created?: string;
  /** ISO 8601 timestamp of the last update. */
  updated?: string;
  /** Provider-specific free-form field (optional). */
  specificField1?: string;
  /** Provider-specific free-form field (optional). */
  specificField2?: string;
  data?: KroneRequestData;
}

/** Response body Krone expects on success (HTTP 201). */
export interface KroneSuccessResponse {
  /** UUID echoed from the received request. */
  id: string;
  /** ISO 8601 timestamp at which we received the request. */
  received: string;
  status: 'OK';
}

/** Response body Krone expects on failure (HTTP 400). */
export interface KroneErrorResponse {
  id: string;
  received: string;
  status: 'ERROR';
  error: {
    /** HTTP status code. */
    code: number;
    /** Why the request could not be processed. */
    message: string;
  };
}
