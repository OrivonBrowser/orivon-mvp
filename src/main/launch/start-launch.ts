// The first thing the browser does, before it reads any data: work out which
// browser this process is, point it at that browser's directory, and step aside
// if that browser is already running (a second start of the same profile only
// asks the first to show itself). Runs before anything asks for the data
// directory, because a store that had already read the default directory
// could not be moved.
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { App } from 'electron'
import { parseLaunch } from './launch-context.js'
import type { Launch } from './launch-context.js'
import { createPrivateDir, isPrivateDirName, markPrivate } from './private-session.js'
import { ProfileStore } from './profile-store.js'
import type { PeerSource } from './peer-spawn.js'

/** What this process is. */
export interface Runtime {
  readonly launch: Launch
  /** This process's data directory. */
  readonly dir: string
  readonly profiles: ProfileStore
  readonly source: PeerSource
  readonly isPrivate: boolean
  /** The profile this is: `default`, an id, or `private` for a session. */
  readonly profileId: string
  /** The switches of this launch that a process it starts must have too, or it would look for its data somewhere else. */
  readonly inherit: readonly string[]
}

/** Where the data is, and whether the sandbox is on: what a peer must be told the way this process was. Nothing else on the command line is passed on (a debugger's port would collide). */
const INHERITED_SWITCHES = ['--user-data-dir=', '--no-sandbox']

type LaunchApp = Pick<App, 'getPath' | 'setPath' | 'exit' | 'requestSingleInstanceLock' | 'isPackaged' | 'getAppPath'>

/** Null when this process is not to go on: a launch that could not be understood, or a profile that is already open. */
export function startLaunch (app: LaunchApp, argv: readonly string[], env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, tmp = tmpdir()): Runtime | null {
  const home = app.getPath('userData')
  const fail = (problem: string): null => {
    console.error(`[orivon] cannot start: ${problem}`)
    app.exit(2)
    return null
  }

  const parsed = parseLaunch(argv, home)
  if (!parsed.ok) return fail(parsed.problem)
  const { launch } = parsed
  const profiles = new ProfileStore(home)
  const source: PeerSource = { execPath, appPath: app.getAppPath(), packaged: app.isPackaged, appImage: env['APPIMAGE'], env }

  let dir = home
  let profileId = 'default'
  if (launch.kind === 'profile') {
    // A profile is made in the browser, never by a typo on a command line.
    if (!existsSync(join(launch.dir, 'profile.json'))) return fail(`there is no profile "${launch.id}"`)
    dir = launch.dir
    profileId = launch.id
  } else if (launch.kind === 'private') {
    // The directory of a private session is deleted when it ends, so one named on a command line must be one this browser made.
    if (launch.dir !== null && (dirname(resolve(launch.dir)) !== resolve(tmp) || !isPrivateDirName(basename(launch.dir)) || !existsSync(launch.dir))) {
      return fail('that is not the directory of a private session')
    }
    dir = launch.dir ?? createPrivateDir(home, home, tmp)
    profileId = 'private'
    markPrivate(dir, process.pid)
  }
  if (dir !== home) app.setPath('userData', dir)

  // One browser per profile: a second start of it hands over and stops. A private session has a directory of its own and no rival.
  if (launch.kind !== 'private' && !app.requestSingleInstanceLock()) {
    app.exit(0)
    return null
  }
  const inherit = argv.filter((argument) => INHERITED_SWITCHES.some((switchName) => argument === switchName || argument.startsWith(switchName)))
  return { launch, dir, profiles, source, isPrivate: launch.kind === 'private', profileId, inherit }
}
