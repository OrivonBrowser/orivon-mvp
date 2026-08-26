import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _internals } from './policy.mjs'

// The catalogue is hand-authored, so it can drift from the rules the loop
// relies on. These assertions are cheap and catch the drift the moment it
// happens, rather than three unattended cycles later.

interface Task {
  id: string
  title: string
  category: string
  model: string
  stream: string
  paths: string[]
  dependsOn: string[]
  lowValue: boolean
  definitionOfDone: string
}

const catalogue = JSON.parse(
  readFileSync(join(process.cwd(), 'orchestration/tasks.json'), 'utf8')
) as { tasks: Task[] }

const tasks = catalogue.tasks
const byId = new Map(tasks.map((t) => [t.id, t]))

describe('the task catalogue', () => {
  it('has tasks', () => {
    expect(tasks.length).toBeGreaterThan(10)
  })

  it('gives every task a unique id', () => {
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length)
  })

  it.each(['title', 'category', 'model', 'stream', 'definitionOfDone'])(
    'gives every task a %s',
    (field) => {
      for (const t of tasks) {
        expect(String(t[field as keyof Task] ?? ''), `${t.id}.${field}`).not.toHaveLength(0)
      }
    }
  )

  it('gives every task at least one path it may write', () => {
    for (const t of tasks) expect(t.paths.length, t.id).toBeGreaterThan(0)
  })

  it('has no dangling dependency', () => {
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        expect(byId.has(dep), `${t.id} depends on unknown ${dep}`).toBe(true)
      }
    }
  })

  it('has no dependency cycle', () => {
    const state = new Map<string, 'visiting' | 'done'>()
    const walk = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done') return
      expect(state.get(id), `cycle: ${[...trail, id].join(' -> ')}`).not.toBe('visiting')
      state.set(id, 'visiting')
      for (const dep of byId.get(id)?.dependsOn ?? []) walk(dep, [...trail, id])
      state.set(id, 'done')
    }
    for (const t of tasks) walk(t.id, [])
  })

  it('declares dependencies before dependents, so array order is a valid plan', () => {
    const seen = new Set<string>()
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        expect(seen.has(dep), `${t.id} depends on ${dep}, which appears later`).toBe(true)
      }
      seen.add(t.id)
    }
  })

  // Owner decision L2: the security core decides whether an app may open a
  // socket or read a file, so it does not get the cheaper model.
  it('assigns opus to every task that writes src/broker/', () => {
    for (const t of tasks) {
      if (t.paths.some((p) => p.startsWith('src/broker/'))) {
        expect(t.model, `${t.id} writes src/broker/ and must be opus`).toBe('opus')
      }
    }
  })

  it('uses only known models', () => {
    for (const t of tasks) expect(['opus', 'sonnet'], t.id).toContain(t.model)
  })

  it('uses only categories the dashboard can pause', () => {
    const known = ['broker', 'shim', 'loader', 'torrent-app', 'browser-ui', 'trust',
      'nostr', 'telemetry', 'packaging', 'docs', 'tests', 'tooling']
    for (const t of tasks) expect(known, t.id).toContain(t.category)
  })

  // The L3 fallback is only useful if there is something in it. With an empty
  // backlog the loop jumps straight from "blocked" to "guess", which is exactly
  // the order the owner asked to avoid.
  it('keeps a non-empty low-value backlog', () => {
    expect(tasks.filter((t) => t.lowValue).length).toBeGreaterThanOrEqual(3)
  })

  it('gives low-value tasks no dependents, so they never block anything', () => {
    const lowValue = new Set(tasks.filter((t) => t.lowValue).map((t) => t.id))
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        expect(lowValue.has(dep), `${t.id} depends on low-value ${dep}`).toBe(false)
      }
    }
  })

  // Two agents writing the same file is the one failure worktree isolation
  // cannot prevent, because they merge back to the same branch.
  it('never lets two independent tasks claim overlapping paths', () => {
    const collisions: string[] = []
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i]
        const b = tasks[j]
        if (a === undefined || b === undefined) continue
        // Related tasks are serialised by their dependency edge, so they can
        // safely share paths -- they never run at the same time.
        if (related(a.id, b.id)) continue
        if (_internals.overlaps(a.paths, b.paths)) collisions.push(`${a.id} <-> ${b.id}`)
      }
    }
    expect(collisions).toEqual([])
  })
})

/** True if either task transitively depends on the other. */
function related (a: string, b: string): boolean {
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (byId.get(from)?.dependsOn ?? []).some((d) => reaches(d, to, seen))
  }
  return reaches(a, b) || reaches(b, a)
}
