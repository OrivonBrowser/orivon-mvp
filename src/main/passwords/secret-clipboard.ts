// Copying a password to the clipboard without leaving it there: a minute later it is removed, but only if the
// clipboard still holds it, so something the person copied since is never wiped. Pure over the clipboard it is given.
export interface ClipboardAccess {
  write: (text: string) => Promise<void>
  read: () => Promise<string>
  clear: () => void
}

export interface SecretClipboard {
  /** Resolves once the text is on the clipboard, or after a second either way, so a clipboard that hangs never holds the page. False when the write failed. */
  copy: (text: string) => Promise<boolean>
  /** Clears the clipboard now when it still holds the last secret copied, for an app that is quitting before the timer runs. */
  flush: () => Promise<void>
}

export const WRITE_WAIT_MS = 1000
export const CLEAR_AFTER_MS = 60_000

export function secretClipboard (
  clipboard: ClipboardAccess,
  later: (run: () => Promise<void>, ms: number) => void = (run, ms) => { setTimeout(() => { void run() }, ms).unref() }
): SecretClipboard {
  /** The newest secret that is still waiting for its minute to pass. */
  let waiting: string | null = null

  async function clearIfStillHeld (text: string): Promise<void> {
    try {
      if (await clipboard.read() === text) clipboard.clear()
    } catch {
      // A clipboard that cannot be read cannot be cleared either.
    }
  }

  return {
    flush: async () => {
      const text = waiting
      waiting = null
      if (text !== null) await clearIfStillHeld(text)
    },
    copy: async (text) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          clipboard.write(text),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, WRITE_WAIT_MS) })
        ])
      } catch {
        return false
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      waiting = text
      later(async () => {
        if (waiting === text) waiting = null
        await clearIfStillHeld(text)
      }, CLEAR_AFTER_MS)
      return true
    }
  }
}
