import { describe, expect, it } from 'vitest'
import { buildTasks, canEnd, labelFor, totalsOf } from '../tasks-model.js'
import type { ContentsInput, MetricInput } from '../tasks-model.js'

const metric = (pid: number, type: string, memoryKb = 1000, cpu: number | null = 1, extra: Partial<MetricInput> = {}): MetricInput => ({ pid, type, memoryKb, cpu, ...extra })
const page = (pid: number, kind: ContentsInput['kind'], name: string, tabId?: string): ContentsInput => ({ pid, kind, name, tabId })

const find = (rows: ReturnType<typeof buildTasks>, pid: number) => rows.find((row) => row.pid === pid)

describe('the task list', () => {
  it('names the browser and the graphics process, and marks neither endable', () => {
    const rows = buildTasks([metric(1, 'Browser'), metric(2, 'GPU')], [])
    expect(find(rows, 1)).toMatchObject({ kind: 'browser', name: 'Browser', endable: false })
    expect(find(rows, 2)).toMatchObject({ kind: 'gpu', name: 'GPU process', endable: false })
  })

  it('joins a tab to its process by process id, with its title, favicon and memory', () => {
    const rows = buildTasks([metric(10, 'Tab', 182_000, 3.1)], [{ pid: 10, kind: 'tab', name: 'Example', tabId: 'tab-3', favicon: 'data:x' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Tab: Example', kind: 'tab', tabId: 'tab-3', favicon: 'data:x', memoryKb: 182_000, cpu: 3.1, endable: true, pid: 10 })
  })

  it('names a tab with no title as a new tab', () => {
    expect(labelFor('tab', '')).toBe('Tab: New tab')
  })

  it('names an app, an extension and an internal page as such', () => {
    const rows = buildTasks(
      [metric(10, 'Tab'), metric(11, 'Tab'), metric(12, 'Tab')],
      [page(10, 'app', 'mail.example', 't1'), page(11, 'extension', 'Ad filter'), page(12, 'internal', 'Settings', 't2')]
    )
    expect(find(rows, 10)?.name).toBe('App: mail.example')
    expect(find(rows, 11)?.name).toBe('Extension: Ad filter')
    expect(find(rows, 12)?.name).toBe('Internal page: Settings')
  })

  it('ends a tab and an app, and not an extension, an internal page or one of Orivon\'s own views', () => {
    const rows = buildTasks(
      [metric(10, 'Tab'), metric(11, 'Tab'), metric(12, 'Tab'), metric(13, 'Tab'), metric(14, 'Tab')],
      [page(10, 'tab', 'a', 't1'), page(11, 'app', 'b', 't2'), page(12, 'extension', 'c'), page(13, 'internal', 'Settings', 't3'), page(14, 'shell', '')]
    )
    expect([10, 11, 12, 13, 14].map((pid) => find(rows, pid)?.endable)).toEqual([true, true, false, false, false])
  })

  it('names the overlay and the window interface', () => {
    const rows = buildTasks([metric(20, 'Tab'), metric(21, 'Tab')], [page(20, 'overlay', ''), page(21, 'shell', '')])
    expect(find(rows, 20)?.name).toBe('Overlay')
    expect(find(rows, 21)?.name).toBe('Orivon window')
  })

  it('lists pages sharing one process under the first, with a person\'s page named before Orivon\'s', () => {
    const rows = buildTasks([metric(30, 'Tab')], [page(30, 'shell', ''), page(30, 'tab', 'First', 't1'), page(30, 'tab', 'Second', 't2')])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Tab: First')
    expect(rows[0]?.children.map((child) => child.name)).toEqual(['Tab: Second', 'Orivon window'])
    // A process that also hosts Orivon's own view is never ended.
    expect(rows[0]?.endable).toBe(false)
  })

  it('lets a process shared by tabs alone be ended', () => {
    const rows = buildTasks([metric(30, 'Tab')], [page(30, 'tab', 'One', 't1'), page(30, 'tab', 'Two', 't2')])
    expect(rows[0]).toMatchObject({ endable: true })
    expect(rows[0]?.children).toHaveLength(1)
  })

  it('names a utility process by its service and never lets it be ended: the network, storage and verifier services are not a tab\'s', () => {
    const rows = buildTasks([metric(40, 'Utility', 500, 0, { name: 'Network Service', serviceName: 'network.mojom.NetworkService' }), metric(41, 'Utility', 500, 0, { serviceName: 'audio.mojom.AudioService' })], [])
    expect(find(rows, 40)).toMatchObject({ name: 'Utility: Network Service', kind: 'utility', endable: false })
    expect(find(rows, 41)?.name).toBe('Utility: audio.mojom.AudioService')
  })

  it('names what it cannot match as Other, from its type or service, and never ends it', () => {
    const rows = buildTasks([metric(50, 'Tab'), metric(51, 'Zygote'), metric(52, 'Unknown', 1, 1, { name: 'Odd helper' })], [])
    expect(find(rows, 50)).toMatchObject({ name: 'Other', endable: false })
    expect(find(rows, 51)).toMatchObject({ name: 'Zygote', endable: false })
    expect(find(rows, 52)).toMatchObject({ name: 'Odd helper', endable: false })
  })

  it('lists a tab with no process as not running, without memory, and leaves Orivon\'s own pages out', () => {
    const rows = buildTasks([metric(1, 'Browser')], [page(0, 'tab', 'Gone', 't9'), page(0, 'shell', ''), page(999, 'app', 'stale.example', 't8')])
    expect(rows.map((row) => row.name)).toEqual(['Browser', 'Tab: Gone (not running)', 'App: stale.example (not running)'])
    expect(rows[1]).toMatchObject({ pid: 0, memoryKb: null, cpu: null, endable: false, tabId: 't9' })
  })

  it('keeps a first cpu reading as unknown', () => {
    expect(find(buildTasks([metric(1, 'Browser', 10, null)], []), 1)?.cpu).toBeNull()
  })
})

describe('the totals', () => {
  it('adds memory and processor use, and leaves the processor unknown until one reading exists', () => {
    expect(totalsOf(buildTasks([metric(1, 'Browser', 100, 1.5), metric(2, 'GPU', 200, 2)], []))).toEqual({ memoryKb: 300, cpu: 3.5 })
    expect(totalsOf(buildTasks([metric(1, 'Browser', 100, null)], []))).toEqual({ memoryKb: 100, cpu: null })
  })

  it('does not count a page with no process', () => {
    expect(totalsOf(buildTasks([metric(1, 'Browser', 100, 1)], [page(0, 'tab', 'x', 't')])).memoryKb).toBe(100)
  })
})

describe('what may be ended', () => {
  const rows = buildTasks(
    [metric(1, 'Browser'), metric(2, 'GPU'), metric(10, 'Tab'), metric(40, 'Utility', 1, 0, { name: 'Audio Service' })],
    [page(10, 'tab', 'a', 't1')]
  )

  it('allows a tab that is in the fresh reading, and refuses a utility process', () => {
    expect(canEnd(rows, 10)).toBe(true)
    expect(canEnd(rows, 40)).toBe(false)
  })

  it('refuses the browser, the graphics process, and a process id that is gone', () => {
    expect(canEnd(rows, 1)).toBe(false)
    expect(canEnd(rows, 2)).toBe(false)
    expect(canEnd(rows, 4242)).toBe(false)
  })

  it('refuses anything that is not a positive whole number', () => {
    for (const pid of ['10', null, undefined, 0, -10, 10.5, NaN, {}, [10]]) expect(canEnd(rows, pid), String(pid)).toBe(false)
  })

  it('refuses a page with no process', () => {
    expect(canEnd(buildTasks([], [page(0, 'tab', 'x', 't')]), 0)).toBe(false)
  })
})
