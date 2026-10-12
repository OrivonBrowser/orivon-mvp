// The Swarm node's work, apart from the process it runs in: the data
// directory, the component, and the readiness reports. entry.ts gives it the
// parent port; a test gives it a directory and a recorder.

import { InputStream, OutputStream } from '../../shim/wasi-p2/io.js'
import { componentImports } from '../../shim/wasi-p2/imports.js'
import { GUEST_DATA_DIR, nodeArguments, prepareDataDir } from './config.js'
import { loadComponent } from './component.js'
import type { LoaderSeams } from './component.js'
import { createConfinedFs } from './node-fs.js'
import { createNodeNet } from './node-net.js'
import type { NodeNetDeps } from './node-net.js'
import type { FromNode, SwarmNodeConfig } from './protocol.js'
import { peerCountOfLog, watchReadiness } from './readiness.js'
import type { Fetcher } from './readiness.js'

export interface NodeServiceDeps {
  readonly post: (message: FromNode) => void
  readonly fetcher?: Fetcher
  readonly net?: NodeNetDeps
  /** Every log line the node writes, as it writes it. */
  readonly onLog?: (line: string) => void
  readonly pollEveryMs?: number
  /** Test seams of the component loader. */
  readonly loader?: LoaderSeams
}

export interface RunningNode {
  /** Resolves with the component's exit code once it ends. */
  readonly finished: Promise<number>
  readonly compileMs: number
  stop: () => void
}

const LOG_TAIL = 40
const defaultFetcher: Fetcher = async (url, signal) => await fetch(url, { signal })

function lineSink (onLine: (line: string) => void): OutputStream {
  let pending = ''
  const decoder = new TextDecoder()
  return new OutputStream(async (bytes) => {
    pending += decoder.decode(bytes, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
}

export async function startNode (config: SwarmNodeConfig, deps: NodeServiceDeps): Promise<RunningNode> {
  const { post } = deps
  try {
    await prepareDataDir(config.dataDir, config.apiPort)
  } catch (error) {
    post({ type: 'failed', stage: 'start', message: `could not prepare the data directory: ${describe(error)}` })
    throw error
  }
  const tail: string[] = []
  let logPeers: number | undefined
  const onLine = (line: string): void => {
    tail.push(line)
    if (tail.length > LOG_TAIL) tail.shift()
    logPeers = peerCountOfLog(line) ?? logPeers
    deps.onLog?.(line)
  }
  const imports = componentImports({
    fs: await createConfinedFs(config.dataDir),
    net: createNodeNet(config.apiPort, deps.net),
    preopens: { [GUEST_DATA_DIR]: '/orivon/app' },
    args: nodeArguments(),
    env: {},
    stdin: new InputStream(async () => new Uint8Array(0)),
    stdout: lineSink(onLine),
    stderr: lineSink(onLine)
  })
  let loaded
  try {
    loaded = await loadComponent(config.componentDir, config.componentName, imports, deps.loader)
  } catch (error) {
    post({ type: 'failed', stage: 'compile', message: describe(error) })
    throw error
  }

  deps.onLog?.(`compiled the component in ${String(Math.round(loaded.compileMs))} ms`)
  let stopped = false
  const finished = loaded.run().then(
    (code) => {
      if (!stopped) post({ type: 'failed', stage: 'run', message: `the node stopped with exit code ${String(code)}${tail.length > 0 ? `: ${tail.slice(-3).join(' | ')}` : ''}` })
      return code
    },
    (error: unknown) => {
      if (!stopped) post({ type: 'failed', stage: 'run', message: `the node trapped: ${describe(error)}` })
      return 1
    }
  )

  const stopWatching = watchReadiness({
    base: `http://127.0.0.1:${String(config.apiPort)}`,
    fetcher: deps.fetcher ?? defaultFetcher,
    post,
    logPeers: () => logPeers,
    everyMs: deps.pollEveryMs ?? 1_000
  })

  return {
    finished,
    compileMs: loaded.compileMs,
    stop: () => {
      stopped = true
      stopWatching()
    }
  }
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

