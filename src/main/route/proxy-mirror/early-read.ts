// Starts the read of the computer's proxy settings while Chromium is still starting, and hands that read to the mirror's first
// pass. The read waits on a program (`reg.exe`, `gsettings`, `scutil`) and needs no session, so it has no reason to wait for the
// browser to be ready. Tied to the operating system: the readers it picks start programs or open files.

import { parseLaunch } from '../../launch/launch-context.js'
import { environmentReader } from './read-environment.js'
import { readKdeSettings } from './read-kde-files.js'
import { readGnomeSettings, readMacosSettings, readWindowsSettings } from './run-readers.js'
import { sourceOf } from './settings-source.js'
import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** Reads the settings once; never rejects. */
export type SettingsReader = () => Promise<SystemSettings>

type Environment = Readonly<Record<string, string | undefined>>

/** The reader of `source`, or undefined where there is none to poll (the environment names no script). */
export function readerFor (source: SettingsSourceName, env: Environment): SettingsReader | undefined {
  switch (source) {
    case 'gnome': return readGnomeSettings
    case 'kde': return readKdeSettings
    case 'windows': return readWindowsSettings
    case 'macos': return readMacosSettings
    case 'environment': return environmentReader(env)
  }
}

/**
 * Starts `read` now. The reader it returns answers its first call with that read, whether it has ended or not, and every later
 * call with a read of its own, so the mirror's first pass awaits what is in flight and the passes after it see the settings as
 * they are then. A read that failed is the answer to that first call, as it would be had the read been made at that call.
 */
export function readEarly (read: SettingsReader | undefined): SettingsReader | undefined {
  if (read === undefined) return undefined
  // A reader never rejects; one that did must not leave a rejection nobody awaits yet, in a hook whose failure stops the start.
  let early: Promise<SystemSettings> | undefined = read().catch((): SystemSettings => ({ kind: 'unreadable' }))
  return async () => {
    const started = early
    early = undefined
    return await (started ?? read())
  }
}

/** A private session held to Nym follows no setting of this computer (`held` in the mirror), and a read of them would be for nothing. */
function heldToNym (argv: readonly string[]): boolean {
  const parsed = parseLaunch(argv, '')
  return parsed.ok && parsed.launch.kind === 'private' && parsed.launch.tunnel === 'nym'
}

/** What the route subsystem starts before the browser is ready: the read of this computer's settings, unless this process follows none. */
export function startSystemRead (platform: string, env: Environment, argv: readonly string[]): SettingsReader | undefined {
  return heldToNym(argv) ? undefined : readEarly(readerFor(sourceOf(platform, env), env))
}
