// The coarse region a telemetry report names, read from the operating system's time zone: never an
// address, a locale lookup or a network call. Pure, so a test passes any zone name.

export type Region = 'EU' | 'US' | 'other'

/** IANA zones of the EU and EEA states, the United Kingdom and Switzerland, and the overseas parts of France and Portugal and Spain that are inside the EU. */
const EUROPE_ZONES: ReadonlySet<string> = new Set([
  'Europe/Vienna', 'Europe/Brussels', 'Europe/Sofia', 'Europe/Zagreb', 'Asia/Nicosia', 'Asia/Famagusta', 'Europe/Nicosia',
  'Europe/Prague', 'Europe/Copenhagen', 'Europe/Tallinn', 'Europe/Helsinki', 'Europe/Mariehamn', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Busingen', 'Europe/Athens', 'Europe/Budapest', 'Europe/Dublin', 'Eire', 'Europe/Rome',
  'Europe/Riga', 'Europe/Vilnius', 'Europe/Luxembourg', 'Europe/Malta', 'Europe/Amsterdam', 'Europe/Warsaw', 'Poland',
  'Europe/Lisbon', 'Portugal', 'Atlantic/Azores', 'Atlantic/Madeira', 'Europe/Bucharest', 'Europe/Bratislava',
  'Europe/Ljubljana', 'Europe/Madrid', 'Africa/Ceuta', 'Atlantic/Canary', 'Europe/Stockholm',
  'Atlantic/Reykjavik', 'Iceland', 'Europe/Vaduz', 'Europe/Oslo', 'Arctic/Longyearbyen', 'Atlantic/Jan_Mayen',
  'Europe/London', 'Europe/Belfast', 'Europe/Jersey', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'GB', 'GB-Eire',
  'Europe/Zurich',
  'Indian/Reunion', 'Indian/Mayotte', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne', 'America/Marigot', 'America/St_Barthelemy'
])

const US_ZONES: ReadonlySet<string> = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage',
  'America/Detroit', 'America/Boise', 'America/Juneau', 'America/Sitka', 'America/Metlakatla', 'America/Yakutat',
  'America/Nome', 'America/Adak', 'America/Menominee', 'Pacific/Honolulu', 'Pacific/Johnston',
  'America/Indianapolis', 'America/Louisville', 'America/Fort_Wayne', 'America/Knox_IN', 'America/Shiprock', 'America/Atka',
  'America/Puerto_Rico', 'America/St_Thomas', 'America/Virgin', 'Pacific/Guam', 'Pacific/Saipan', 'Pacific/Pago_Pago', 'Pacific/Samoa', 'Pacific/Midway',
  'EST5EDT', 'CST6CDT', 'MST7MDT', 'PST8PDT', 'Navajo'
])

const US_PREFIXES: readonly string[] = ['America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/', 'US/']

export function regionOfTimeZone (timeZone: string | undefined): Region {
  if (timeZone === undefined) return 'other'
  if (EUROPE_ZONES.has(timeZone)) return 'EU'
  if (US_ZONES.has(timeZone) || US_PREFIXES.some((prefix) => timeZone.startsWith(prefix))) return 'US'
  return 'other'
}

/** The OS time zone, or undefined when the runtime cannot say. */
export function systemTimeZone (): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}
