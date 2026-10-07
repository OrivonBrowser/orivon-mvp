// What a launch writes into a fresh profile before Electron starts (launch-electron.mjs), so a test run
// contacts nothing it did not start and meets no question it did not ask for. Each seed keeps what a
// spec's own seedProfile already wrote.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Writes one value into the profile's settings file, keeping every value a seed already put there; `ifAbsent` leaves a value the seed set. */
async function seedSetting (userDataDir, key, value, { ifAbsent = false } = {}) {
  const file = join(userDataDir, 'settings.json')
  let stored = { version: 1, values: {} }
  try { stored = JSON.parse(await readFile(file, 'utf8')) } catch { /* no file yet */ }
  if (ifAbsent && stored.values?.[key] !== undefined) return
  await mkdir(userDataDir, { recursive: true })
  await writeFile(file, JSON.stringify({ ...stored, values: { ...stored.values, [key]: value } }))
}

export async function seedTheme (userDataDir, scheme) {
  await seedSetting(userDataDir, 'appearance.theme', scheme)
}

/**
 * A fresh profile asks no Web3 Score provider unless its seed names one: the default provider is a
 * network address, and a test run contacts nothing it did not start.
 */
export async function seedNoScoreProvider (userDataDir) {
  await seedSetting(userDataDir, 'web3.scoreProvider', '', { ifAbsent: true })
}

/**
 * A launch with the default-browser test seam on asks to be the default browser half a minute into a fresh
 * profile's use (src/main/os/default-browser-ask.ts), which would open a question over whatever a long spec
 * drives. Unless the seed wrote the ask's own clock, it starts as asked just now: the next ask is a week away.
 */
export async function seedDefaultBrowserAskNotDue (userDataDir) {
  const file = join(userDataDir, 'default-browser-ask.json')
  try {
    await readFile(file)
  } catch {
    const now = Date.now()
    await writeFile(file, JSON.stringify({ firstSeenAt: now, lastAskedAt: now, stopped: false }))
  }
}
