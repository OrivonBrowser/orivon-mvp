import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failedSpecs, nextStep, normalize, runIds, updateBranch } from '../ai/pr-watch.mjs'

const pass = (name: string) => ({ name, conclusion: 'SUCCESS' })
const fail = (name: string) => ({ name, conclusion: 'FAILURE' })

describe('normalize', () => {
  it('reads a check run and a commit status alike, pending as an empty conclusion', () => {
    expect(normalize({ name: 'check', conclusion: '', detailsUrl: 'u' })).toEqual({ name: 'check', conclusion: '', url: 'u' })
    expect(normalize({ context: 'ci/x', state: 'PENDING', targetUrl: 't' })).toEqual({ name: 'ci/x', conclusion: '', url: 't' })
    expect(normalize({ context: 'ci/x', state: 'FAILURE' }).conclusion).toBe('FAILURE')
  })
})

describe('nextStep', () => {
  const base = { state: 'CLEAN', reruns: 0, maxReruns: 2 }

  it('waits while there are no checks yet or any is pending', () => {
    expect(nextStep({ ...base, checks: [] }).step).toBe('wait')
    expect(nextStep({ ...base, checks: [pass('check'), { name: 'e2e-shard-1', conclusion: '' }] }).step).toBe('wait')
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
    const head = updateBranch(mine)
    expect(head).toBe(git(mine, 'rev-parse', 'HEAD'))
    expect(git(join(root, 'origin.git'), 'rev-parse', 'feature')).toBe(head)
    expect(git(mine, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
  })

  it('leaves the worktree as it was when main does not merge cleanly', () => {
    const { mine } = repos('shared.txt')
    const before = git(mine, 'rev-parse', 'HEAD')
    expect(updateBranch(mine)).toBeUndefined()
    expect(git(mine, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(mine, 'status', '--porcelain')).toBe('')
  })
})
