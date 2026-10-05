// What a taskbar or jump list says about starting Orivon again: a new window or a new private window. The command
// is the program and the flag, never the switches of the running launch, because the system keeps it past this
// process and a `--user-data-dir` or `--no-sandbox` would outlive the reason it was there. Pure.
import { NEW_PRIVATE_WINDOW_FLAG, NEW_WINDOW_FLAG } from '../launch/launch-context.js'
import { peerCommand } from '../launch/peer-spawn.js'
import type { PeerSource } from '../launch/peer-spawn.js'
import { windowsArguments } from './site-shortcut.js'

/** The builder's `appId`: what a pinned taskbar button and the installer's shortcut share. */
const APP_USER_MODEL_ID = 'com.orivonstack.orivon'

/** A run from source has an id of its own, so its taskbar button is not taken for the installed program's. */
export function appUserModelId (packaged: boolean): string {
  return packaged ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.source`
}

export interface LauncherTask {
  readonly program: string
  readonly arguments: string
  readonly title: string
  readonly description: string
  readonly iconPath: string
  readonly iconIndex: number
}

const ACTIONS = [
  { title: 'New window', flag: NEW_WINDOW_FLAG },
  { title: 'New private window', flag: NEW_PRIVATE_WINDOW_FLAG }
] as const

export function launcherTasks (source: PeerSource): LauncherTask[] {
  return ACTIONS.map(({ title, flag }) => {
    const { command, args } = peerCommand(source, [flag])
    return { program: command, arguments: windowsArguments(args), title, description: title, iconPath: command, iconIndex: 0 }
  })
}

/** The command a window's taskbar button runs to start Orivon again: the program and what it needs, with no flag. */
export function relaunchCommand (source: PeerSource): string {
  const { command, args } = peerCommand(source, [])
  return windowsArguments([command, ...args])
}
