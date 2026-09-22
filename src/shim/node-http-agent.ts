// http.Agent / https.Agent and their globalAgent instances, so code that
// constructs, subclasses or passes one works. The shape is Node's; the
// behaviour is not pooling. Every request opens its own connection and
// closes it after the response (node-http-client.ts), whatever agent it
// was given, so keepAlive, maxSockets and friends are accepted and stored,
// never enforced.

import { EventEmitter } from 'events'

export interface AgentOptions {
  keepAlive?: boolean
  keepAliveMsecs?: number
  maxSockets?: number
  maxTotalSockets?: number
  maxFreeSockets?: number
  scheduling?: 'fifo' | 'lifo'
  timeout?: number
  [key: string]: unknown
}

export class Agent extends EventEmitter {
  static defaultMaxSockets = Infinity

  defaultPort = 80
  protocol = 'http:'
  readonly options: AgentOptions
  keepAlive: boolean
  keepAliveMsecs: number
  maxSockets: number
  maxTotalSockets: number
  maxFreeSockets: number
  scheduling: 'fifo' | 'lifo'
  /** Always empty: no socket is ever pooled here. */
  readonly sockets: Record<string, unknown[]> = {}
  readonly freeSockets: Record<string, unknown[]> = {}
  readonly requests: Record<string, unknown[]> = {}

  constructor (options: AgentOptions = {}) {
    super()
    this.options = { ...options }
    this.keepAlive = options.keepAlive ?? false
    this.keepAliveMsecs = options.keepAliveMsecs ?? 1000
    this.maxSockets = options.maxSockets ?? Agent.defaultMaxSockets
    this.maxTotalSockets = options.maxTotalSockets ?? Infinity
    this.maxFreeSockets = options.maxFreeSockets ?? 256
    this.scheduling = options.scheduling ?? 'lifo'
  }

  /** Node's pool key; kept so a subclass overriding it still type-checks against the same contract. */
  getName (options: { host?: string, port?: number | string, localAddress?: string, family?: number } = {}): string {
    let name = `${options.host ?? 'localhost'}:`
    if (options.port !== undefined) name += String(options.port)
    name += ':'
    if (options.localAddress !== undefined) name += options.localAddress
    if (options.family === 4 || options.family === 6) name += `:${options.family}`
    return name
  }

  destroy (): void {}
}

export class HttpsAgent extends Agent {
  constructor (options: AgentOptions = {}) {
    super(options)
    this.defaultPort = 443
    this.protocol = 'https:'
  }
}

export const globalAgent = new Agent()
export const httpsGlobalAgent = new HttpsAgent()
