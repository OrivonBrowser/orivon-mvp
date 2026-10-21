// What may a page do with a USB HID device (ADR-0068): the device key an approval is stored under, the grant's
// filters, and the one decision both the permission check and the per-device question read. Pure: no `electron`,
// so it is unit tested under plain vitest and survives an engine change.
import type { HidDeviceFilter, Pattern } from '../../contracts/index.js'
import { parseHidPattern } from '../../broker/policy/hid-pattern.js'

export { parseHidPattern }

/** What Chromium tells the host about a device; `collections` is absent where it is not known. */
export interface HidDeviceInfo {
  readonly vendorId: number
  readonly productId: number
  readonly serialNumber?: string | undefined
  readonly name?: string | undefined
  readonly collections?: ReadonlyArray<{ readonly usagePage: number, readonly usage: number }> | undefined
}

/** Vendor, product, serial number and product name: the key an approval is stored under (provisional, ADR-0068). */
export function deviceKey (device: HidDeviceInfo): string {
  return JSON.stringify([device.vendorId, device.productId, device.serialNumber ?? '', device.name ?? ''])
}

export function filtersFromPatterns (patterns: readonly Pattern[]): HidDeviceFilter[] {
  const filters: HidDeviceFilter[] = []
  for (const pattern of patterns) {
    const filter = parseHidPattern(pattern)
    if (filter !== null) filters.push(filter)
  }
  return filters
}

/** WebHID's rule: every named field equals the device's own; a usage is looked for among its top-level collections. */
export function matchesFilter (device: HidDeviceInfo, filter: HidDeviceFilter): boolean {
  if (device.vendorId !== filter.vendorId) return false
  if (filter.productId !== undefined && device.productId !== filter.productId) return false
  if (filter.usagePage === undefined) return true
  return (device.collections ?? []).some((collection) =>
    collection.usagePage === filter.usagePage && (filter.usage === undefined || collection.usage === filter.usage))
}

export function matchesAny (device: HidDeviceInfo, filters: readonly HidDeviceFilter[]): boolean {
  return filters.some((filter) => matchesFilter(device, filter))
}

export type HidDecision = 'allow' | 'ask' | 'deny'

export type HidParty =
  /** A registered app; `patterns` are its `devices.hid` grant, or undefined when it holds none. */
  | { readonly kind: 'app', readonly patterns: readonly Pattern[] | undefined }
  /** An ordinary website; `blocked` is the person's Block for "USB and HID devices". */
  | { readonly kind: 'website', readonly blocked: boolean }

export interface HidDecisionInput {
  readonly party: HidParty
  readonly device: HidDeviceInfo
  /** The person approved this device for this origin. */
  readonly approved: boolean
  /** The person said "Not now" to this device for this origin, this session. */
  readonly declined: boolean
}

/**
 * An app: usable only when its grant's filters match and the person approved the device; a matching device not yet
 * decided is `ask`. A website: usable only when approved through the chooser and the setting is not Block, and never
 * `ask`, because only the chooser asks a website.
 */
export function decideHid (input: HidDecisionInput): HidDecision {
  const { party, device } = input
  if (party.kind === 'website') return !party.blocked && input.approved ? 'allow' : 'deny'
  if (party.patterns === undefined || !matchesAny(device, filtersFromPatterns(party.patterns))) return 'deny'
  if (input.approved) return 'allow'
  return input.declined ? 'deny' : 'ask'
}

/** A device as Electron hands it over, cut down to what the policy reads; null for anything that is not a HID device. */
export function hidInfoOf (value: unknown): HidDeviceInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const { vendorId, productId, serialNumber, name, collections } = value as Record<string, unknown>
  if (typeof vendorId !== 'number' || typeof productId !== 'number') return null
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null
  return {
    vendorId,
    productId,
    serialNumber: typeof serialNumber === 'string' ? serialNumber : undefined,
    name: typeof name === 'string' ? name : undefined,
    collections: Array.isArray(collections)
      ? (collections as unknown[]).flatMap((entry) => {
          const { usagePage, usage } = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
          return typeof usagePage === 'number' && typeof usage === 'number' ? [{ usagePage, usage }] : []
        })
      : undefined
  }
}
