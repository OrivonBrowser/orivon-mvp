// The canonical string a `devices.hid` filter is stored as in the grant ledger (contracts/devices.ts): the fields it
// names in the order vendor, product, usagePage, usage, each four lowercase hex digits. Pure, and in policy/ because
// both the manifest side (to write it) and the run-time side (to read it back) need the one grammar.
import type { HidDeviceFilter, Pattern } from '../../contracts/index.js'

const FIELD = /^(vendor|product|usagePage|usage)=([0-9a-f]{4})$/
const ORDER = ['vendor', 'product', 'usagePage', 'usage'] as const

const hex = (value: number): string => value.toString(16).padStart(4, '0')

/** The filter as its one canonical string. The filter is assumed valid: the loader checks the numbers and `usage` without `usagePage`. */
export function hidFilterToPattern (filter: HidDeviceFilter): Pattern {
  const parts = [`vendor=${hex(filter.vendorId)}`]
  if (filter.productId !== undefined) parts.push(`product=${hex(filter.productId)}`)
  if (filter.usagePage !== undefined) parts.push(`usagePage=${hex(filter.usagePage)}`)
  if (filter.usage !== undefined) parts.push(`usage=${hex(filter.usage)}`)
  return parts.join(',')
}

/**
 * A canonical string read back into a filter. Anything that is not exactly that string (wrong order, a repeated or
 * unknown field, upper-case hex, `usage` without `usagePage`, no vendor) is null: a ledger line that is not
 * understood grants nothing.
 */
export function parseHidPattern (pattern: Pattern): HidDeviceFilter | null {
  const fields = new Map<string, number>()
  let last = -1
  for (const part of pattern.split(',')) {
    const match = FIELD.exec(part)
    const name = match?.[1]
    const digits = match?.[2]
    if (name === undefined || digits === undefined) return null
    const position = ORDER.indexOf(name as typeof ORDER[number])
    if (position <= last) return null
    last = position
    fields.set(name, Number.parseInt(digits, 16))
  }
  const vendorId = fields.get('vendor')
  if (vendorId === undefined) return null
  const productId = fields.get('product')
  const usagePage = fields.get('usagePage')
  const usage = fields.get('usage')
  if (usage !== undefined && usagePage === undefined) return null
  return {
    vendorId,
    ...(productId === undefined ? {} : { productId }),
    ...(usagePage === undefined ? {} : { usagePage }),
    ...(usage === undefined ? {} : { usage })
  }
}
