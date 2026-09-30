import { describe, expect, it } from 'vitest'
import { DEFAULT_SORT, displayRows, formatCpu, formatMemory, formatPid, nextSort, sortTasks } from '../sort.js'
import type { Task } from '../sort.js'

const task = (key: string, name: string, memoryKb: number | null, cpu: number | null, pid: number, children: Task['children'] = []): Task =>
  ({ key, name, memoryKb, cpu, pid, kind: 'tab', endable: true, children })

const TASKS = [
  task('a', 'Tab: Banana', 300, 1, 40),
  task('b', 'Tab: apple', 900, null, 10),
  task('c', 'Tab: Cherry', 100, 7.5, 30),
  task('d', 'Tab: Date (not running)', null, null, 0)
]

const names = (tasks: readonly Task[]): string[] => tasks.map((item) => item.name)

describe('the task manager sort', () => {
  it('starts on memory, largest first', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'memory', descending: true })
    expect(names(sortTasks(TASKS, DEFAULT_SORT))).toEqual(['Tab: apple', 'Tab: Banana', 'Tab: Cherry', 'Tab: Date (not running)'])
  })

  it('sorts by task ascending without regard to case, and reversed', () => {
    expect(names(sortTasks(TASKS, { key: 'name', descending: false }))).toEqual(['Tab: apple', 'Tab: Banana', 'Tab: Cherry', 'Tab: Date (not running)'])
    expect(names(sortTasks(TASKS, { key: 'name', descending: true }))[0]).toBe('Tab: Date (not running)')
  })

  it('sorts by processor use with an unread value last when descending', () => {
    expect(names(sortTasks(TASKS, { key: 'cpu', descending: true })).slice(0, 2)).toEqual(['Tab: Cherry', 'Tab: Banana'])
  })

  it('sorts by process id, a page with no process counting as the lowest', () => {
    expect(names(sortTasks(TASKS, { key: 'pid', descending: false }))).toEqual(['Tab: Date (not running)', 'Tab: apple', 'Tab: Cherry', 'Tab: Banana'])
  })

  it('orders equal values by name, then key, so updates never shuffle them', () => {
    const tied = [task('z', 'Same', 5, 1, 1), task('y', 'Same', 5, 1, 1), task('x', 'Other', 5, 1, 1)]
    expect(sortTasks(tied, DEFAULT_SORT).map((item) => item.key)).toEqual(['x', 'y', 'z'])
  })

  it('does not change the list it is given', () => {
    const before = names(TASKS)
    sortTasks(TASKS, { key: 'pid', descending: false })
    expect(names(TASKS)).toEqual(before)
  })

  it('goes descending on the first click of a number column, ascending on Task, and reverses a repeat click', () => {
    expect(nextSort(DEFAULT_SORT, 'cpu')).toEqual({ key: 'cpu', descending: true })
    expect(nextSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', descending: false })
    expect(nextSort({ key: 'name', descending: false }, 'name')).toEqual({ key: 'name', descending: true })
    expect(nextSort(DEFAULT_SORT, 'memory')).toEqual({ key: 'memory', descending: false })
  })

  it('keeps the pages sharing a process right under it, without a figure of their own', () => {
    const shared = task('p', 'Tab: Host', 500, 2, 7, [{ key: 'c1', kind: 'tab', name: 'Tab: Guest' }])
    const rows = displayRows([task('q', 'Tab: Other', 100, 1, 8), shared], DEFAULT_SORT)
    expect(rows.map((row) => [row.name, row.depth])).toEqual([['Tab: Host', 0], ['Tab: Guest', 1], ['Tab: Other', 0]])
    expect(rows[1]).toMatchObject({ pid: 7, memoryKb: null, cpu: null, endable: true })
  })
})

describe('the task manager number formats', () => {
  it('writes memory in the largest unit that keeps it above one', () => {
    expect(formatMemory(182 * 1024)).toBe('182 MB')
    expect(formatMemory(1.4 * 1024 * 1024)).toBe('1.4 GB')
    expect(formatMemory(640)).toBe('640 KB')
    expect(formatMemory(null)).toBe('-')
  })

  it('writes processor use with one decimal, and a dash before the first reading', () => {
    expect(formatCpu(3.14159)).toBe('3.1%')
    expect(formatCpu(0)).toBe('0.0%')
    expect(formatCpu(null)).toBe('-')
  })

  it('writes a dash for a page with no process', () => {
    expect(formatPid(4242)).toBe('4242')
    expect(formatPid(0)).toBe('-')
  })
})
