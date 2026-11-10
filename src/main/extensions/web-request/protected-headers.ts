// The headers Orivon sets between the shell and its pages (`x-orivon-*`: the partition stamp, the mark on an answer the shell gave,
// the content root). An extension reads and records requests and may rewrite their headers, but none of these: a page's right to
// `window.orivon` rests on one of them, so no listener or rule may add, change or remove it.

const PREFIX = 'x-orivon-'

/** Whether `name` is one of Orivon's own headers, whatever case it is written in. */
export function isOrivonHeader (name: string): boolean {
  return name.toLowerCase().startsWith(PREFIX)
}
