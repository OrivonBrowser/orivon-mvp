// What the first window does about What's new: reads what the profile remembers, decides, and writes the
// version down. Tied to Electron only for the version; the rest is ./whats-new.ts.
import { app } from 'electron'
import { readIntroSeen, readLastRunVersion, rememberRunVersion } from '../shell/intro-state.js'
import { runningRelease } from './running-release.js'
import { decideWhatsNew } from './whats-new.js'

/** True when the page is to open now. Never throws: a profile that cannot be read costs the page, not the start. */
export async function whatsNewDue (userDataDir: string): Promise<boolean> {
  try {
    const release = runningRelease(app.getVersion())
    const decision = decideWhatsNew({
      current: release.version,
      lastRun: await readLastRunVersion(userDataDir),
      welcomeSeen: await readIntroSeen(userDataDir),
      hasNotes: release.notes !== null
    })
    if (decision.remember !== undefined) await rememberRunVersion(userDataDir, decision.remember)
    return decision.open
  } catch (error) {
    console.error('[orivon] whats-new: could not decide:', error)
    return false
  }
}
