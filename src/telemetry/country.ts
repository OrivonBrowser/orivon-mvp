// The country a telemetry report names, read from the operating system's time zone and the runtime's
// own region data: never an address, a locale lookup or a network call. Pure, so a test passes any zone name.

/** An ISO 3166-1 alpha-2 code in capitals, or UNKNOWN_COUNTRY. */
export type Country = string

export const UNKNOWN_COUNTRY: Country = 'unknown'

/** The two members of Intl.Locale that list a region's zones; V8 has both, and the TypeScript lib types neither. */
interface LocaleWithZones {
  readonly region?: string
  getTimeZones?: () => string[] | undefined
  readonly timeZones?: string[]
}

const A = 'A'.charCodeAt(0)
const LETTERS = 26

/** Every canonical zone name to its country, read once from the runtime's data: a zone shared by two countries keeps the first. */
let countryByZone: ReadonlyMap<string, Country> | undefined

function buildCountryByZone (): ReadonlyMap<string, Country> {
  const table = new Map<string, Country>()
  for (let i = 0; i < LETTERS * LETTERS; i += 1) {
    const code = String.fromCharCode(A + Math.floor(i / LETTERS), A + (i % LETTERS))
    const locale = new Intl.Locale(`und-${code}`) as unknown as LocaleWithZones
    // ICU rewrites a deprecated code to its successor (UK to GB, SU to RU); only the code it keeps is a country.
    if (locale.region !== code) continue
    for (const zone of locale.getTimeZones?.() ?? locale.timeZones ?? []) {
      if (!table.has(zone)) table.set(zone, code)
    }
  }
  return table
}

/** The country a zone lies in, or UNKNOWN_COUNTRY for no zone, a name the runtime does not know, and the zones that belong to no country (UTC, Etc/GMT+5). */
export function countryOfTimeZone (timeZone: string | undefined): Country {
  if (timeZone === undefined) return UNKNOWN_COUNTRY
  let canonical: string | undefined
  try {
    // An alias such as Asia/Calcutta resolves to the name the region data lists (Asia/Kolkata).
    canonical = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone
  } catch {
    return UNKNOWN_COUNTRY
  }
  countryByZone ??= buildCountryByZone()
  return countryByZone.get(canonical) ?? UNKNOWN_COUNTRY
}

/** The OS time zone, or undefined when the runtime cannot say. */
export function systemTimeZone (): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}
