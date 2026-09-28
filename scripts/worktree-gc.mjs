/**
 * Lists linked worktrees whose branch is already merged into `origin/main`,
 * and with `--remove` removes them (CLAUDE.md Rule 10). Branches are kept;
 * only the checkouts go. Fetch first: a stale `origin/main` finds fewer, never
 * more.
 *
 *   node scripts/worktree-gc.mjs            # list what qualifies
 *   node scripts/worktree-gc.mjs --remove   # and remove it
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

export const BASE = 'origin/main'

/**
 * `git worktree list --porcelain` parsed into entries. The first is the main
 * worktree, which is never a candidate.
 * @returns {Array<{ path: string, head: string, branch?: string, detached: boolean, locked: boolean }>}
 */
export function parseWorktreeList (porcelain) {
  return porcelain.split('\n\n').map((block) => block.trim()).filter(Boolean).map((block) => {
    const entry = { path: '', head: '', detached: false, locked: false }
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'worktree') entry.path = value
      else if (key === 'HEAD') entry.head = value
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'detached') entry.detached = true
      else if (key === 'locked') entry.locked = true
    }
    return entry
  })
}

/**
 * Sorts every linked worktree into removable or kept, with the reason.
 * `git` is injected so the rules can be tested without a repository.
 * @param {{ entries: ReturnType<typeof parseWorktreeList>, baseHead: string, cwd: string,
 *   isMerged: (branch: string) => boolean, isDirty: (path: string) => boolean }} input
 */
export function classify ({ entries, baseHead, cwd, isMerged, isDirty }) {
  const removable = []
  const kept = []
  for (const entry of entries.slice(1)) {
    const keep = (reason) => kept.push({ ...entry, reason })
    if (entry.locked) keep('locked')
    else if (entry.detached || !entry.branch) keep('detached HEAD')
    else if (resolve(cwd).startsWith(resolve(entry.path))) keep('current directory')
    // A branch just created from the newest main is "merged" too, and is
    // about to be worked on; it qualifies once main moves past it.
    else if (entry.head === baseHead) keep(`at ${BASE}, possibly just started`)
    else if (!isMerged(entry.branch)) keep('not merged')
    else if (isDirty(entry.path)) keep('uncommitted changes')
    else removable.push(entry)
  }
  return { removable, kept }
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Runs `classify` against the repository at `root`. */
export function findMergedWorktrees (root) {
  const succeeds = (args, cwd = root) => {
    try { git(args, cwd); return true } catch { return false }
  }
  return classify({
    entries: parseWorktreeList(git(['worktree', 'list', '--porcelain'], root)),
    baseHead: git(['rev-parse', BASE], root).trim(),
    cwd: process.cwd(),
    isMerged: (branch) => succeeds(['merge-base', '--is-ancestor', `refs/heads/${branch}`, BASE]),
    isDirty: (path) => git(['status', '--porcelain'], path).trim() !== ''
  })
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const remove = process.argv.includes('--remove')
  const { removable, kept } = findMergedWorktrees(root)

  for (const { path, branch, reason } of kept) console.log(`keep    ${path} [${branch ?? '-'}]: ${reason}`)
  let failed = false
  for (const { path, branch } of removable) {
    if (!remove) { console.log(`merged  ${path} [${branch}]`); continue }
    try {
      git(['worktree', 'remove', path], root)
      console.log(`removed ${path} [${branch}]`)
    } catch (err) {
      failed = true
      console.error(`failed  ${path} [${branch}]: ${String(err.stderr ?? err.message).trim()}`)
    }
  }
  if (!remove && removable.length > 0) console.log(`\n${removable.length} merged; rerun with --remove to remove them.`)
  if (failed) process.exit(1)
}
