// Writes the export: every password in the clear, so the file is owner-only before its first byte, whether it is new
// or the person picked one that was already there with a wider mode. Tied to Node only.
import { open } from 'node:fs/promises'

/** False when the file could not be made owner-only or written; nothing secret is in it then. */
export async function writePrivate (path: string, text: string): Promise<boolean> {
  try {
    const handle = await open(path, 'w', 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(text, 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch {
    return false
  }
}
