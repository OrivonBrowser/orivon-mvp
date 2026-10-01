import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { tasksDomain } from '../tasks-domain.js'

const CALLER = { page: 'tasks', contents: {} } as unknown as InternalCaller

function setup (): { call: (command: unknown) => unknown, end: ReturnType<typeof vi.fn>, focus: ReturnType<typeof vi.fn> } {
  const end = vi.fn(() => true)
  const focus = vi.fn(() => true)
  const domain = tasksDomain({ list: () => ({ rows: [], totals: { memoryKb: 0, cpu: null } }), end, focus })
  return { call: (command) => domain.handle(command, CALLER), end, focus }
}

describe('the tasks domain', () => {
  it('is for the task manager page alone', () => {
    expect(setup() && tasksDomain({ list: () => ({ rows: [], totals: { memoryKb: 0, cpu: null } }), end: () => false, focus: () => false }).pages).toEqual(['tasks'])
  })

  it('answers the list', () => {
    expect(setup().call({ type: 'list' })).toEqual({ rows: [], totals: { memoryKb: 0, cpu: null } })
  })

  it('hands the process number to the ending function unchecked, which decides against its own fresh reading', () => {
    const { call, end } = setup()
    expect(call({ type: 'end', pid: 77 })).toEqual({ ok: true })
    expect(call({ type: 'end', pid: 'x' })).toEqual({ ok: true })
    expect(end.mock.calls).toEqual([[77], ['x']])
  })

  it('reports a refusal from the ending function', () => {
    const domain = tasksDomain({ list: () => ({ rows: [], totals: { memoryKb: 0, cpu: null } }), end: () => false, focus: () => false })
    expect(domain.handle({ type: 'end', pid: 1 }, CALLER)).toEqual({ ok: false })
    expect(domain.handle({ type: 'focus', tabId: 'nope' }, CALLER)).toEqual({ ok: false })
  })

  it('passes a tab id and the caller to focus', () => {
    const { call, focus } = setup()
    call({ type: 'focus', tabId: 'tab-2' })
    expect(focus).toHaveBeenCalledWith('tab-2', CALLER)
  })

  it('ignores a command it does not know, and a request that is not an object', () => {
    const { call, end, focus } = setup()
    expect(call({ type: 'kill', pid: 1 })).toBeUndefined()
    expect(call('end')).toBeUndefined()
    expect(call(null)).toBeUndefined()
    expect(end).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
