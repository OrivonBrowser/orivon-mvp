// Starting another Orivon process: a profile that is not this one, or a private
// session. It is a peer, not a child: detached, so closing this browser leaves it
// running. What identifies the running program differs by how Orivon was started,
// and getting it wrong starts nothing.
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface PeerSource {
  readonly execPath: string
  /** Where the app is when it is run from source. */
  readonly appPath: string
  readonly packaged: boolean
  /** Set inside an AppImage: `execPath` there sits in a mount that goes away with the process that made it. */
  readonly appImage: string | undefined
  readonly env: NodeJS.ProcessEnv
}

/** What the environment must not hand to a peer: the switch that makes the binary plain Node, and the settings of a run set up for someone else's screen. */
const NOT_INHERITED = ['ELECTRON_RUN_AS_NODE', 'ORIVON_INTRO', 'ORIVON_WINDOW_NO_FOCUS']

export interface PeerCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

export function peerCommand (source: PeerSource, flags: readonly string[]): PeerCommand {
  const env: NodeJS.ProcessEnv = { ...source.env }
  for (const name of NOT_INHERITED) delete env[name]
  if (source.packaged) return { command: source.appImage ?? source.execPath, args: [...flags], env }
  return { command: source.execPath, args: [source.appPath, ...flags], env }
}

export function spawnPeer (source: PeerSource, flags: readonly string[], spawn: typeof nodeSpawn = nodeSpawn): ChildProcess {
  const { command, args, env } = peerCommand(source, flags)
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore', env })
  // Its own process group and no attachment to this one's streams: this browser closing does not close it.
  child.unref()
  return child
}
