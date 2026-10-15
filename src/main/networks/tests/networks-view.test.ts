import { describe, expect, it } from 'vitest'
import { buildNetworksView, bytesWords, dotOf, processMetrics } from '../networks-view.js'
import type { NetworkFacts } from '../networks-view.js'
import type { LightClientView } from '../../verifier/status-view.js'

const NOW = 1_000_000_000_000
const VIEW = (over: Partial<LightClientView> = {}): LightClientView => ({ state: 'waiting', summary: 'On, and waiting.', checkpoint: '', about: '', endpoints: [], ...over })

function facts (over: Partial<NetworkFacts> = {}): NetworkFacts {
  return {
    now: NOW,
    lightClient: { view: VIEW(), enabled: true, forcedOff: false },
    ipfs: { enabled: true, state: { state: 'off' }, traffic: { active: 0, bytes: 0 } },
    swarm: { enabled: true, state: { state: 'off' }, traffic: { active: 0, bytes: 0 } },
    nym: { enabled: true, inUse: true, state: { state: 'off' }, tunnels: { connecting: 0, ready: 0 } },
    ...over
  }
}

const card = (view: ReturnType<typeof buildNetworksView>, id: string) => view.cards.find((candidate) => candidate.id === id)

describe('the four cards', () => {
  it('are the light client, the IPFS node, the Swarm node and the Nym tunnel, in that order', () => {
    expect(buildNetworksView(facts()).cards.map((entry) => entry.name)).toEqual(['Ethereum light client', 'IPFS node', 'Swarm node', 'Nym tunnel'])
  })

  it('say Asleep for a node that is on and not needed yet, with how it wakes, and show no figures', () => {
    const view = buildNetworksView(facts())
    for (const id of ['light-client', 'ipfs', 'swarm']) {
      expect(card(view, id)).toMatchObject({ status: 'Asleep', tone: 'idle', note: 'Asleep: it starts when a page needs it.', metrics: [] })
    }
    expect(card(view, 'nym')).toMatchObject({ status: 'Asleep', note: expect.stringContaining('starts when an app or website') as string })
    expect(view.dot).toBe('none')
  })
})

describe('the Ethereum light client card', () => {
  it('shows the verified block, how old it is and the checkpoint while it follows the chain, with its process', () => {
    const view = buildNetworksView(facts({ lightClient: { view: VIEW({ state: 'synced', block: 21_000_123, headAt: NOW - 60_000, checkpointAgeSeconds: 5 * 3600 }), enabled: true, forcedOff: false, process: { memoryKb: 51_200, cpuPercent: 2.4, startedAt: NOW - 125_000 } } }))
    expect(card(view, 'light-client')).toMatchObject({ status: 'Running', tone: 'ok', on: true })
    expect(card(view, 'light-client')?.metrics).toEqual([
      { label: 'Latest verified block', value: '21,000,123' },
      { label: 'Block produced', value: '1 minute ago' },
      { label: 'Checkpoint', value: '5 hours old' },
      { label: 'Memory', value: '50 MB' },
      { label: 'CPU', value: '2%' },
      { label: 'Running for', value: '2 min' }
    ])
  })

  it('says Syncing while it catches up and Starting before that, both counting as busy', () => {
    expect(card(buildNetworksView(facts({ lightClient: { view: VIEW({ state: 'syncing' }), enabled: true, forcedOff: false } })), 'light-client')).toMatchObject({ status: 'Syncing', tone: 'busy' })
    expect(card(buildNetworksView(facts({ lightClient: { view: VIEW({ state: 'starting' }), enabled: true, forcedOff: false } })), 'light-client')).toMatchObject({ status: 'Starting', tone: 'busy' })
  })

  it('says Not running with the reason when it failed or its host is down', () => {
    for (const state of ['failed', 'down'] as const) {
      expect(card(buildNetworksView(facts({ lightClient: { view: VIEW({ state, summary: 'Failed: no route.' }), enabled: true, forcedOff: false } })), 'light-client')).toMatchObject({ status: 'Not running', tone: 'bad', note: 'Failed: no route.' })
    }
  })

  it('is Off with its switch off when the person switched it off, and Off with the switch fixed when the run forces it', () => {
    expect(card(buildNetworksView(facts({ lightClient: { view: VIEW({ state: 'off' }), enabled: false, forcedOff: false } })), 'light-client')).toMatchObject({ status: 'Off', on: false, disabled: false })
    expect(card(buildNetworksView(facts({ lightClient: { view: VIEW({ state: 'off' }), enabled: true, forcedOff: true } })), 'light-client')).toMatchObject({ status: 'Off', on: false, disabled: true, note: expect.stringContaining('started with the light client switched off') as string })
  })
})

