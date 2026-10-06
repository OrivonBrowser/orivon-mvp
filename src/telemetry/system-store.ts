// The state every profile of this operating-system user shares, in the telemetry home: the consent
// (consent.json) and, only when the computer's own identifier cannot be read, a random install ID
// (install-id). A profile process reads the consent fresh on every send tick, so a choice made in one
// profile reaches the others without a message between them.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseConsentRecord, serializeConsentRecord, type ConsentRecord } from './consent.js'

export const CONSENT_FILE = 'consent.json'
export const FALLBACK_ID_FILE = 'install-id'

async function readText (path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Written through a temporary name and renamed, so a process reading at that moment sees the old file or the new one, never half of one. */
async function writeAtomically (home: string, name: string, text: string): Promise<void> {
  await mkdir(home, { recursive: true })
  const temporary = join(home, `.${name}.${String(process.pid)}.tmp`)
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, join(home, name))
}

export class SystemStore {
  constructor (private readonly home: string) {}

  async readConsent (): Promise<ConsentRecord> {
    return parseConsentRecord(await readText(join(this.home, CONSENT_FILE)))
  }

  async writeConsent (record: ConsentRecord): Promise<void> {
    await writeAtomically(this.home, CONSENT_FILE, serializeConsentRecord(record))
  }

  async readFallbackId (): Promise<string | undefined> {
    return (await readText(join(this.home, FALLBACK_ID_FILE)))?.trim()
  }

  async writeFallbackId (id: string): Promise<void> {
    await writeAtomically(this.home, FALLBACK_ID_FILE, `${id}\n`)
  }
}
