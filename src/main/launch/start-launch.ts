// The first thing the browser does, before it reads any data: work out which
// browser this process is, point it at that browser's directory, and step aside
// if that browser is already running (a second start of the same profile hands the first what it asks for: a window,
// a private session or its addresses). Runs before anything asks for the data
// directory, because a store that had already read the default directory
// could not be moved.
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { App } from 'electron'
import { parseLaunch, switchesOf } from './launch-context.js'
import type { Launch } from './launch-context.js'
import { launchData, requestFromArgv } from './launch-request.js'
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
  /** The private directory this process made for itself, which nothing else will remove when it ends. Absent when another browser made it or this is a profile. */
  readonly madeDir?: string
  /** The switches of this launch that a process it starts must have too, or it would look for its data somewhere else. */
  readonly inherit: readonly string[]
}

/** Where the data is, and whether the sandbox is on: what a peer must be told the way this process was. Nothing else on the command line is passed on (a debugger's port would collide). */
const INHERITED_SWITCHES = ['--user-data-dir=', '--no-sandbox']

type LaunchApp = Pick<App, 'getPath' | 'setPath' | 'exit' | 'requestSingleInstanceLock' | 'releaseSingleInstanceLock' | 'isPackaged' | 'getAppPath' | 'commandLine'>

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

  let launched: Launch = launch
  let dir = home
  let profileId = 'default'
  let madeDir: string | undefined
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
    if (launch.dir === null) madeDir = createPrivateDir(home, home, tmp)
    dir = launch.dir ?? madeDir ?? home
    profileId = 'private'
    markPrivate(dir, process.pid)
  }
  if (dir !== home) app.setPath('userData', dir)

  // One browser per profile: a second start of it hands over what it was asked and stops. A private session named
  // on the command line has a directory of its own and no rival.
  if (launch.kind !== 'private') {
    const request = requestFromArgv(argv, app.isPackaged)
    if (!app.requestSingleInstanceLock(launchData(request))) {
      app.exit(0)
      return null
    }
    if (request.kind === 'private') {
      // Nothing of this profile is open, so the request is this process: a private session beside the profile's data, with
      // no claim on the profile's lock, which the next start of the profile takes. A start of the profile that
      // reaches the lock in the moment before this release is handed to a process that does not listen, and is lost.
      app.releaseSingleInstanceLock()
      const sessionDir = createPrivateDir(dir, home, tmp)
      launched = { kind: 'private', home, dir: sessionDir }
      dir = sessionDir
      madeDir = sessionDir
      profileId = 'private'
      markPrivate(dir, process.pid)
      app.setPath('userData', dir)
    }
  }
  // Said at once, not once the first window is up: until then a second window of this browser would see the profile as
  // not in use, and Delete would remove it from under a browser that is starting.
  if (launched.kind !== 'private') profiles.markRunning(profileId, process.pid)
  const inherit = switchesOf(argv).filter((argument) => INHERITED_SWITCHES.some((switchName) => argument === switchName || argument.startsWith(switchName)))
  // Chromium's own command line as well: a launcher can take a switch back off argv once it has taken effect, and a
  // peer started with the sandbox where this one runs without it aborts on a machine that has none.
  if (!inherit.includes('--no-sandbox') && app.commandLine.hasSwitch('no-sandbox')) inherit.push('--no-sandbox')
  return { launch: launched, dir, profiles, source, isPrivate: launched.kind === 'private', profileId, inherit, ...(madeDir === undefined ? {} : { madeDir }) }
}
