import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failedSpecs, headOnceSeen, nextStep, normalize, runIds, updateBranch } from '../ai/pr-watch.mjs'

const pass = (name: string) => ({ name, conclusion: 'SUCCESS' })
const fail = (name: string) => ({ name, conclusion: 'FAILURE' })
const job = (name: string, conclusion: string, run: number) => ({ name, conclusion, workflow: 'CI', url: `https://github.com/o/r/actions/runs/${String(run)}/job/1` })

describe('normalize', () => {
  it('reads a check run and a commit status alike, pending as an empty conclusion', () => {
    expect(normalize({ name: 'check', conclusion: '', detailsUrl: 'u' })).toEqual({ name: 'check', conclusion: '', url: 'u', workflow: '' })
    expect(normalize({ context: 'ci/x', state: 'PENDING', targetUrl: 't' })).toEqual({ name: 'ci/x', conclusion: '', url: 't', workflow: '' })
    expect(normalize({ context: 'ci/x', state: 'FAILURE' }).conclusion).toBe('FAILURE')
    expect(normalize({ name: 'check', workflowName: 'CI' }).workflow).toBe('CI')
  })
})

describe('nextStep', () => {
  const base = { state: 'CLEAN', reruns: 0, maxReruns: 2 }

  it('waits while there are no checks yet or any is pending', () => {
    expect(nextStep({ ...base, checks: [] }).step).toBe('wait')
    expect(nextStep({ ...base, checks: [pass('check'), { name: 'e2e-shard-1', conclusion: '' }] }).step).toBe('wait')
  })

  it('calls failures on a base main has moved past stale, before any rerun or verdict', () => {
    expect(nextStep({ ...base, state: 'BEHIND', checks: [fail('check'), pass('e2e')] })).toEqual({ step: 'stale', failed: ['check'] })
    expect(nextStep({ ...base, state: 'BEHIND', checks: [fail('e2e-shard-1')] }).step).toBe('stale')
    expect(nextStep({ ...base, state: 'DIRTY', checks: [fail('check')] }).step).toBe('stale')
  })

  it('merges only when every check passed and the branch is CLEAN', () => {
    expect(nextStep({ ...base, checks: [pass('check'), { name: 'docs', conclusion: 'SKIPPED' }] }).step).toBe('merge')
    expect(nextStep({ ...base, state: 'UNKNOWN', checks: [pass('check')] }).step).toBe('wait')
  })

  it('stops on a branch that needs main merged in, and waits out BLOCKED, which GitHub says while it recomputes', () => {
    for (const state of ['BEHIND', 'DIRTY']) expect(nextStep({ ...base, state, checks: [pass('check')] }).step).toBe('stuck')
    expect(nextStep({ ...base, state: 'BLOCKED', checks: [pass('check')] }).step).toBe('wait')
  })

  it('reruns failed e2e shards and unacquired runners, up to the limit', () => {
    const checks = [pass('check'), fail('e2e-shard-2'), fail('e2e'), { name: 'live (macos)', conclusion: 'CANCELLED' }]
    expect(nextStep({ ...base, checks })).toEqual({ step: 'rerun', failed: ['e2e-shard-2', 'e2e', 'live (macos)'] })
    expect(nextStep({ ...base, checks, reruns: 2 }).step).toBe('fail')
  })

  it('never reruns any other failed check', () => {
    expect(nextStep({ ...base, checks: [fail('check'), fail('e2e-shard-1')] })).toEqual({ step: 'fail', failed: ['check', 'e2e-shard-1'] })
  })

  it('reads past all of a run a later run on the same commit replaced, whatever its jobs ended as', () => {
    const replaced = [job('check', 'CANCELLED', 1), job('e2e-shard-${{ matrix.shard }}', 'CANCELLED', 1), job('e2e', 'FAILURE', 1)]
    expect(nextStep({ ...base, checks: [...replaced, job('check', 'SUCCESS', 2), job('e2e-shard-1', 'SUCCESS', 2), job('e2e', 'SUCCESS', 2)] }).step).toBe('merge')
    expect(nextStep({ ...base, checks: [...replaced, job('check', '', 2)] }).step).toBe('wait')
    expect(nextStep({ ...base, checks: [...replaced, job('check', 'FAILURE', 2)] })).toEqual({ step: 'fail', failed: ['check'] })
  })

  it('keeps a cancelled run that nothing later replaced', () => {
    const cancelled = [job('scope', 'SUCCESS', 1), job('check', 'CANCELLED', 1), job('e2e', 'FAILURE', 1)]
    const verdict = { step: 'fail', failed: ['check', 'e2e'] }
    expect(nextStep({ ...base, checks: cancelled })).toEqual(verdict)
    // What a label that is not `ci:` starts: every job skipped, next to the real run.
    expect(nextStep({ ...base, checks: [...cancelled, job('check', 'SKIPPED', 2), job('e2e', 'SKIPPED', 2)] })).toEqual(verdict)
    expect(nextStep({ ...base, checks: [...cancelled, { ...job('check', 'SUCCESS', 2), workflow: 'Other' }] })).toEqual(verdict)
  })

  it('never lets an earlier run replace a later one', () => {
    const checks = [job('check', 'SUCCESS', 1), job('e2e', 'SUCCESS', 1), job('check', 'CANCELLED', 2), job('e2e', 'FAILURE', 2)]
    expect(nextStep({ ...base, checks })).toEqual({ step: 'fail', failed: ['check', 'e2e'] })
  })

  it('keeps a check with no run behind it', () => {
    expect(nextStep({ ...base, checks: [{ name: 'CodeQL', conclusion: 'CANCELLED', url: 'https://github.com/o/r/runs/5' }, job('CodeQL', 'SUCCESS', 2)] })).toEqual({ step: 'fail', failed: ['CodeQL'] })
  })
})

