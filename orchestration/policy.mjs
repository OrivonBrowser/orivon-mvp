/**
 * The autonomous build loop's decision-making. Pure functions, no I/O.
 *
 * This is the one piece where a silent bug is expensive: the loop runs
 * unattended, so a wrong selection spends real compute on work that will be
 * thrown away, and nobody is watching to notice. Everything above this file is
 * plumbing; this is the part that is unit tested exhaustively.
 *
 * See docs/planning/autonomous-loop-design.md for the decisions encoded here.
 */

/** Statuses that occupy a concurrency slot. */
const ACTIVE = new Set(['running'])

/** Statuses meaning "this task is finished, one way or another". */
const TERMINAL = new Set(['merged', 'abandoned'])

/**
 * Choose what to dispatch this cycle.
 *
 * THE ORDER IS THE POLICY (owner decision L3, 2026-08-26):
 *
 *   1. Unblocked work, catalogue order (which is critical-path order).
 *   2. Only if none: the low-value backlog.
 *   3. Only if none: a blocked task, on a labelled assumption.
 *   4. Only if none: idle.
 *
 * Guessing is the LAST resort, never the second. A loop that guesses while
 * real work was available burns compute on branches that may be discarded, and
 * puts assumptions in front of the owner that never needed to be made.
 *
 * @returns {{ dispatch: Array<{task: object, baseBranch: string, stackDepth: number, assumption: string|null}>,
 *             reason: string, idle: boolean }}
 */
export function selectWork ({ board, control, maxConcurrent, maxAssumptions, maxStackDepth }) {
  if (control.globalStop) {
    return { dispatch: [], reason: 'global stop is set', idle: true }
  }

  const tasks = board.tasks ?? []
  const paused = new Set(control.pausedCategories ?? [])

  const slots = maxConcurrent - tasks.filter((t) => ACTIVE.has(t.status)).length
  if (slots <= 0) {
    return { dispatch: [], reason: `at concurrency limit (${maxConcurrent})`, idle: false }
  }

  // Paths already spoken for this cycle -- by running tasks and by anything
  // selected below. Two agents writing the same file is the one failure the
  // worktree isolation cannot save us from.
  const claimed = tasks.filter((t) => ACTIVE.has(t.status)).flatMap((t) => t.paths ?? [])

  const openAssumptions = tasks.filter(
    (t) => ACTIVE.has(t.status) && t.assumption !== null && t.assumption !== undefined
  ).length

  const eligible = tasks.filter((t) => t.status === 'todo' && !paused.has(t.category) && (t.attempts ?? 0) < 3)

  const dispatch = []
  const reasons = []

  // --- Pass 1 and 2: unblocked work, real first, then the low-value backlog.
  for (const lowValue of [false, true]) {
    for (const t of eligible) {
      if (dispatch.length >= slots) break
      if (Boolean(t.lowValue) !== lowValue) continue
      if ((t.blockedOn ?? []).length > 0) continue
      if (overlaps(t.paths, claimed)) continue

      const base = resolveBase(t, tasks, maxStackDepth)
      if (base === null) continue

      claimed.push(...(t.paths ?? []))
      dispatch.push({ task: t, baseBranch: base.branch, stackDepth: base.depth, assumption: null })
      reasons.push(lowValue ? 'low-value backlog' : 'unblocked work')
    }
    if (dispatch.length > 0) {
      return {
        dispatch,
        reason: `${dispatch.length} task(s) from ${unique(reasons).join(' + ')}`,
        idle: false
      }
    }
  }

  // --- Pass 3: nothing else is available. Proceed on a labelled assumption.
  let assumptionsLeft = maxAssumptions - openAssumptions
  for (const t of eligible) {
    if (dispatch.length >= slots || assumptionsLeft <= 0) break
    const blocking = (t.blockedOn ?? [])[0]
    if (blocking === undefined) continue
    if (overlaps(t.paths, claimed)) continue

    const base = resolveBase(t, tasks, maxStackDepth)
    if (base === null) continue

    claimed.push(...(t.paths ?? []))
    assumptionsLeft--
    dispatch.push({ task: t, baseBranch: base.branch, stackDepth: base.depth, assumption: blocking })
  }

  if (dispatch.length > 0) {
    return {
      dispatch,
      reason: `no unblocked work left; proceeding on ${dispatch.length} labelled assumption(s)`,
      idle: false
    }
  }

  return { dispatch: [], reason: 'nothing dispatchable: idle', idle: true }
}

/**
 * Where a task's branch should start.
 *
 * A dependency that is merged contributes nothing -- its work is on main. A
 * dependency with an open PR is STACKED ON rather than waited for, because the
 * owner chose that nothing merges without them (L1), and waiting for a merge
 * would stall every dependent task until they are next at a keyboard.
 *
 * @returns {{branch: string, depth: number}|null} null if it cannot start yet.
 */