describe('the IPFS and Swarm cards', () => {
  it('show requests in flight, data read and the process for a node that is ready, and peers for Swarm only', () => {
    const view = buildNetworksView(facts({
      ipfs: { enabled: true, state: { state: 'ready', peers: 0 }, traffic: { active: 2, bytes: 3 * 1024 * 1024 }, process: { memoryKb: 100 * 1024, startedAt: NOW - 30_000 } },
      swarm: { enabled: true, state: { state: 'ready', peers: 17 }, traffic: { active: 0, bytes: 900 } }
    }))
    expect(card(view, 'ipfs')).toMatchObject({ status: 'Running', tone: 'ok' })
    expect(card(view, 'ipfs')?.metrics).toEqual([
      { label: 'Requests now', value: '2' },
      { label: 'Data read this session', value: '3.0 MB' },
      { label: 'Memory', value: '100 MB' },
      { label: 'Running for', value: '30 s' }
    ])
    expect(card(view, 'swarm')?.metrics).toEqual([
      { label: 'Peers', value: '17' },
      { label: 'Requests now', value: '0' },
      { label: 'Data read this session', value: '900 bytes' }
    ])
  })

  it('says Starting while the node finds its peers, and Not running with the reason when it failed', () => {
    expect(card(buildNetworksView(facts({ swarm: { enabled: true, state: { state: 'starting', peers: 2 }, traffic: { active: 0, bytes: 0 } } })), 'swarm')).toMatchObject({ status: 'Starting', tone: 'busy' })
    expect(card(buildNetworksView(facts({ ipfs: { enabled: true, state: { state: 'failed', reason: 'it trapped' }, traffic: { active: 0, bytes: 0 } } })), 'ipfs')).toMatchObject({ status: 'Not running', tone: 'bad', note: 'it trapped.' })
  })

  it('says Off with the reason when the node is off for one (a tunnel for the whole browser, say), without counting it as failed', () => {
    const view = buildNetworksView(facts({ ipfs: { enabled: true, state: { state: 'off', reason: 'all of Orivon\'s traffic goes through the tunnel' }, traffic: { active: 0, bytes: 0 } } }))
    expect(card(view, 'ipfs')).toMatchObject({ status: 'Off', tone: 'idle', note: 'all of Orivon\'s traffic goes through the tunnel.' })
    expect(view.dot).toBe('none')
  })

  it('says what a switched-off node means for the person', () => {
    const view = buildNetworksView(facts({ ipfs: { enabled: false, state: { state: 'off' }, traffic: { active: 0, bytes: 0 } }, swarm: { enabled: false, state: { state: 'off' }, traffic: { active: 0, bytes: 0 } } }))
    expect(card(view, 'ipfs')).toMatchObject({ status: 'Off', on: false, note: expect.stringContaining('public gateways') as string })
    expect(card(view, 'swarm')).toMatchObject({ status: 'Off', on: false, note: expect.stringContaining('says Swarm is off') as string })
  })
})

describe('the Nym card', () => {
  it('counts tunnels open and connecting while it runs', () => {
    const view = buildNetworksView(facts({ nym: { enabled: true, inUse: true, state: { state: 'connecting' }, tunnels: { connecting: 1, ready: 3 } } }))
    expect(card(view, 'nym')).toMatchObject({ status: 'Starting', tone: 'busy' })
    expect(card(view, 'nym')?.metrics).toEqual([{ label: 'Tunnels open', value: '3' }, { label: 'Tunnels connecting', value: '1' }])
  })

  it('says Running with no tunnel open when only the host is up', () => {
    expect(card(buildNetworksView(facts({ nym: { enabled: true, inUse: true, state: { state: 'idle' }, tunnels: { connecting: 0, ready: 0 } } })), 'nym')).toMatchObject({ status: 'Running', note: 'No tunnel is open now.' })
  })

  it('is Off and says apps are stopped, not sent direct, when the person switched it off', () => {
    expect(card(buildNetworksView(facts({ nym: { enabled: false, inUse: true, state: { state: 'unavailable', cause: 'other', reason: 'Nym is switched off' }, tunnels: { connecting: 0, ready: 0 } } })), 'nym')).toMatchObject({ status: 'Off', on: false, disabled: false, note: expect.stringContaining('not sent directly') as string })
  })

  it('says Nym is not in use, with the switch fixed, while the tunnel is the person\'s own SOCKS5 address', () => {
    expect(card(buildNetworksView(facts({ nym: { enabled: true, inUse: false, state: { state: 'off' }, tunnels: { connecting: 0, ready: 0 } } })), 'nym')).toMatchObject({ status: 'Off', disabled: true, note: expect.stringContaining('not in use') as string })
  })
})