describe('failedSpecs', () => {
  it('names each failed spec and test once, colours and timestamps stripped', () => {
    const log = [
      '2026-10-08T15:00:00.0000000Z \x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m test/sites/e2e-screen-share-gate.test.ts\x1b[2m > \x1b[22mrefuses the call',
      '2026-10-08T15:00:01.0000000Z  FAIL  test/sites/e2e-screen-share-gate.test.ts > refuses the call',
      ' ✓ test/tabs/e2e-tabs.test.ts > opens a tab',
      ' FAIL  test/window/e2e-launch.test.ts'
    ].join('\n')
    expect(failedSpecs(log)).toEqual(['test/sites/e2e-screen-share-gate.test.ts > refuses the call', 'test/window/e2e-launch.test.ts'])
  })
})

describe('runIds', () => {
  it('gives each failed check\'s workflow run once', () => {
    const url = (run: number, job: number) => `https://github.com/o/r/actions/runs/${String(run)}/job/${String(job)}`
    expect(runIds([
      { name: 'e2e-shard-1', conclusion: 'FAILURE', url: url(7, 1) },
      { name: 'e2e', conclusion: 'FAILURE', url: url(7, 2) },
      { name: 'live (macos)', conclusion: 'CANCELLED', url: url(9, 3) },
      { name: 'check', conclusion: 'SUCCESS', url: url(8, 4) }
    ])).toEqual(['7', '9'])
  })
})

describe('headOnceSeen', () => {
  const timing = { budgetMs: 20, pollMs: 5, sleep: async () => {} }

  it('waits for a PR head that lags a push that landed', async () => {
    const heads = ['old', 'old', 'new']
    expect(await headOnceSeen(() => heads.shift() ?? 'new', 'new', timing)).toBe('new')
  })

  it('gives the last head read once the budget is spent, so an unpushed commit is still named', async () => {
    let reads = 0
    expect(await headOnceSeen(() => { reads += 1; return 'old' }, 'new', timing)).toBe('old')
    expect(reads).toBe(5)
  })
})

