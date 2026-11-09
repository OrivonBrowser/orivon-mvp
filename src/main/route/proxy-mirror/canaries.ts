// The addresses the mirror asks both Chromium's own answer and its copy about, to see that the copy sends them where the system does.
// Pure.

/** Two ordinary sites the system's rules send to the proxy or past it by scheme alone. */
export const BASE_CANARIES: readonly string[] = ['https://example.com/', 'http://example.com/']

/** The most addresses made from the system's exceptions: the check costs a question to two sessions for each. */
const MOST_FROM_EXCEPTIONS = 3
const NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/\d{1,2})?$/

/** An address an exception covers, or undefined for one that says nothing a plain question can show (a port, a scheme, `<local>`, `*`, a loopback address, an IPv6 range). */
function coveredBy (exception: string): string | undefined {
  const ip = IPV4.exec(exception)
  if (ip !== null) {
    const octets = ip.slice(1, 5).map(Number)
    if (octets.some((octet) => octet > 255) || [0, 127, 169].includes(octets[0] as number)) return undefined
    return `https://${exception.split('/')[0] as string}/`
  }
  const suffix = exception.replace(/^\*\.?/, '').replace(/^\./, '')
  if (!NAME.test(suffix) || suffix === 'localhost') return undefined
  return /^[*.]/.test(exception) ? `https://probe.${suffix}/` : `https://${suffix}/`
}

/** Up to three addresses the system's exceptions cover, in their order. */
export function exceptionCanaries (exceptions: readonly string[]): string[] {
  const found: string[] = []
  for (const exception of exceptions) {
    const url = coveredBy(exception)
    if (url !== undefined && !found.includes(url)) found.push(url)
    if (found.length === MOST_FROM_EXCEPTIONS) break
  }
  return found
}
