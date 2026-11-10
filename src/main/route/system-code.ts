// Whether a name put to a session would reach code the system supplied: the script its settings name, or the one automatic
// detection finds. A session on the system's own config hands every URL it is asked about to that code, which may resolve the
// host it is shown (`dnsResolve`) or send it anywhere, so a name the verifier serves is never put to such a session. A session
// set to a config of Orivon's own (a copy of the settings, a tunnel's front) runs none of it, and neither does a search for a script
// that the mirror's probe shows finds none. Pure over the facts handed in.

import { proxyMayRunSystemCode, trackProxyAsk } from './proxy-answers.js'
import type { ProxyResolver } from './proxy-answers.js'
import { mirrorStatus } from './proxy-mirror/mirror-status.js'
import type { MirrorStatus } from './proxy-mirror/mirror-status.js'

type Environment = Readonly<Record<string, string | undefined>>

/** Whether Chromium's reading of the environment finds a script or detection: `auto_proxy` is a script's address, or empty for detection, and its upper-case spelling counts too. */
function environmentNamesScript (env: Environment): boolean {
  return env['auto_proxy'] !== undefined || env['AUTO_PROXY'] !== undefined
}

/**
 * Whether the system's settings, as the mirror last found them, may run code of the system's own on a name. Anything the mirror
 * could not tell counts as code: a read that failed, settings it cannot carry, a first read not yet made, and a manual proxy
 * (the readers report one even where the system also looks for a script beside it, so a session that holds no copy of it may be
 * asked under that search). Automatic detection counts as code unless the mirror's own question about ordinary addresses, put to
 * Chromium's session on the system's config after the settings were last read, was answered DIRECT: a search that finds no script
 * leaves nothing to run. A hostile script that answers DIRECT to everything is never noticed that way.
 */
export function settingsMayRunCode (status: MirrorStatus, env: Environment): boolean {
  switch (status.mode) {
    // Where the desktop gave Chromium no proxy it reads the environment: KDE with none set, and GNOME's manual mode with no server (read as none too). The environment's own reader says exactly what `auto_proxy` came to, and none is nothing.
    case 'none': return (status.source === 'gnome' || status.source === 'kde') && environmentNamesScript(env)
    case 'detect': return status.probe !== 'direct'
    case 'unknown': return status.source !== 'environment' || status.reason !== 'no-reader' || environmentNamesScript(env)
    default: return true
  }
}

/** Whether a name put to `target` would reach code of the system's: it is on the system's config (or moving to or from it), and the system's settings may run code. */
export function wouldRunSystemCode (target: object, status: MirrorStatus = mirrorStatus(), env: Environment = process.env): boolean {
  return proxyMayRunSystemCode(target) && settingsMayRunCode(status, env)
}

/** Orivon's own question about a name the verifier serves (T20), put to `holder`, the session that holds the copy of the system's settings: asked of it, or failed without asking where it would reach the system's code. */
export async function askHolderOfCopy (holder: ProxyResolver, url: string): Promise<string> {
  if (wouldRunSystemCode(holder)) throw new Error('the system\'s proxy settings may run a script, and no copy of them is held, so the name was not put to them')
  return await trackProxyAsk(holder, async () => await holder.resolveProxy(url))
}
