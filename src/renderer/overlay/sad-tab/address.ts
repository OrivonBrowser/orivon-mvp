/** `address` cut in the middle to at most `max` characters: the host at the start and the end of the path both stay readable. */
export function shortenMiddle (address: string, max: number): string {
  const chars = [...address]
  if (chars.length <= max) return address
  const keep = Math.max(2, max - 1)
  const head = Math.ceil(keep * 0.6)
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`
}
