import { describe, expect, it, vi } from 'vitest'
import { ClosedStack, CLOSED_STACK_CAP } from '../closed-stack.js'
import type { NewClosedEntry } from '../closed-stack.js'

const tab = (n: number): NewClosedEntry => ({ kind: 'tab', tab: { url: `https://a.example/${String(n)}`, title: String(n), pinned: false }, index: n, windowKey: 1 })

describe('the closed stack', () => {
  it('gives back the last one closed first', () => {
    const stack = new ClosedStack()
    stack.push(tab(1))
    stack.push(tab(2))
    expect(stack.peek()).toMatchObject({ index: 2 })
    expect(stack.pop()).toMatchObject({ index: 2 })
    expect(stack.pop()).toMatchObject({ index: 1 })
    expect(stack.pop()).toBeUndefined()
  })

  it('forgets what was closed in a span of time, and tells its listeners only when something went', () => {
    let now = 100
    const stack = new ClosedStack(25, () => now)
    stack.push(tab(1))
    now = 200
    stack.push(tab(2))
    now = 300
    stack.push(tab(3))
    const changed = vi.fn()
    stack.onChange(changed)
    stack.forgetBetween(150, 300)
    expect(stack.list().map((entry) => entry.kind === 'tab' ? entry.index : -1)).toEqual([1])
    stack.forgetBetween(400, 500)
    expect(changed).toHaveBeenCalledTimes(1)
    stack.forgetBetween(-Infinity, Infinity)
    expect(stack.size).toBe(0)
  })

  it('holds 25 and forgets the oldest past that', () => {
    const stack = new ClosedStack()
    for (let n = 0; n < CLOSED_STACK_CAP + 5; n++) stack.push(tab(n))
    expect(stack.size).toBe(CLOSED_STACK_CAP)
    expect(stack.list().at(-1)).toMatchObject({ index: 5 })
    expect(stack.list()[0]).toMatchObject({ index: CLOSED_STACK_CAP + 4 })
  })

  it('lists newest first and gives each entry an id and a time', () => {
    const stack = new ClosedStack(25, () => 1234)
    const first = stack.push(tab(1))
    const second = stack.push(tab(2))
    expect(stack.list().map((entry) => entry.id)).toEqual([second.id, first.id])
    expect(first).toMatchObject({ at: 1234 })
    expect(second.id).not.toBe(first.id)
  })

  it('takes an entry from the middle by id', () => {
    const stack = new ClosedStack()
    const a = stack.push(tab(1))
    stack.push(tab(2))
    expect(stack.take(a.id)).toMatchObject({ index: 1 })
    expect(stack.take(a.id)).toBeUndefined()
    expect(stack.list()).toHaveLength(1)
  })

  it('tells a listener about each change, and stops when it is removed', () => {
    const stack = new ClosedStack()
    const listener = vi.fn()
    const off = stack.onChange(listener)
    const entry = stack.push(tab(1))
    stack.take(entry.id)
    stack.pop()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    stack.push(tab(2))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
