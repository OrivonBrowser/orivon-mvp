// The one way Orivon forks a utility process. Its output is piped to main, which writes each line to its own
// console, so what a host prints reaches the log a bug report carries (and, from a terminal, still appears once).
// A host forked any other way prints past main, to the app's own stderr, and a packaged Windows app has none.
// `host-fork.test.ts` fails a `utilityProcess.fork` anywhere else in `src/main/`.
import { app, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { HOST_LINES_PER_MINUTE, HostLog } from './host-output.js'

export interface HostForkSpec {
  /** The host's entry file. */
  readonly module: string
  /** The name Electron gives the process, which the task manager and a crash record show. */
  readonly serviceName: string
  /** How the host's own log lines begin, `[verifier]` for one that starts so. */
  readonly prefix: string
  /** The host's whole output is wanted (its `LOG` switch is on): nothing is left out or collapsed for the log's sake. */
  readonly unlimited?: boolean
  /** For a host whose process also runs a library that prints what it likes: only a line that begins with `prefix` is written, and the rest is counted as coming from this (`the Nym library`). `unlimited` writes it all. */
  readonly onlyTagged?: string
}

/**
 * The `fork` function of a supervisor. The returned function is called for every start of the host, and they share
 * one allowance of lines a minute, so a host that crashes and restarts in a loop cannot flood the log.
 */
export function hostForker (spec: HostForkSpec): () => UtilityProcess {
  const log = new HostLog({
    prefix: spec.prefix,
    // Looked up at each line: the log is captured by replacing the console's methods, after this is made.
    write: (level, text) => { console[level](text) },
    linesPerMinute: spec.unlimited === true ? undefined : HOST_LINES_PER_MINUTE,
    onlyTagged: spec.unlimited === true ? undefined : spec.onlyTagged
  })
  let quitWatched = false
  return () => {
    if (!quitWatched) {
      quitWatched = true
      // Ahead of the diagnostics' own listener, which writes the log file out and ends the run: what the host
      // held back for the minute's end is then in that file, not lost with the process.
      app.prependListener('will-quit', () => { log.flush() })
    }
    const child = utilityProcess.fork(spec.module, [], { serviceName: spec.serviceName, stdio: 'pipe' })
    log.attach(child)
    return child
  }
}
