// This process's start-up CPU profile (startup-profile.ts) on the real inspector, file system and clock. Evaluating this
// module starts the profile when ORIVON_STARTUP_PROFILE names a file, so start.ts imports it first and what the
// imports after it evaluate is in the profile too. Unset, it reads one variable and does nothing else.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import type { Session } from 'node:inspector'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { processAgeMs } from './startup-marks.js'
import { createStartupProfile, startupProfilePath } from './startup-profile.js'
import type { ProfilerLink, StartupProfileHost } from './startup-profile.js'

function openInspector (): ProfilerLink {
  // Loaded only when a profile is asked for: no other start has any use for the inspector.
  const { Session: InspectorSession } = createRequire(import.meta.url)('node:inspector') as { Session: new () => Session }
  const session = new InspectorSession()
  return {
    connect: () => { session.connect() },
    disconnect: () => { session.disconnect() },
    post: (method, params, callback) => { session.post(method, params ?? {}, callback as (error: Error | null, result?: object) => void) }
  }
}

/** The file whole or not at all: a start that is killed while it writes leaves the file a reader asked for absent, never half there. */
function writeWhole (path: string, text: string): void {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  const partial = `${target}.${String(process.pid)}.partial`
  writeFileSync(partial, text)
  renameSync(partial, target)
}

const host: StartupProfileHost = {
  open: openInspector,
  write: writeWhole,
  log: (line, level) => { console[level](line) },
  later: (run, ms) => { setTimeout(run, ms).unref() },
  anchor: () => {
    // Electron adds getCreationTime to `process`; a plain Node run has none.
    const createdAt = typeof process.getCreationTime === 'function' ? process.getCreationTime() : null
    const age = processAgeMs({ wallNow: () => Date.now(), createdAt })
    return age === null ? { startMs: Math.round(performance.now()), base: 'performance-origin' } : { startMs: Math.round(age), base: 'process-creation' }
  }
}

const profile = createStartupProfile(host)
const asked = startupProfilePath(process.env)
if (asked !== null) profile.start(asked)

/** Stops the profile and writes the file, when one was asked for; otherwise does nothing. `reason` is for the one line it logs. */
export function stopStartupProfile (reason: string): void {
  profile.stop(reason)
}
