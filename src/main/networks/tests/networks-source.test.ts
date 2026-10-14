import { describe, expect, it, vi } from 'vitest'
import type { LocalNodeState } from '../../../protocols/local-node/protocol.js'
import type { NymState } from '../../route/nym-status.js'
import type { LightClientView } from '../../verifier/status-view.js'
import { createNetworksSource, isNetworkId, switchSetting } from '../networks-source.js'
import type { NetworksEnv, ProcessMetric } from '../networks-source.js'

interface Rig {
  readonly env: NetworksEnv
  readonly values: Record<string, unknown>
  readonly sets: Array<[string, unknown]>
  readonly emit: { setting: (key: string) => void, nodes: () => void }
  light: LightClientView
  ipfsState: LocalNodeState
  nymState: NymState
  metrics: ProcessMetric[]
  forced: boolean
}

function rig (): Rig {
  const values: Record<string, unknown> = { 'web3.lightClient': true, 'web3.ipfsSource': 'node', 'web3.swarmNode': true, 'network.nym.enabled': true, 'network.route.kind': 'nym' }
  const sets: Array<[string, unknown]> = []
  const settingListeners = new Set<(change: { key: string }) => void>()
  const nodeListeners = new Set<() => void>()
  const r = { light: { state: 'waiting', summary: '', checkpoint: '', about: '', endpoints: [] } as LightClientView, ipfsState: { state: 'off' } as LocalNodeState, nymState: { state: 'off' } as NymState, metrics: [] as ProcessMetric[], forced: false }
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { const own = (): void => { listener() }; listeners.add(own); return () => { listeners.delete(own) } }
  const env: NetworksEnv = {
    now: () => 5_000_000,
    settings: {
      get: (key) => values[key] as never,
      set: (key, value) => { sets.push([key, value]); values[key] = value; return { ok: true } },
      onChange: (listener) => { settingListeners.add(listener); return () => { settingListeners.delete(listener) } }
    },
    lightClient: { view: () => r.light, forcedOff: () => r.forced, process: () => ({ pid: 11, startedAt: 4_000_000 }), onChange: subscribe(nodeListeners) },
    ipfs: { state: () => r.ipfsState, processInfo: () => ({ pid: undefined, startedAt: 4_500_000 }), onChange: subscribe(nodeListeners) },
    swarm: { state: () => ({ state: 'off' }), processInfo: () => undefined, onChange: subscribe(nodeListeners) },
    traffic: (node) => node === 'ipfs-node' ? { active: 1, bytes: 2048 } : { active: 0, bytes: 0 },
    nym: { state: () => r.nymState, tunnels: () => ({ connecting: 0, ready: 2 }), processInfo: () => undefined, onChange: subscribe(nodeListeners) },
    metrics: () => r.metrics
  }
  return Object.assign(r, { env, values, sets, emit: { setting: (key: string) => { for (const listener of settingListeners) listener({ key }) }, nodes: () => { for (const listener of nodeListeners) listener() } } })
}

describe('the view the popup is drawn from', () => {
  it('matches a process to its card by the process id, and falls back to its service name when the supervisor has none', () => {
    const r = rig()
    r.light = { ...r.light, state: 'synced', block: 5, headAt: 4_990_000 }
    r.ipfsState = { state: 'ready', peers: 0 }
    r.nymState = { state: 'idle' }
    r.metrics = [
      { pid: 11, serviceName: 'Orivon verifier', memoryKb: 40_960, cpuPercent: 1.2 },
      { pid: 22, serviceName: 'Orivon IPFS node', memoryKb: 204_800, cpuPercent: undefined },
      { pid: 33, serviceName: 'Orivon Swarm node', memoryKb: 1, cpuPercent: 0 }
    ]
    const view = createNetworksSource(r.env).view()
    expect(view.cards[0]?.metrics).toContainEqual({ label: 'Memory', value: '40 MB' })
    expect(view.cards[0]?.metrics).toContainEqual({ label: 'CPU', value: '1%' })
    expect(view.cards[1]?.metrics).toContainEqual({ label: 'Memory', value: '200 MB' })
    expect(view.cards[1]?.metrics.map((metric) => metric.label)).not.toContain('CPU')
    expect(view.cards[1]?.metrics).toContainEqual({ label: 'Data read this session', value: '2.0 KB' })
    expect(view.cards[3]?.metrics).toEqual([{ label: 'Tunnels open', value: '2' }])
  })

  it('measures nothing for the dot', () => {
    const r = rig()
    const measured = vi.fn(() => [] as ProcessMetric[])
    const source = createNetworksSource({ ...r.env, metrics: measured })
    expect(source.dot()).toBe('none')
    expect(measured).not.toHaveBeenCalled()
    source.view()
    expect(measured).toHaveBeenCalledTimes(1)
  })
})

