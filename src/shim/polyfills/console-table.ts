// `console.table`'s layout, as Node draws it: one box-drawn grid, every cell left-aligned.

import { inspect } from 'util'

const INDEX = '(index)'
const ITERATION_INDEX = '(iteration index)'
const KEY = 'Key'
const VALUES = 'Values'

/** A cell's width in characters, counting a surrogate pair once. */
const widthOf = (text: string): number => [...text].length

function renderRow (cells: readonly string[], widths: readonly number[]): string {
  return `│ ${cells.map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - widthOf(cell))).join(' │ ')} │`
}

/** The grid for `columns` under the headings `head`: a column shorter than the longest has empty cells. */
function grid (head: readonly string[], columns: readonly (readonly (string | undefined)[])[]): string {
  const rows = Math.max(0, ...columns.map((column) => column.length))
  const widths = head.map((heading, i) => Math.max(widthOf(heading), ...(columns[i] ?? []).map((cell) => widthOf(cell ?? ''))))
  const rule = (left: string, middle: string, right: string): string => `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`
  const body = Array.from({ length: rows }, (_, row) => renderRow(columns.map((column) => column[row] ?? ''), widths))
  return [rule('┌', '┬', '┐'), renderRow(head, widths), rule('├', '┼', '┤'), ...body, rule('└', '┴', '┘')].join('\n')
}

function cell (value: unknown): string {
  const depth = value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 2 ? -1 : 0
  return inspect(value, { depth, maxArrayLength: 3, breakLength: Infinity } as never)
}

const indexes = (length: number): string[] => Array.from({ length }, (_, i) => cell(i))

/** The text `console.table(data, properties)` prints, or undefined for a value it prints as `console.log` would. */
export function renderTable (data: unknown, properties?: readonly string[]): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  if (data instanceof Map) {
    const entries = [...data]
    return grid([ITERATION_INDEX, KEY, VALUES], [indexes(entries.length), entries.map(([key]) => cell(key)), entries.map(([, value]) => cell(value))])
  }
  if (data instanceof Set) {
    const values = [...data]
    return grid([ITERATION_INDEX, VALUES], [indexes(values.length), values.map(cell)])
  }
  const source = data as Record<string, unknown>
  const columns = new Map<string, (string | undefined)[]>()
  const primitives: string[] = []
  let hasPrimitives = false
  const rowKeys = Object.keys(source)
  rowKeys.forEach((rowKey, row) => {
    const item = source[rowKey]
    const primitive = item === null || (typeof item !== 'function' && typeof item !== 'object')
    if (properties === undefined && primitive) {
      hasPrimitives = true
      primitives[row] = cell(item)
      return
    }
    for (const key of properties ?? Object.keys(item as object)) {
      const column = columns.get(key) ?? []
      columns.set(key, column)
      column[row] = (primitive && properties !== undefined) || !Object.prototype.hasOwnProperty.call(item, key) ? '' : cell((item as Record<string, unknown>)[key])
    }
  })
  const head = [INDEX, ...columns.keys(), ...(hasPrimitives ? [VALUES] : [])]
  return grid(head, [rowKeys, ...columns.values(), ...(hasPrimitives ? [primitives] : [])])
}
