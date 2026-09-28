/** Letters, digits and inner hyphens, 1-63 per label. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const MAX_DNS_NAME = 253

/** Whether `label` is one lowercase ASCII DNS label. */
export function isDnsLabel (label: string): boolean {
  return DNS_LABEL.test(label)
}

/** `name` lowercased, if it is an ASCII DNS name of two labels or more; otherwise undefined. */
export function dnsName (name: string): string | undefined {
  const lower = name.toLowerCase()
  const labels = lower.split('.')
  if (lower.length > MAX_DNS_NAME || labels.length < 2 || !labels.every(isDnsLabel)) return undefined
  return lower
}