describe('the dot on a push', () => {
  it('is read from what the last change left, not built again by every push: the nodes are asked once until one changes', () => {
    const r = rig()
    const viewed = vi.fn(() => r.light)
    const source = createNetworksSource({ ...r.env, lightClient: { ...r.env.lightClient, view: viewed } })
    expect(source.dot()).toBe('none')
    source.dot()
    source.dot()
    expect(viewed).toHaveBeenCalledTimes(1)
    r.ipfsState = { state: 'failed', reason: 'it trapped' }
    r.emit.nodes()
    expect(source.dot()).toBe('red')
    expect(viewed).toHaveBeenCalledTimes(2)
  })

  it('follows a switch moved in Settings too', () => {
    const r = rig()
    r.ipfsState = { state: 'ready', peers: 0 }
    const source = createNetworksSource(r.env)
    expect(source.dot()).toBe('green')
    r.values['web3.ipfsSource'] = 'gateways'
    r.emit.setting('web3.ipfsSource')
    expect(source.dot()).toBe('none')
  })
})

describe('moving a card\'s switch', () => {
  it('writes the setting Settings uses for the same thing, and the value that means the switch\'s position', () => {
    expect(switchSetting('light-client', false)).toEqual({ key: 'web3.lightClient', value: false })
    expect(switchSetting('ipfs', true)).toEqual({ key: 'web3.ipfsSource', value: 'node' })
    expect(switchSetting('ipfs', false)).toEqual({ key: 'web3.ipfsSource', value: 'gateways' })
    expect(switchSetting('swarm', false)).toEqual({ key: 'web3.swarmNode', value: false })
    expect(switchSetting('nym', true)).toEqual({ key: 'network.nym.enabled', value: true })
  })

  it('writes it, and the next view shows the card off', () => {
    const r = rig()
    const source = createNetworksSource(r.env)
    expect(source.setSwitch('ipfs', false)).toBe(true)
    expect(r.sets).toEqual([['web3.ipfsSource', 'gateways']])
    expect(source.view().cards[1]).toMatchObject({ on: false, status: 'Off' })
  })

  it('refuses what is not a card or not on or off, writing nothing', () => {
    const r = rig()
    const source = createNetworksSource(r.env)
    for (const [id, on] of [['nope', true], [5, true], [undefined, false], ['ipfs', 'yes'], ['ipfs', 1], ['swarm', undefined]] as const) expect(source.setSwitch(id, on)).toBe(false)
    expect(r.sets).toEqual([])
  })

  it('refuses the light client while the run forces it off, and Nym while the tunnel is the person\'s own address', () => {
    const r = rig()
    r.forced = true
    r.values['network.route.kind'] = 'socks5'
    const source = createNetworksSource(r.env)
    expect(source.setSwitch('light-client', true)).toBe(false)
    expect(source.setSwitch('nym', false)).toBe(false)
    expect(r.sets).toEqual([])
  })

  it('reports a setting that refused the value', () => {
    const r = rig()
    const source = createNetworksSource({ ...r.env, settings: { ...r.env.settings, set: () => ({ ok: false, reason: 'invalid-value' }) } })
    expect(source.setSwitch('swarm', false)).toBe(false)
  })

  it('knows the four cards by id and nothing else', () => {
    expect(['light-client', 'ipfs', 'swarm', 'nym'].every(isNetworkId)).toBe(true)
    expect(isNetworkId('tor')).toBe(false)
  })
})

describe('what wakes a listener', () => {
  it('is any node changing and a setting a card shows changing, and no other setting', () => {
    const r = rig()
    const heard = vi.fn()
    const stop = createNetworksSource(r.env).onChange(heard)
    r.emit.nodes()
    expect(heard).toHaveBeenCalledTimes(4)
    heard.mockClear()
    r.emit.setting('web3.swarmNode')
    r.emit.setting('network.nym.enabled')
    r.emit.setting('toolbar.home')
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    heard.mockClear()
    r.emit.nodes()
    r.emit.setting('web3.lightClient')
    expect(heard).not.toHaveBeenCalled()
  })
})
