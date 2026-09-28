import { describe, expect, it } from 'vitest'
import { classify, parseWorktreeList } from '../worktree-gc.mjs'

const PORCELAIN = [
  'worktree /repo',
  'HEAD aaa',
  'branch refs/heads/main',
  '',
  'worktree /wt/merged',
  'HEAD bbb',
  'branch refs/heads/stream/merged',
  '',
  'worktree /wt/detached',
  'HEAD ccc',
  'detached',
  '',
  'worktree /wt/locked',
  'HEAD ddd',
  'branch refs/heads/stream/locked',
  'locked in use',
  ''
].join('\n')

describe('parseWorktreeList', () => {
  it('reads path, head, branch and the detached and locked flags', () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main', detached: false, locked: false },
      { path: '/wt/merged', head: 'bbb', branch: 'stream/merged', detached: false, locked: false },
      { path: '/wt/detached', head: 'ccc', detached: true, locked: false },
      { path: '/wt/locked', head: 'ddd', branch: 'stream/locked', detached: false, locked: true }
    ])
  })
})

describe('classify', () => {
  const entry = (path: string, branch: string, head = 'old') =>
    ({ path, head, branch, detached: false, locked: false })
  const main = entry('/repo', 'main', 'tip')

  const run = (entries: ReturnType<typeof entry>[], opts: { merged?: string[], dirty?: string[], cwd?: string } = {}) =>
    classify({
      entries: [main, ...entries],
      baseHead: 'tip',
      cwd: opts.cwd ?? '/elsewhere',
      isMerged: (branch: string) => (opts.merged ?? []).includes(branch),
      isDirty: (path: string) => (opts.dirty ?? []).includes(path)
    })

  it('removes a clean worktree whose branch is merged, and never offers the main worktree', () => {
    const { removable, kept } = run([entry('/wt/a', 'a')], { merged: ['a', 'main'] })
    expect(removable.map((e) => e.path)).toEqual(['/wt/a'])
    expect(kept).toEqual([])
  })

  it('keeps unmerged, dirty, and current-directory worktrees, saying why', () => {
    const { removable, kept } = run(
      [entry('/wt/open', 'open'), entry('/wt/dirty', 'dirty'), entry('/wt/here', 'here')],
      { merged: ['dirty', 'here'], dirty: ['/wt/dirty'], cwd: '/wt/here/sub' }
    )
    expect(removable).toEqual([])
    expect(kept.map((e) => [e.path, e.reason])).toEqual([
      ['/wt/open', 'not merged'],
      ['/wt/dirty', 'uncommitted changes'],
      ['/wt/here', 'current directory']
    ])
  })

  it('keeps a branch sitting exactly at origin/main, which may have just been started', () => {
    const { removable, kept } = run([entry('/wt/new', 'new', 'tip')], { merged: ['new'] })
    expect(removable).toEqual([])
    expect(kept[0].reason).toMatch(/possibly just started/)
  })

  it('keeps locked and detached worktrees without asking git about them', () => {
    const locked = { ...entry('/wt/l', 'l'), locked: true }
    const detached = { path: '/wt/d', head: 'x', detached: true, locked: false }
    const { removable, kept } = classify({
      entries: [main, locked, detached],
      baseHead: 'tip',
      cwd: '/elsewhere',
      isMerged: () => { throw new Error('not consulted') },
      isDirty: () => { throw new Error('not consulted') }
    })
    expect(removable).toEqual([])
    expect(kept.map((e) => e.reason)).toEqual(['locked', 'detached HEAD'])
  })
})
