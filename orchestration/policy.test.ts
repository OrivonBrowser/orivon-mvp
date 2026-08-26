import { describe, expect, it } from 'vitest'
import { ingestAnswers, reconcile, selectWork } from './policy.mjs'

// The L3 policy, in strict order, is the contract this file encodes:
//   1. unblocked work
//   2. only then, the low-value backlog
//   3. only then, a blocked task on a labelled assumption
//   4. only then, idle
//
// Owner decision 2026-08-26. Getting the ORDER wrong is the expensive failure:
// a loop that guesses while real work was available burns unattended compute on
// branches that may be thrown away.

type Task = Record<string, unknown>

const task = (id: string, over: Task = {}): Task => ({
  id,
  title: id,
  category: 'broker',
  model: 'sonnet',
  stream: 'broker',
  paths: [`src/${id}/**`],
  dependsOn: [],
  lowValue: false,
  status: 'todo',
  branch: null,
  baseBranch: 'main',
  pr: null,
  blockedOn: [],
  assumption: null,
  attempts: 0,
  ...over
})

const board = (tasks: Task[]): Record<string, unknown> => ({ tasks, questions: [], cycle: 1 })
const control = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ globalStop: false, pausedCategories: [], ...over })

const opts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  maxConcurrent: 3,
  maxAssumptions: 2,
  maxStackDepth: 4,
  ...over
})

const ids = (result: { dispatch: Array<{ task: { id: string } }> }): string[] =>
  result.dispatch.map((d) => d.task.id)

