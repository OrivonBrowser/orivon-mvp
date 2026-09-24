/** Letters, digits and inner hyphens, 1-63 per label. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const MAX_DNS_NAME = 253

/** `name` lowercased, if it is an ASCII DNS name of two labels or more; otherwise undefined. */
export function dnsName (name: string): string | undefined {
  const lower = name.toLowerCase()
  const labels = lower.split('.')
  if (lower.length > MAX_DNS_NAME || labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return undefined
  return lower
}
