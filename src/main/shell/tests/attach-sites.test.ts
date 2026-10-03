import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = join(import.meta.dirname, '..', '..')

function sources (dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** The code of a line, without a comment that ends it or one that is the whole line. */
function code (line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.indexOf(' // ')
  return at === -1 ? line : line.slice(0, at)
}

describe('every view that goes into a window', () => {
  it('goes in through attachShown, which shows a view that left a window and came back', () => {
    const bare = sources(MAIN)
      .filter((file) => !file.endsWith(join('shell', 'attach-view.ts')))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n')
        .map((line, at) => ({ at: at + 1, text: code(line) }))
        .filter(({ text }) => /\baddChildView\s*\(/.test(text))
        .map(({ at }) => `${relative(MAIN, file)}:${String(at)}`))
    expect(bare).toEqual([])
  })

  it('is taken out of a window only by code that is shown how to put it back', () => {
    const files = sources(MAIN)
      .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => /\bremoveChildView\s*\(/.test(code(line))))
      .map((file) => relative(MAIN, file))
      .filter((file) => file !== join('shell', 'attach-view.ts'))
      .sort()
    for (const file of files) expect(readFileSync(join(MAIN, file), 'utf8'), `${file} removes a view without ever attaching one through attachShown`).toMatch(/attachShown/)
  })
})