function resolveBase (task, tasks, maxStackDepth) {
  const deps = (task.dependsOn ?? []).map((id) => tasks.find((t) => t.id === id)).filter(Boolean)

  const unmerged = deps.filter((d) => d.status !== 'merged')
  if (unmerged.length === 0) return { branch: 'main', depth: 0 }

  // Stack on the deepest unmerged dependency that actually has a pushed branch.
  // A dependency still `todo` or `running` has no branch to stack on, so the
  // task simply waits -- there is nothing to build against.
  const stackable = unmerged.filter((d) => d.status === 'pr-open' && typeof d.branch === 'string')
  if (stackable.length !== unmerged.length) return null

  const parent = stackable.reduce((a, b) => (depthOf(a, tasks) >= depthOf(b, tasks) ? a : b))
  const depth = depthOf(parent, tasks) + 1

  // Depth counts branches between this one and main, this one included. The
  // cap exists because a rejection near the BASE of a tall stack invalidates
  // everything above it -- so the deeper the stack, the more work one "no"
  // from the owner throws away.
  if (depth >= maxStackDepth) return null

  return { branch: parent.branch, depth }
}

/** How many unmerged ancestors a task has. */
function depthOf (task, tasks, seen = new Set()) {
  if (task === undefined || seen.has(task.id)) return 0
  seen.add(task.id)
  const deps = (task.dependsOn ?? [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((d) => d !== undefined && d.status !== 'merged')
  if (deps.length === 0) return 0
  return 1 + Math.max(...deps.map((d) => depthOf(d, tasks, seen)))
}

/**
 * Whether two path-glob sets could touch the same file.
 *
 * Deliberately conservative -- prefix containment rather than real glob
 * matching. `src/broker/**` and `src/broker/policy/**` overlap, and treating
 * them as disjoint would let two agents write the same tree. A false positive
 * costs one cycle of throughput; a false negative costs a corrupted branch.
 */
function overlaps (a = [], b = []) {
  const strip = (p) => p.replace(/\/?\*+$/, '').replace(/\/$/, '')
  return a.some((x) => b.some((y) => {
    const sx = strip(x)
    const sy = strip(y)
    return sx === sy || sx.startsWith(`${sy}/`) || sy.startsWith(`${sx}/`)
  }))
}

const unique = (xs) => [...new Set(xs)]

/**
 * Apply the owner's answers to the board.
 *
 * Unblocks what was waiting, and -- importantly -- INVALIDATES any running
 * task whose assumption the answer contradicts. Without that, a branch built
 * on a guess the owner has now rejected is quietly kept, and its PR looks
 * exactly as legitimate as any other.
 *
 * @returns {{ board: object, invalidated: object[] }}
 */
export function ingestAnswers (board, answers) {
  if (!answers || answers.length === 0) return { board, invalidated: [] }

  const byId = new Map(answers.map((a) => [a.id, a]))
  const invalidated = []

  const tasks = (board.tasks ?? []).map((t) => {
    let next = t

    const stillBlocked = (t.blockedOn ?? []).filter((q) => !byId.has(q))
    if (stillBlocked.length !== (t.blockedOn ?? []).length) {
      next = { ...next, blockedOn: stillBlocked }
    }

    const answer = t.assumption !== null && t.assumption !== undefined
      ? byId.get(t.assumption)
      : undefined
    if (answer !== undefined && !sameAnswer(answer.answer, t.assumedAnswer)) {
      invalidated.push(t)
      next = { ...next, status: 'todo', assumption: null, assumedAnswer: null, branch: null, pr: null }
    }

    return next
  })

  return { board: { ...board, tasks }, invalidated }
}

/** Loose comparison: the loop records a short label, the owner types prose. */
function sameAnswer (given, assumed) {
  if (assumed === null || assumed === undefined) return false
  const norm = (s) => String(s).trim().toLowerCase()
  return norm(given) === norm(assumed) || norm(given).includes(norm(assumed))
}

/**
 * Fold GitHub's view of each open PR back into the board.
 *
 * @param {object} board
 * @param {Record<number, {state: string, checks?: string}>} prStates
 */
export function reconcile (board, prStates) {
  let tasks = (board.tasks ?? []).map((t) => {
    if (t.status !== 'pr-open' || t.pr === null || t.pr === undefined) return t
    const pr = prStates[t.pr]
    if (pr === undefined) return t

    if (pr.state === 'merged') return { ...t, status: 'merged' }
    if (pr.state === 'closed') return { ...t, status: 'abandoned' }

    // Red CI: back to the queue, and count the attempt. At three, selectWork
    // stops picking it up and it becomes a question for the owner instead of
    // an infinite retry loop.
    if (pr.checks === 'failure') {
      return { ...t, status: 'todo', attempts: (t.attempts ?? 0) + 1, branch: null, pr: null }
    }
    return t
  })

  // A stacked child whose parent just merged now belongs on main. GitHub
  // retargets the PR itself; this keeps the board agreeing with it.
  const merged = new Set(tasks.filter((t) => t.status === 'merged').map((t) => t.branch))
  tasks = tasks.map((t) =>
    t.baseBranch !== 'main' && merged.has(t.baseBranch) ? { ...t, baseBranch: 'main' } : t
  )

  return { ...board, tasks }
}

export const _internals = { overlaps, depthOf, resolveBase, TERMINAL }
