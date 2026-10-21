// `capabilities.devices` (ADR-0068), split out of ./capabilities.ts (docs/development/code-guidelines.md Rule 2).
// Same stance as manifest.ts: THE INPUT IS ADVERSARIAL, every check REJECTS rather than repairs, and every
// rejection reason is developer-facing.

import { LIMITS } from '../../contracts/index.js'
import type { DevicesCapability, HidDeviceFilter } from '../../contracts/index.js'
import { hidFilterToPattern } from '../../broker/policy/hid-pattern.js'
import { ownProperty } from '../../broker/policy/own-property.js'
import { describeValue, extraKey, isAny, isRecord, reject } from './manifest.js'

/** The parity guard (scripts/check-manifest-parity.mjs) reads these lists against `contracts/devices.ts`. */
const DEVICES_CAPABILITY_KEYS = ['hid']
const HID_DEVICE_FILTER_KEYS = ['vendorId', 'productId', 'usagePage', 'usage']

const MAX_ID = 0xffff

function readId (raw: Record<string, unknown>, path: string, field: string): number | undefined {
  const value = ownProperty(raw, field, isAny)
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_ID) {
    reject(`${path}.${field} must be an integer from 0 to ${String(MAX_ID)}, got ${describeValue(value)}`)
  }
  return value
}

function readFilter (raw: unknown, path: string): HidDeviceFilter {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, HID_DEVICE_FILTER_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const vendorId = readId(raw, path, 'vendorId')
  if (vendorId === undefined) reject(`${path}.vendorId is required: there is no grant for any HID device`)
  const productId = readId(raw, path, 'productId')
  const usagePage = readId(raw, path, 'usagePage')
  const usage = readId(raw, path, 'usage')
  if (usage !== undefined && usagePage === undefined) reject(`${path}.usage needs usagePage`)
  return {
    vendorId,
    ...(productId === undefined ? {} : { productId }),
    ...(usagePage === undefined ? {} : { usagePage }),
    ...(usage === undefined ? {} : { usage })
  }
}

/** At least one filter, at most `LIMITS.hidFilters`, none twice: a list that means "none" says nothing, and a repeat is a typo. */
export function readDevices (raw: unknown, path: string): DevicesCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, DEVICES_CAPABILITY_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const hidRaw = ownProperty(raw, 'hid', isAny)
  if (hidRaw === undefined) reject(`${path} declares nothing: name hid, or omit devices`)
  if (!Array.isArray(hidRaw)) reject(`${path}.hid must be an array, got ${describeValue(hidRaw)}`)
  if (hidRaw.length === 0) reject(`${path}.hid must name at least one filter`)
  if (hidRaw.length > LIMITS.hidFilters) reject(`${path}.hid names more than ${String(LIMITS.hidFilters)} filters`)

  const seen = new Set<string>()
  const hid = (hidRaw as unknown[]).map((entry, index) => {
    const filter = readFilter(entry, `${path}.hid[${String(index)}]`)
    const canonical = hidFilterToPattern(filter)
    if (seen.has(canonical)) reject(`${path}.hid[${String(index)}] repeats an earlier filter`)
    seen.add(canonical)
    return filter
  })
  return { hid }
}
