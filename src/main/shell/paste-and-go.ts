// "Paste and Go" in the address bar: the clipboard's text goes into the field
// and is submitted as if typed. Reading the system clipboard can stall (a
// desktop whose clipboard owner does not answer), so the read is bounded and a
// stalled one does nothing rather than leaving the menu item hanging.

export const CLIPBOARD_READ_TIMEOUT_MS = 1500
/** The address bar's own limit on what it will submit; a longer clipboard is not an address. */
export const MAX_PASTED_LENGTH = 4096

/** The clipboard text, or null when it is empty, too long for an address, or not read in time. */
export async function readPastedText (read: () => Promise<string>, timeoutMs = CLIPBOARD_READ_TIMEOUT_MS): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null) }, timeoutMs) })
  try {
    const text = await Promise.race([read().catch(() => null), timeout])
    if (text === null || text.trim() === '' || text.length > MAX_PASTED_LENGTH) return null
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Reads the clipboard and, when there is text, hands it to `submit`. */
export async function pasteAndGo (read: () => Promise<string>, submit: (text: string) => void, timeoutMs?: number): Promise<void> {
  const text = await readPastedText(read, timeoutMs)
  if (text !== null) submit(text)
}