describe('updateBranch', () => {
  const identity = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }
  const saved: Record<string, string | undefined> = {}
  const roots: string[] = []
  beforeAll(() => { for (const [key, value] of Object.entries(identity)) { saved[key] = process.env[key]; process.env[key] = value } })
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (cwd: string, file: string, text: string) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', file) }

  /** An origin with `main` and a pushed `feature` branch checked out in `mine`, and `main` moved on from `theirs`. */
  function repos (theirFile: string) {
    const root = mkdtempSync(join(tmpdir(), 'pr-watch-test-'))
    roots.push(root)
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
    git(root, 'clone', '-q', 'origin.git', 'mine')
    const mine = join(root, 'mine')
    commit(mine, 'shared.txt', 'base\n')
    git(mine, 'push', '-q', 'origin', 'HEAD:main')
    git(mine, 'checkout', '-q', '-b', 'feature')
    commit(mine, 'shared.txt', 'feature\n')
    git(mine, 'push', '-q', '-u', 'origin', 'feature')
    git(root, 'clone', '-q', 'origin.git', 'theirs')
    const theirs = join(root, 'theirs')
    commit(theirs, theirFile, 'main moved\n')
    git(theirs, 'push', '-q', 'origin', 'HEAD:main')
    return { root, mine }
  }

  it('merges main into the branch and pushes it', () => {
    const { root, mine } = repos('other.txt')
    const head = updateBranch(mine, 'feature')
    expect(head).toBe(git(mine, 'rev-parse', 'HEAD'))
    expect(git(join(root, 'origin.git'), 'rev-parse', 'feature')).toBe(head)
    expect(git(mine, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
  })

  it('pushes to the pull request\'s branch when the local branch has another name, and makes no second branch', () => {
    const { root, mine } = repos('other.txt')
    git(mine, 'branch', '-m', 'feature', 'renamed-here')
    const head = updateBranch(mine, 'feature')
    expect(git(join(root, 'origin.git'), 'rev-parse', 'feature')).toBe(head)
    expect(git(join(root, 'origin.git'), 'branch', '--list', 'renamed-here')).toBe('')
  })

  it('settles a conflict in the decision log alone by renumbering the branch\'s rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-watch-test-'))
    roots.push(root)
    const log = 'docs/decisions/decision-log.md'
    const row = (id: string, what: string) => `| \`${id}\` | 2026-10-20 | ${what} | x |\n`
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
    git(root, 'clone', '-q', 'origin.git', 'mine')
    const mine = join(root, 'mine')
    mkdirSync(join(mine, 'docs/decisions'), { recursive: true })
    commit(mine, log, row('d-0001', 'base'))
    git(mine, 'push', '-q', 'origin', 'HEAD:main')
    git(mine, 'checkout', '-q', '-b', 'feature')
    commit(mine, log, row('d-0001', 'base') + row('d-0002', 'ours'))
    git(mine, 'push', '-q', '-u', 'origin', 'feature')
    git(root, 'clone', '-q', 'origin.git', 'theirs')
    const theirs = join(root, 'theirs')
    commit(theirs, log, row('d-0001', 'base') + row('d-0002', 'theirs'))
    git(theirs, 'push', '-q', 'origin', 'HEAD:main')
    const head = updateBranch(mine, 'feature')
    expect(head).toBe(git(mine, 'rev-parse', 'HEAD'))
    expect(readFileSync(join(mine, log), 'utf8')).toBe(row('d-0001', 'base') + row('d-0002', 'theirs') + row('d-0003', 'ours'))
    expect(git(mine, 'status', '--porcelain')).toBe('')
  })

  it('leaves the worktree as it was when main does not merge cleanly', () => {
    const { mine } = repos('shared.txt')
    const before = git(mine, 'rev-parse', 'HEAD')
    expect(updateBranch(mine, 'feature')).toBeUndefined()
    expect(git(mine, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(mine, 'status', '--porcelain')).toBe('')
  })
})