describe('the dot on the toolbar button', () => {
  const card = (on: boolean, tone: 'ok' | 'busy' | 'bad' | 'idle'): { on: boolean, tone: 'ok' | 'busy' | 'bad' | 'idle' } => ({ on, tone })

  it('is none when nothing runs, green when a node runs, amber while one starts or syncs, red when one failed', () => {
    expect(dotOf([card(true, 'idle'), card(true, 'idle')])).toBe('none')
    expect(dotOf([card(true, 'ok'), card(true, 'idle')])).toBe('green')
    expect(dotOf([card(true, 'ok'), card(true, 'busy')])).toBe('amber')
    expect(dotOf([card(true, 'ok'), card(true, 'busy'), card(true, 'bad')])).toBe('red')
  })

  it('ignores a node the person switched off, whatever it says', () => {
    expect(dotOf([card(false, 'bad'), card(true, 'ok')])).toBe('green')
    expect(dotOf([card(false, 'ok')])).toBe('none')
  })

  it('is read from the cards of a view', () => {
    expect(buildNetworksView(facts({ ipfs: { enabled: true, state: { state: 'failed', reason: 'x' }, traffic: { active: 0, bytes: 0 } } })).dot).toBe('red')
  })
})

describe('the words for sizes and processes', () => {
  it('reads sizes as a person would', () => {
    expect(bytesWords(0)).toBe('0 bytes')
    expect(bytesWords(1536)).toBe('1.5 KB')
    expect(bytesWords(15 * 1024)).toBe('15 KB')
    expect(bytesWords(1_048_300)).toBe('1.0 MB')
    expect(bytesWords(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('shows only the figures known of a process, and none for a process that does not run', () => {
    expect(processMetrics(undefined, NOW)).toEqual([])
    expect(processMetrics({ memoryKb: 2048 }, NOW)).toEqual([{ label: 'Memory', value: '2.0 MB' }])
    expect(processMetrics({ startedAt: NOW - 3 * 3600_000 - 5 * 60_000 }, NOW)).toEqual([{ label: 'Running for', value: '3 h 5 min' }])
  })
})

describe('a node while the whole browser is on a tunnel', () => {
  const through = (over: Partial<NetworkFacts['ipfs']>): NetworkFacts['ipfs'] => ({ enabled: true, state: { state: 'off' }, traffic: { active: 0, bytes: 0 }, through: 'Nym', ...over })

  it('says it runs through Nym and why that is slower, in plain words', () => {
    const view = buildNetworksView(facts({ ipfs: through({ state: { state: 'ready', peers: 0 } }) }))
    expect(card(view, 'ipfs')).toMatchObject({ status: 'Running', tone: 'ok', note: expect.stringMatching(/^Connected through Nym: .*not your address\. This is slower than a direct connection\.$/) as string })
  })

  it('says it starts through Nym and takes a little while, and that a sleeping node will connect through it', () => {
    expect(card(buildNetworksView(facts({ ipfs: through({ state: { state: 'starting' } }) })), 'ipfs')).toMatchObject({ status: 'Starting', note: 'Starting through Nym: the first connection takes a little while.' })
    expect(card(buildNetworksView(facts({ swarm: through({}) })), 'swarm')).toMatchObject({ status: 'Asleep', note: 'Asleep: it starts when a page needs it. It then connects through Nym.' })
  })

  it('names the person\'s own tunnel when that is the one', () => {
    const view = buildNetworksView(facts({ ipfs: through({ through: 'your tunnel', state: { state: 'ready', peers: 0 } }) }))
    expect(card(view, 'ipfs')?.note).toMatch(/^Connected through your tunnel: /)
  })

  it('keeps the reason it is off or failed, and says nothing of a tunnel when the node connects directly', () => {
    expect(card(buildNetworksView(facts({ ipfs: through({ state: { state: 'off', reason: 'the tunnel cannot carry it' } }) })), 'ipfs')).toMatchObject({ status: 'Off', note: 'the tunnel cannot carry it.' })
    expect(card(buildNetworksView(facts({ ipfs: through({ state: { state: 'failed', reason: 'it stopped' } }) })), 'ipfs')).toMatchObject({ status: 'Not running', note: 'it stopped.' })
    const direct = { enabled: true, state: { state: 'ready', peers: 0 } as const, traffic: { active: 0, bytes: 0 } }
    expect(card(buildNetworksView(facts({ ipfs: direct })), 'ipfs')?.note).toBeUndefined()
  })
})
