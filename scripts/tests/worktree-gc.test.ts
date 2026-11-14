import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASE, classify, classifyBranches, findMergedBranches, findMergedWorktrees, noCommitOfItsOwn, parseArgs,
  parseWorktreeList, resolveBases
} from '../worktree-gc.mjs'

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
  '',
  'worktree /wt/gone',
  'HEAD eee',
  'branch refs/heads/stream/gone',
  'prunable gitdir file points to non-existent location',
  ''
].join('\n')

describe('parseWorktreeList', () => {
  it('reads path, head, branch and the detached, locked and prunable flags', () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main', detached: false, locked: false, prunable: false },
      { path: '/wt/merged', head: 'bbb', branch: 'stream/merged', detached: false, locked: false, prunable: false },
      { path: '/wt/detached', head: 'ccc', detached: true, locked: false, prunable: false },
      { path: '/wt/locked', head: 'ddd', branch: 'stream/locked', detached: false, locked: true, prunable: false },
      { path: '/wt/gone', head: 'eee', branch: 'stream/gone', detached: false, locked: false, prunable: true }
    ])
  })
})

describe('parseArgs', () => {
  it('defaults to origin/main, and to listing only', () => {
    expect(parseArgs([])).toEqual({ remove: false, branches: false, bases: [BASE] })
    expect(BASE).toBe('origin/main')
  })

  it('takes --base any number of times, in either spelling, and drops a repeat', () => {
    expect(parseArgs(['--base', 'main', '--base=feat/stack', '--branches', '--base', 'main', '--remove']))
      .toEqual({ remove: true, branches: true, bases: ['main', 'feat/stack'] })
  })

  it('refuses a --base with no ref, and an argument it does not know', () => {
    expect(() => parseArgs(['--base'])).toThrow('--base needs a ref')
    expect(() => parseArgs(['--base', '--remove'])).toThrow('--base needs a ref')
    expect(() => parseArgs(['--remve'])).toThrow('unknown argument: --remve')
  })
})

const MAIN = { ref: 'origin/main', head: 'tip', local: 'main' }
const STACK = { ref: 'feat/stack', head: 'stack-tip', local: 'feat/stack' }

