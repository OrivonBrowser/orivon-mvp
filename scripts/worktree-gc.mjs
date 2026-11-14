/**
 * Lists linked worktrees whose branch is already merged into a base, and with
 * `--remove` removes them (CLAUDE.md Rule 10). The base is `origin/main`, or each
 * `--base <ref>` given: work that lands on an integration branch before main is
 * merged once it is an ancestor of any base. Branches are kept unless `--branches`
 * is given. Fetch first: a stale base finds fewer, never more.
 *
 * `--branches` also lists local branches merged into a base and checked out in no
 * worktree (a listed worktree's branch counts as free), and `--remove`
 * deletes them with `git branch -D`, after this script's own ancestor check: `-d`
 * judges against HEAD and the upstream instead. A base, `main`, `master`, a branch
 * checked out anywhere and one with no commit of its own are never deleted.
 *
 *   node scripts/worktree-gc.mjs                        # list the merged worktrees
 *   node scripts/worktree-gc.mjs --remove               # and remove them
 *   node scripts/worktree-gc.mjs --base origin/main --base feat/stack
 *                                                       # merged into either
 *   node scripts/worktree-gc.mjs --branches [--remove]  # the merged branches too
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

export const BASE = 'origin/main'

const DEFAULT_BRANCHES = ['main', 'master']
const USAGE = 'usage: node scripts/worktree-gc.mjs [--base <ref>]... [--branches] [--remove]'

// A branch just created from a base is "merged" too, and is about to be worked on. It sits at the base while the
// base has not moved, and its reflog shows no commit of its own once it has.
const atBaseReason = (ref) => `at ${ref}, possibly just started`
const FRESH_REASON = 'no commit since it was created, possibly just started'

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ remove: boolean, branches: boolean, bases: string[] }} `bases` is `[BASE]` when none is given
 */
export function parseArgs (argv) {
  const options = { remove: false, branches: false, bases: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--remove') options.remove = true
    else if (arg === '--branches') options.branches = true
    else if (arg === '--base' || arg.startsWith('--base=')) {
      const ref = arg === '--base' ? argv[++i] : arg.slice('--base='.length)
      if (!ref || ref.startsWith('-')) throw new Error('--base needs a ref')
      options.bases.push(ref)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return { ...options, bases: options.bases.length > 0 ? [...new Set(options.bases)] : [BASE] }
}

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

/** Names that are a base, or the local branch a base tracks, and the default branches: never offered. */
function baseBranchNames (bases) {
  return new Set([...DEFAULT_BRANCHES, ...bases.flatMap((base) => (base.local ? [base.local] : []))])
}

/**
 * Sorts every linked worktree into removable or kept, with the reason.
 * `git` is injected so the rules can be tested without a repository.
 * `mergedInto` names the first base the branch is an ancestor of, or nothing.
 * @param {{ entries: ReturnType<typeof parseWorktreeList>,
 *   bases: Array<{ ref: string, head: string, local?: string }>, cwd: string,
 *   mergedInto: (branch: string) => string | undefined, isDirty: (path: string) => boolean,
 *   isFresh: (branch: string) => boolean }} input
 */
export function classify ({ entries, bases, cwd, mergedInto, isDirty, isFresh }) {
  const removable = []
  const kept = []
  const baseBranches = baseBranchNames(bases)
  for (const entry of entries.slice(1)) {
    const keep = (reason) => kept.push({ ...entry, reason })
    const atBase = bases.find((base) => base.head === entry.head)
    if (entry.locked) keep('locked')
    else if (entry.detached || !entry.branch) keep('detached HEAD')
    else if (resolve(cwd).startsWith(resolve(entry.path))) keep('current directory')
    else if (baseBranches.has(entry.branch)) keep('a base')
    else if (atBase) keep(atBaseReason(atBase.ref))
    else {
      const into = mergedInto(entry.branch)
      if (!into) keep('not merged')
      else if (isFresh(entry.branch)) keep(FRESH_REASON)
      else if (isDirty(entry.path)) keep('uncommitted changes')
      else removable.push({ ...entry, into })
    }
  }
  return { removable, kept }
}

/**
 * Sorts local branches into deletable or kept, by the rules `classify` applies to a worktree's branch.
 * Only a merged branch held back is reported in `kept`: an unmerged one, a base and a branch checked out in a
 * worktree are skipped without a word, since that is most of the list.
 * @param {{ branches: Array<{ name: string, head: string }>, checkedOut: Set<string>,
 *   bases: Array<{ ref: string, head: string, local?: string }>,
 *   mergedInto: (branch: string) => string | undefined, isFresh: (branch: string) => boolean }} input
 */
export function classifyBranches ({ branches, checkedOut, bases, mergedInto, isFresh }) {
  const removable = []
  const kept = []
  const baseBranches = baseBranchNames(bases)
  for (const { name, head } of branches) {
    if (baseBranches.has(name) || checkedOut.has(name)) continue
    const atBase = bases.find((base) => base.head === head)
    const into = atBase?.ref ?? mergedInto(name)
    if (!into) continue
    if (atBase) kept.push({ name, reason: atBaseReason(atBase.ref) })
    else if (isFresh(name)) kept.push({ name, reason: FRESH_REASON })
    else removable.push({ name, into })
  }
  return { removable, kept }
}

/**
 * Whether a branch's reflog subjects show no commit made on it: only its creation, and moves to commits made elsewhere
 * (a fast-forward to main, a reset). Such a branch is about to be worked on, however far main has moved past it.
 * @param {string[]} subjects
 */
export function noCommitOfItsOwn (subjects) {
  return subjects.length > 0 && subjects.every((subject) => /^(?:branch: Created from |(?:merge [^:]+|pull[^:]*): Fast-forward$|reset: moving to )/.test(subject))
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const succeeds = (args, cwd) => {
  try { git(args, cwd); return true } catch { return false }
}

/**
 * Each ref as the commit it names, and the local branch it is or tracks (`origin/main` tracks `main`).
 * @returns {Array<{ ref: string, head: string, local?: string }>}
 */
export function resolveBases (root, refs) {
  return refs.map((ref) => {
    let head
    try { head = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root).trim() } catch { throw new Error(`unknown base: ${ref}`) }
    if (succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${ref}`], root)) return { ref, head, local: ref }
    if (succeeds(['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`], root)) return { ref, head, local: ref.slice(ref.indexOf('/') + 1) }
    return { ref, head }
  })
}