describe('selectWork', () => {
  describe('stop and pause', () => {
    it('dispatches nothing when globally stopped', () => {
      const r = selectWork({ board: board([task('a')]), control: control({ globalStop: true }), ...opts() })
      expect(r.dispatch).toEqual([])
      expect(r.idle).toBe(true)
      expect(r.reason).toMatch(/stop/i)
    })

    it('never dispatches a task in a paused category', () => {
      const b = board([task('ui-1', { category: 'browser-ui' })])
      const r = selectWork({ board: b, control: control({ pausedCategories: ['browser-ui'] }), ...opts() })
      expect(r.dispatch).toEqual([])
    })

    it('keeps dispatching other categories while one is paused', () => {
      const b = board([task('ui-1', { category: 'browser-ui' }), task('brk-1')])
      const r = selectWork({ board: b, control: control({ pausedCategories: ['browser-ui'] }), ...opts() })
      expect(ids(r)).toEqual(['brk-1'])
    })
  })

  describe('ordering and concurrency', () => {
    it('dispatches in catalogue order, which is critical-path order', () => {
      const b = board([task('first'), task('second'), task('third')])
      expect(ids(selectWork({ board: b, control: control(), ...opts() }))).toEqual(['first', 'second', 'third'])
    })

    it('never exceeds maxConcurrent', () => {
      const b = board([task('a'), task('b'), task('c'), task('d')])
      expect(selectWork({ board: b, control: control(), ...opts({ maxConcurrent: 2 }) }).dispatch).toHaveLength(2)
    })

    it('counts already-running tasks against maxConcurrent', () => {
      const b = board([task('running', { status: 'running' }), task('a'), task('b')])
      expect(ids(selectWork({ board: b, control: control(), ...opts({ maxConcurrent: 2 }) }))).toEqual(['a'])
    })

    it('does not redispatch a task that is already running or has a PR open', () => {
      const b = board([task('a', { status: 'running' }), task('b', { status: 'pr-open' }), task('c', { status: 'merged' })])
      expect(selectWork({ board: b, control: control(), ...opts() }).dispatch).toEqual([])
    })

    it('never dispatches two tasks that declare overlapping paths', () => {
      const b = board([
        task('a', { paths: ['src/broker/**'] }),
        task('b', { paths: ['src/broker/policy/**'] })
      ])
      expect(ids(selectWork({ board: b, control: control(), ...opts() }))).toEqual(['a'])
    })
  })

  describe('dependencies and stacking', () => {
    it('dispatches a task whose dependency is merged, based on main', () => {
      const b = board([task('dep', { status: 'merged' }), task('child', { dependsOn: ['dep'] })])
      const r = selectWork({ board: b, control: control(), ...opts() })
      expect(ids(r)).toEqual(['child'])
      expect(r.dispatch[0]?.baseBranch).toBe('main')
    })

    // Owner chose "nothing merges without me", so waiting for a merge would
    // stall everything. Stacking is what keeps work flowing.
    it('stacks on a dependency that has an open PR, rather than waiting', () => {
      const b = board([
        task('dep', { status: 'pr-open', branch: 'stream/dep', pr: 7 }),
        task('child', { dependsOn: ['dep'] })
      ])
      const r = selectWork({ board: b, control: control(), ...opts() })
      expect(ids(r)).toEqual(['child'])
      expect(r.dispatch[0]?.baseBranch).toBe('stream/dep')
      expect(r.dispatch[0]?.stackDepth).toBe(1)
    })

    it('cannot stack on a dependency that has no branch yet', () => {
      const b = board([task('dep', { status: 'running' }), task('child', { dependsOn: ['dep'] })])
      expect(selectWork({ board: b, control: control(), ...opts() }).dispatch).toEqual([])
    })

    it('refuses to stack deeper than maxStackDepth', () => {
      const b = board([
        task('d0', { status: 'pr-open', branch: 'stream/d0', pr: 1 }),
        task('d1', { status: 'pr-open', branch: 'stream/d1', pr: 2, dependsOn: ['d0'] }),
        task('d2', { dependsOn: ['d1'] })
      ])
      expect(selectWork({ board: b, control: control(), ...opts({ maxStackDepth: 2 }) }).dispatch).toEqual([])
    })

    it('prefers an independent task over one at the stack-depth limit', () => {
      const b = board([
        task('d0', { status: 'pr-open', branch: 'stream/d0', pr: 1 }),
        task('deep', { dependsOn: ['d0'] }),
        task('independent', { paths: ['src/other/**'] })
      ])
      const r = selectWork({ board: b, control: control(), ...opts({ maxStackDepth: 1 }) })
      expect(ids(r)).toEqual(['independent'])
    })
  })

  describe('blocked and exhausted tasks', () => {
    // Deliberately phrased "while other work exists": a task blocked on a
    // question is NOT permanently undispatchable -- under L3 it is the last
    // resort, dispatched on a labelled assumption once nothing else remains.
    // See "the L3 fallback order" below.
    it('does not dispatch a blocked task while unblocked work exists', () => {
      const b = board([task('a', { blockedOn: ['q-1'] }), task('b', { paths: ['src/b/**'] })])
      expect(ids(selectWork({ board: b, control: control(), ...opts() }))).toEqual(['b'])
    })

    it('does not dispatch a task that has failed three times', () => {
      const b = board([task('a', { attempts: 3 })])
      expect(selectWork({ board: b, control: control(), ...opts() }).dispatch).toEqual([])
    })

    it('still dispatches a task that has failed twice', () => {
      const b = board([task('a', { attempts: 2 })])
      expect(ids(selectWork({ board: b, control: control(), ...opts() }))).toEqual(['a'])
    })
  })

  describe('the L3 fallback order', () => {
    it('prefers real work over the low-value backlog', () => {
      const b = board([task('chore', { lowValue: true, category: 'docs' }), task('real')])
      expect(ids(selectWork({ board: b, control: control(), ...opts({ maxConcurrent: 1 }) }))).toEqual(['real'])
    })

    it('falls back to the low-value backlog when nothing else is available', () => {
      const b = board([task('blocked', { blockedOn: ['q-1'] }), task('chore', { lowValue: true, category: 'docs' })])
      const r = selectWork({ board: b, control: control(), ...opts() })
      expect(ids(r)).toEqual(['chore'])
      expect(r.reason).toMatch(/low-value|backlog/i)
    })

    // The heart of L3: guessing is the LAST resort, never the second.
    it('does NOT guess while low-value work remains', () => {
      const b = board([
        task('blocked', { blockedOn: ['q-1'] }),
        task('chore', { lowValue: true, category: 'docs' })
      ])
      const r = selectWork({ board: b, control: control(), ...opts() })
      expect(r.dispatch.every((d) => d.assumption === null)).toBe(true)
    })

    it('proceeds on an assumption only when nothing else is left', () => {
      const b = board([task('blocked', { blockedOn: ['q-1'] })])
      const r = selectWork({ board: b, control: control(), ...opts() })
      expect(ids(r)).toEqual(['blocked'])
      expect(r.dispatch[0]?.assumption).toBe('q-1')
      expect(r.reason).toMatch(/assumption/i)
    })

    it('never exceeds maxAssumptions open at once', () => {
      const b = board([
        task('running-assumed', { status: 'running', assumption: 'q-9' }),
        task('blocked-1', { blockedOn: ['q-1'] }),
        task('blocked-2', { blockedOn: ['q-2'], paths: ['src/x/**'] })
      ])
      const r = selectWork({ board: b, control: control(), ...opts({ maxAssumptions: 2 }) })
      expect(r.dispatch).toHaveLength(1)
    })

    it('idles when every avenue is exhausted', () => {
      const b = board([task('done', { status: 'merged' })])
      const r = selectWork({ board: b, control: control(), ...opts() })
      expect(r.dispatch).toEqual([])
      expect(r.idle).toBe(true)
    })

    it('always explains itself', () => {
      const b = board([task('a')])
      expect(selectWork({ board: b, control: control(), ...opts() }).reason.length).toBeGreaterThan(0)
    })
  })
})