describe('classify', () => {
  const entry = (path: string, branch: string, head = 'old') =>
    ({ path, head, branch, detached: false, locked: false, prunable: false })
  const main = entry('/repo', 'main', 'tip')

  // `merged` lists the branches merged into origin/main; `into` maps a branch to another base it is merged into.
  const run = (entries: ReturnType<typeof entry>[], opts: { merged?: string[], into?: Record<string, string>, bases?: typeof MAIN[], dirty?: string[], fresh?: string[], cwd?: string } = {}) =>
    classify({
      entries: [main, ...entries],
      bases: opts.bases ?? [MAIN],
      cwd: opts.cwd ?? '/elsewhere',
      mergedInto: (branch: string) => (opts.merged ?? []).includes(branch) ? MAIN.ref : opts.into?.[branch],
      isDirty: (path: string) => (opts.dirty ?? []).includes(path),
      isFresh: (branch: string) => (opts.fresh ?? []).includes(branch)
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

  it('keeps a branch with no commit since it was created, even once main has moved past it', () => {
    const { removable, kept } = run([entry('/wt/started', 'started')], { merged: ['started'], fresh: ['started'] })
    expect(removable).toEqual([])
    expect(kept[0].reason).toMatch(/no commit since it was created/)
  })

  it('keeps locked and detached worktrees without asking git about them', () => {
    const locked = { ...entry('/wt/l', 'l'), locked: true }
    const detached = { path: '/wt/d', head: 'x', detached: true, locked: false, prunable: false }
    const { removable, kept } = classify({
      entries: [main, locked, detached],
      bases: [MAIN],
      cwd: '/elsewhere',
      mergedInto: () => { throw new Error('not consulted') },
      isDirty: () => { throw new Error('not consulted') },
      isFresh: () => { throw new Error('not consulted') }
    })
    expect(removable).toEqual([])
    expect(kept.map((e) => e.reason)).toEqual(['locked', 'detached HEAD'])
  })

  it('keeps a worktree whose directory is gone, without asking git about it', () => {
    const gone = { ...entry('/wt/gone', 'gone'), prunable: true }
    const { removable, kept } = classify({
      entries: [main, gone],
      bases: [MAIN],
      cwd: '/elsewhere',
      mergedInto: () => { throw new Error('not consulted') },
      isDirty: () => { throw new Error('not consulted') },
      isFresh: () => { throw new Error('not consulted') }
    })
    expect(removable).toEqual([])
    expect(kept.map((e) => e.reason)).toEqual(['directory is missing, `git worktree prune` clears it'])
  })

  it('is in the current directory only when it contains it, never for a sibling sharing its name prefix', () => {
    const { removable, kept } = run(
      [entry('/wt/a-1', 'one'), entry('/wt/a-10', 'ten')],
      { merged: ['one', 'ten'], cwd: '/wt/a-10/sub' }
    )
    expect(removable.map((e) => e.path)).toEqual(['/wt/a-1'])
    expect(kept.map((e) => [e.path, e.reason])).toEqual([['/wt/a-10', 'current directory']])
  })

  it('removes a worktree whose branch is merged into any one base, saying which', () => {
    const { removable, kept } = run(
      [entry('/wt/main', 'in-main'), entry('/wt/stacked', 'stacked'), entry('/wt/open', 'open')],
      { merged: ['in-main'], into: { stacked: STACK.ref }, bases: [MAIN, STACK] }
    )
    expect(removable.map((e) => [e.path, e.into])).toEqual([['/wt/main', 'origin/main'], ['/wt/stacked', 'feat/stack']])
    expect(kept.map((e) => [e.path, e.reason])).toEqual([['/wt/open', 'not merged']])
  })

  it('never offers a base itself, or sitting at any base, and applies the other checks to a branch merged into a later base', () => {
    const { removable, kept } = run(
      [entry('/wt/base', 'feat/stack', 'stack-tip'), entry('/wt/new', 'new', 'stack-tip'), entry('/wt/started', 'started'), entry('/wt/dirty', 'dirty')],
      { into: { started: STACK.ref, dirty: STACK.ref }, fresh: ['started'], dirty: ['/wt/dirty'], bases: [MAIN, STACK] }
    )
    expect(removable).toEqual([])
    expect(kept.map((e) => [e.path, e.reason])).toEqual([
      ['/wt/base', 'a base'],
      ['/wt/new', 'at feat/stack, possibly just started'],
      ['/wt/started', 'no commit since it was created, possibly just started'],
      ['/wt/dirty', 'uncommitted changes']
    ])
  })

  it('keeps the worktree of the local branch a base tracks, even when it is behind', () => {
    const { removable, kept } = run([entry('/wt/main', 'main', 'behind')], { merged: ['main'] })
    expect(removable).toEqual([])
    expect(kept[0]?.reason).toBe('a base')
  })
})

describe('noCommitOfItsOwn', () => {
  const created = 'branch: Created from origin/main'

  it('is true for a branch only created, or since moved forward to commits made elsewhere', () => {
    expect(noCommitOfItsOwn([created])).toBe(true)
    expect(noCommitOfItsOwn(['merge origin/main: Fast-forward', created])).toBe(true)
    expect(noCommitOfItsOwn(['pull --ff-only: Fast-forward', 'reset: moving to origin/main', created])).toBe(true)
  })

  it('is false once anything was committed on it, and for a branch with no reflog to read', () => {
    expect(noCommitOfItsOwn(['commit: Fix the thing', created])).toBe(false)
    expect(noCommitOfItsOwn(['merge origin/main: Fast-forward', 'commit (merge): Merge origin/main', created])).toBe(false)
    expect(noCommitOfItsOwn(['cherry-pick: Fix the thing', created])).toBe(false)
    expect(noCommitOfItsOwn([])).toBe(false)
  })
})

describe('classifyBranches', () => {
  const branch = (name: string, head = 'old') => ({ name, head })
  const run = (branches: ReturnType<typeof branch>[], opts: { into?: Record<string, string>, checkedOut?: string[], fresh?: string[], bases?: typeof MAIN[] } = {}) =>
    classifyBranches({
      branches,
      checkedOut: new Set(opts.checkedOut ?? []),
      bases: opts.bases ?? [MAIN],
      mergedInto: (name: string) => opts.into?.[name],
      isFresh: (name: string) => (opts.fresh ?? []).includes(name)
    })

  it('lists a merged branch with the base it is in, and nothing about an unmerged one', () => {
    const { removable, kept } = run(
      [branch('in-main'), branch('stacked'), branch('open')],
      { into: { 'in-main': MAIN.ref, stacked: STACK.ref }, bases: [MAIN, STACK] }
    )
    expect(removable).toEqual([{ name: 'in-main', into: 'origin/main' }, { name: 'stacked', into: 'feat/stack' }])
    expect(kept).toEqual([])
  })

  it('never offers a base, the branch a base tracks, main, master or a checked-out branch', () => {
    const mergedEverywhere = new Proxy({}, { get: () => MAIN.ref }) as Record<string, string>
    const { removable, kept } = run(
      [branch('feat/stack'), branch('main'), branch('master'), branch('busy')],
      { into: mergedEverywhere, checkedOut: ['busy'], bases: [{ ref: 'origin/feat/stack', head: 'stack-tip', local: 'feat/stack' }] }
    )
    expect(removable).toEqual([])
    expect(kept).toEqual([])
  })

  it('holds back a merged branch sitting at a base or with no commit of its own, saying why', () => {
    const { removable, kept } = run(
      [branch('at-main', 'tip'), branch('at-stack', 'stack-tip'), branch('started'), branch('done')],
      { into: { started: MAIN.ref, done: STACK.ref }, fresh: ['started'], bases: [MAIN, STACK] }
    )
    expect(removable).toEqual([{ name: 'done', into: 'feat/stack' }])
    expect(kept).toEqual([
      { name: 'at-main', reason: 'at origin/main, possibly just started' },
      { name: 'at-stack', reason: 'at feat/stack, possibly just started' },
      { name: 'started', reason: 'no commit since it was created, possibly just started' }
    ])
  })
})

describe('against a repository', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim()
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file)
    git(cwd, 'add', file)
    git(cwd, 'commit', '-q', '-m', file)
  }
  const mergeBranch = (cwd: string, into: string, branch: string) => {
    git(cwd, 'checkout', '-q', into)
    git(cwd, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch)
  }

  /**
   * main (pushed, so origin/main exists) took stream/merged-main; feat/stack, which main lacks, took
   * stream/stacked-a and stream/stacked-b, each checked out in a worktree (b with an untracked file);
   * stream/open has an unmerged commit; stream/fresh and stream/at-base were created and never committed on.
   */
  const buildRepository = () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-gc-test-'))
    roots.push(root)
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
    git(root, 'clone', '-q', 'origin.git', 'work')
    const work = join(root, 'work')
    commit(work, 'base.txt')
    git(work, 'branch', 'stream/fresh')
    for (const name of ['stream/merged-main', 'stream/stacked-a', 'stream/stacked-b', 'stream/open']) {
      git(work, 'checkout', '-q', '-b', name, 'main')
      commit(work, `${name.replace('/', '-')}.txt`)
    }
    mergeBranch(work, 'main', 'stream/merged-main')
    git(work, 'checkout', '-q', '-b', 'feat/stack', 'main')
    commit(work, 'stack.txt')
    mergeBranch(work, 'feat/stack', 'stream/stacked-a')
    mergeBranch(work, 'feat/stack', 'stream/stacked-b')
    git(work, 'checkout', '-q', 'main')
    git(work, 'push', '-q', '-u', 'origin', 'main')
    git(work, 'branch', 'stream/at-base', 'origin/main')
    git(work, 'worktree', 'add', '-q', join(root, 'wt-a'), 'stream/stacked-a')
    git(work, 'worktree', 'add', '-q', join(root, 'wt-b'), 'stream/stacked-b')
    writeFileSync(join(root, 'wt-b', 'scratch.txt'), 'unsaved')
    mkdirSync(join(root, 'wt-b', 'sub'))
    return work
  }
  const names = (items: Array<{ name: string }>) => items.map((item) => item.name)
  const branchesOf = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')

  it('resolves a base to its commit and the local branch it is or tracks, and refuses an unknown one', () => {
    const work = buildRepository()
    expect(resolveBases(work, ['origin/main', 'feat/stack']).map(({ ref, local }) => [ref, local])).toEqual([['origin/main', 'main'], ['feat/stack', 'feat/stack']])
    expect(resolveBases(work, ['origin/main'])[0]?.head).toBe(git(work, 'rev-parse', 'origin/main'))
    expect(() => resolveBases(work, ['origin/nowhere'])).toThrow('unknown base: origin/nowhere')
  })

  it('finds a stacked worktree merged only into the integration branch', () => {
    const work = buildRepository()
    const onlyMain = findMergedWorktrees(work, resolveBases(work, ['origin/main']))
    expect(onlyMain.removable).toEqual([])
    expect(onlyMain.kept.map((e) => [e.branch, e.reason])).toEqual([['stream/stacked-a', 'not merged'], ['stream/stacked-b', 'not merged']])

    const both = findMergedWorktrees(work, resolveBases(work, ['origin/main', 'feat/stack']))
    expect(both.removable.map((e) => [e.branch, e.into])).toEqual([['stream/stacked-a', 'feat/stack']])
    expect(both.kept.map((e) => [e.branch, e.reason])).toEqual([['stream/stacked-b', 'uncommitted changes']])
  })

  it('finds merged branches that no worktree holds, and keeps the ones it must', () => {
    const work = buildRepository()
    const bases = resolveBases(work, ['origin/main', 'feat/stack'])
    const { removable, kept } = findMergedBranches(work, bases)
    expect(removable.map((b) => [b.name, b.into])).toEqual([['stream/merged-main', 'origin/main']])
    expect(kept).toEqual([
      { name: 'stream/at-base', reason: 'at origin/main, possibly just started' },
      { name: 'stream/fresh', reason: 'no commit since it was created, possibly just started' }
    ])
    expect(names(findMergedBranches(work, bases, new Set(['stream/stacked-a'])).removable)).toEqual(['stream/merged-main', 'stream/stacked-a'])
    expect(names(findMergedBranches(work, resolveBases(work, ['origin/main'])).removable)).toEqual(['stream/merged-main'])
  })

  describe('the command', () => {
    const script = join(__dirname, '..', 'worktree-gc.mjs')
    const run = (cwd: string, ...args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
      } catch (err) {
        const failure = err as { status: number, stdout: string, stderr: string }
        return { code: failure.status, out: failure.stdout + failure.stderr }
      }
    }

    it('lists without touching anything, whether or not branches are asked for', () => {
      const work = buildRepository()
      const before = branchesOf(work)
      const worktrees = run(work, '--base', 'origin/main', '--base', 'feat/stack')
      expect(worktrees.out).toMatch(/merged {2}\S*wt-a \[stream\/stacked-a\] \(into feat\/stack\)/)
      expect(worktrees.out).toMatch(/1 worktree merged; add --remove/)
      const listed = run(work, '--base', 'origin/main', '--base', 'feat/stack', '--branches')
      expect(listed.out).toMatch(/merged {2}branch stream\/merged-main \(into origin\/main\)/)
      expect(listed.out).toMatch(/merged {2}branch stream\/stacked-a \(into feat\/stack\)/)
      expect(listed.out).toMatch(/1 worktree and 2 branches merged; add --remove/)
      expect(branchesOf(work)).toEqual(before)
      expect(git(work, 'worktree', 'list').split('\n')).toHaveLength(3)
    })

    it('removes the worktree and the branches it was asked for, and nothing else', () => {
      const work = buildRepository()
      const { code, out } = run(work, '--base', 'origin/main', '--base', 'feat/stack', '--branches', '--remove')
      expect(code).toBe(0)
      expect(out).toMatch(/removed \S*wt-a \[stream\/stacked-a\]/)
      expect(out).toMatch(/deleted branch stream\/stacked-a/)
      expect(out).toMatch(/deleted branch stream\/merged-main/)
      expect(branchesOf(work)).toEqual(['feat/stack', 'main', 'stream/at-base', 'stream/fresh', 'stream/open', 'stream/stacked-b'])
      expect(git(work, 'worktree', 'list').split('\n')).toHaveLength(2)
    })

    it('keeps a merged worktree whose directory was deleted by hand, and lists the rest', () => {
      const work = buildRepository()
      const root = join(work, '..')
      git(work, 'branch', 'stream/gone', 'feat/stack')
      git(work, 'worktree', 'add', '-q', join(root, 'wt-gone'), 'stream/gone')
      rmSync(join(root, 'wt-gone'), { recursive: true, force: true })
      const { code, out } = run(work, '--base', 'origin/main', '--base', 'feat/stack')
      expect(code).toBe(0)
      expect(out).toMatch(/keep {4}\S*wt-gone \[stream\/gone\]: directory is missing/)
      expect(out).toMatch(/merged {2}\S*wt-a /)
    })

    it('rejects an unknown base before anything is listed', () => {
      const work = buildRepository()
      const { code, out } = run(work, '--base', 'nowhere', '--remove')
      expect(code).toBe(2)
      expect(out).toMatch(/unknown base: nowhere\nusage: /)
    })
  })
})