const mergedIntoFor = (root, bases) => (branch) =>
  bases.find((base) => succeeds(['merge-base', '--is-ancestor', `refs/heads/${branch}`, base.head], root))?.ref
const isFreshFor = (root) => (branch) =>
  noCommitOfItsOwn(git(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], root).split('\n').filter(Boolean))
const listWorktrees = (root) => parseWorktreeList(git(['worktree', 'list', '--porcelain'], root))

/** Runs `classify` against the repository at `root`. */
export function findMergedWorktrees (root, bases = resolveBases(root, [BASE])) {
  return classify({
    entries: listWorktrees(root),
    bases,
    cwd: process.cwd(),
    mergedInto: mergedIntoFor(root, bases),
    isDirty: (path) => git(['status', '--porcelain'], path).trim() !== '',
    isFresh: isFreshFor(root)
  })
}

/**
 * Runs `classifyBranches` against the repository at `root`. `released` holds the branches of worktrees about to
 * be removed, which count as checked out in none.
 */
export function findMergedBranches (root, bases, released = new Set()) {
  const checkedOut = new Set(listWorktrees(root).flatMap((entry) => (entry.branch && !released.has(entry.branch) ? [entry.branch] : [])))
  const branches = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], root).split('\n').filter(Boolean).map((line) => {
    const [refname = '', head = ''] = line.split(' ')
    return { name: refname.replace(/^refs\/heads\//, ''), head }
  })
  return classifyBranches({ branches, checkedOut, bases, mergedInto: mergedIntoFor(root, bases), isFresh: isFreshFor(root) })
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  let options
  let bases
  try {
    options = parseArgs(process.argv.slice(2))
    bases = resolveBases(root, options.bases)
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`)
    process.exit(2)
  }
  const { remove, branches } = options
  const into = (item) => (bases.length > 1 ? ` (into ${item.into})` : '')
  const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`
  let failed = false

  const worktrees = findMergedWorktrees(root, bases)
  for (const { path, branch, reason } of worktrees.kept) console.log(`keep    ${path} [${branch ?? '-'}]: ${reason}`)
  for (const item of worktrees.removable) {
    const { path, branch } = item
    if (!remove) { console.log(`merged  ${path} [${branch}]${into(item)}`); continue }
    try {
      git(['worktree', 'remove', path], root)
      console.log(`removed ${path} [${branch}]${into(item)}`)
    } catch (err) {
      failed = true
      console.error(`failed  ${path} [${branch}]: ${String(err.stderr ?? err.message).trim()}`)
    }
  }

  let found = noun(worktrees.removable.length, 'worktree', 'worktrees')
  let count = worktrees.removable.length
  if (branches) {
    const released = remove ? new Set() : new Set(worktrees.removable.map((item) => item.branch))
    const merged = findMergedBranches(root, bases, released)
    for (const { name, reason } of merged.kept) console.log(`keep    branch ${name}: ${reason}`)
    for (const item of merged.removable) {
      if (!remove) { console.log(`merged  branch ${item.name}${into(item)}`); continue }
      try {
        git(['branch', '-D', '--', item.name], root)
        console.log(`deleted branch ${item.name}${into(item)}`)
      } catch (err) {
        failed = true
        console.error(`failed  branch ${item.name}: ${String(err.stderr ?? err.message).trim()}`)
      }
    }
    found += ` and ${noun(merged.removable.length, 'branch', 'branches')}`
    count += merged.removable.length
  }
  if (!remove && count > 0) console.log(`\n${found} merged; rerun with --remove to remove them.`)
  if (failed) process.exit(1)
}