describe('ingestAnswers', () => {
  it('unblocks a task whose question was answered', () => {
    const b = board([task('a', { blockedOn: ['q-1'] })])
    const { board: next } = ingestAnswers(b, [{ id: 'q-1', answer: 'yes' }])
    expect((next.tasks as Task[])[0]?.blockedOn).toEqual([])
  })

  it('leaves a task blocked on its other unanswered questions', () => {
    const b = board([task('a', { blockedOn: ['q-1', 'q-2'] })])
    const { board: next } = ingestAnswers(b, [{ id: 'q-1', answer: 'yes' }])
    expect((next.tasks as Task[])[0]?.blockedOn).toEqual(['q-2'])
  })

  // Otherwise a branch built on a guess the owner has now contradicted gets
  // quietly kept, and its PR looks as legitimate as any other.
  it('invalidates a running task whose assumption the answer contradicts', () => {
    const b = board([task('a', { status: 'running', assumption: 'q-1', assumedAnswer: 'yes' })])
    const { board: next, invalidated } = ingestAnswers(b, [{ id: 'q-1', answer: 'no' }])
    expect(invalidated.map((t: Task) => t.id)).toEqual(['a'])
    expect((next.tasks as Task[])[0]?.status).toBe('todo')
    expect((next.tasks as Task[])[0]?.assumption).toBeNull()
  })

  it('keeps a running task whose assumption the answer confirms', () => {
    const b = board([task('a', { status: 'running', assumption: 'q-1', assumedAnswer: 'yes' })])
    const { board: next, invalidated } = ingestAnswers(b, [{ id: 'q-1', answer: 'yes' }])
    expect(invalidated).toEqual([])
    expect((next.tasks as Task[])[0]?.status).toBe('running')
  })

  it('is a no-op with no answers', () => {
    const b = board([task('a', { blockedOn: ['q-1'] })])
    expect(ingestAnswers(b, []).board).toEqual(b)
  })
})

describe('reconcile', () => {
  it('marks a merged PR merged', () => {
    const b = board([task('a', { status: 'pr-open', pr: 7 })])
    const next = reconcile(b, { 7: { state: 'merged' } })
    expect((next.tasks as Task[])[0]?.status).toBe('merged')
  })

  it('marks a closed PR abandoned', () => {
    const b = board([task('a', { status: 'pr-open', pr: 7 })])
    expect((reconcile(b, { 7: { state: 'closed' } }).tasks as Task[])[0]?.status).toBe('abandoned')
  })

  it('sends a red PR back to todo and counts the attempt', () => {
    const b = board([task('a', { status: 'pr-open', pr: 7, attempts: 0 })])
    const next = reconcile(b, { 7: { state: 'open', checks: 'failure' } })
    expect((next.tasks as Task[])[0]?.status).toBe('todo')
    expect((next.tasks as Task[])[0]?.attempts).toBe(1)
  })

  it('leaves a green open PR waiting for the owner', () => {
    const b = board([task('a', { status: 'pr-open', pr: 7 })])
    const next = reconcile(b, { 7: { state: 'open', checks: 'success' } })
    expect((next.tasks as Task[])[0]?.status).toBe('pr-open')
  })

  it('rebases a stacked child onto main once its parent merges', () => {
    const b = board([
      task('parent', { status: 'pr-open', pr: 1, branch: 'stream/parent' }),
      task('child', { status: 'pr-open', pr: 2, baseBranch: 'stream/parent', dependsOn: ['parent'] })
    ])
    const next = reconcile(b, { 1: { state: 'merged' }, 2: { state: 'open', checks: 'success' } })
    expect((next.tasks as Task[])[1]?.baseBranch).toBe('main')
  })
})
