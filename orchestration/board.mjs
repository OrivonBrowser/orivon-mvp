/**
 * Disk for the autonomous build loop. The ONLY module here that does I/O --
 * policy.mjs is pure so it can be tested exhaustively without a filesystem.
 *
 * Everything the loop needs lives in files, and nothing lives in memory between
 * cycles. That is the whole auto-resume mechanism: a run killed by a usage
 * limit, a reboot, or `kill -9` costs at most the cycle it was in, because
 * there is no state to restore.
 *
 * Writes are atomic (temp file + rename) so a process killed mid-write leaves
 * the previous board intact rather than a truncated one. A corrupted board is
 * worse than a stale board -- the loop would either crash every cycle or, worse,
 * silently start from an empty task list and redo finished work.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULTS = {
  maxConcurrent: 3,
  maxAssumptions: 2,
  maxStackDepth: 4,
  /** A lock older than this is assumed to belong to a dead process. */
  lockStaleMs: 90 * 60 * 1000,
  /** Log files to keep. */
  keepRuns: 200
}

export const emptyBoard = () => ({ tasks: [], questions: [], cycle: 0, updated: null })
export const emptyControl = () => ({ globalStop: false, pausedCategories: [] })

const paths = (stateDir) => ({
  board: join(stateDir, 'board.json'),
  control: join(stateDir, 'control.json'),
  questions: join(stateDir, 'questions.jsonl'),
  answers: join(stateDir, 'answers.jsonl'),
  lock: join(stateDir, 'run.lock'),
  runs: join(stateDir, 'runs'),
  heartbeat: join(stateDir, 'heartbeat.json')
})

export function statePaths (stateDir) {
  return paths(stateDir)
}

export function ensureState (stateDir) {
  mkdirSync(join(stateDir, 'runs'), { recursive: true })
  const p = paths(stateDir)
  if (!existsSync(p.board)) writeJson(p.board, emptyBoard())
  if (!existsSync(p.control)) writeJson(p.control, emptyControl())
  for (const f of [p.questions, p.answers]) if (!existsSync(f)) writeFileSync(f, '')
  return p
}

export function loadBoard (stateDir) {
  return readJson(paths(stateDir).board, emptyBoard())
}

export function saveBoard (stateDir, board) {
  writeJson(paths(stateDir).board, { ...board, updated: new Date().toISOString() })
}

export function loadControl (stateDir) {
  return readJson(paths(stateDir).control, emptyControl())
}

export function saveControl (stateDir, control) {
  writeJson(paths(stateDir).control, control)
}

/** Every line of a .jsonl file, skipping anything unparseable rather than throwing. */
export function readJsonl (file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // A half-written final line is expected if a process died mid-append.
      // Skipping it is correct; failing the cycle over it is not.
    }
  }
  return out
}

export function appendJsonl (file, record) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`)
}

/**
 * Answers the loop has not yet applied.
 *
 * The board records the last answer offset it consumed, so an answer is acted
 * on exactly once even though answers.jsonl is append-only and never rewritten.
 */
export function pendingAnswers (stateDir, board) {
  const all = readJsonl(paths(stateDir).answers)
  return all.slice(board.answersConsumed ?? 0)
}

export function markAnswersConsumed (board, count) {
  return { ...board, answersConsumed: (board.answersConsumed ?? 0) + count }
}

/**
 * Take the run lock, or report who holds it.
 *
 * Cron fires on a fixed schedule regardless of whether the previous cycle
 * finished, so overlapping runs are the normal case, not an edge case. Two
 * loops dispatching from the same board would double-dispatch every task.
 *
 * @returns {{ acquired: boolean, heldBy?: number, stale?: boolean }}
 */
export function acquireLock (stateDir, { staleMs = DEFAULTS.lockStaleMs } = {}) {
  const p = paths(stateDir)
  mkdirSync(stateDir, { recursive: true })

  if (existsSync(p.lock)) {
    const held = readJson(p.lock, null)
    const age = held?.at ? Date.now() - Date.parse(held.at) : Infinity

    if (held?.pid && isAlive(held.pid) && age < staleMs) {
      return { acquired: false, heldBy: held.pid, stale: false }
    }
    // Either the process is gone or the lock is older than any real cycle.
    // Taking it over is correct: the alternative is a dead lock file wedging
    // the loop permanently, which fails silently and looks like "it stopped".
  }

  writeJson(p.lock, { pid: process.pid, at: new Date().toISOString() })
  return { acquired: true }
}

export function releaseLock (stateDir) {
  const p = paths(stateDir)
  try {
    const held = readJson(p.lock, null)
    if (held?.pid === process.pid) unlinkSync(p.lock)
  } catch {
    // Already gone. Nothing to do.
  }
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A cheap "the loop is alive" marker the dashboard reads to flag a stall. */
export function heartbeat (stateDir, extra = {}) {
  writeJson(paths(stateDir).heartbeat, { at: new Date().toISOString(), pid: process.pid, ...extra })
}

export function readHeartbeat (stateDir) {
  return readJson(paths(stateDir).heartbeat, null)
}

/** Delete all but the newest `keep` run logs. */
export function pruneRuns (stateDir, keep = DEFAULTS.keepRuns) {
  const dir = paths(stateDir).runs
  if (!existsSync(dir)) return 0
  const files = readdirSync(dir)
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((f) => { try { return statSync(f.path).isFile() } catch { return false } })
    .sort((a, b) => b.name.localeCompare(a.name))
  let removed = 0
  for (const f of files.slice(keep)) {
    try { unlinkSync(f.path); removed++ } catch { /* already gone */ }
  }
  return removed
}

function readJson (file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Atomic: a killed process leaves the previous file, never a truncated one. */
function writeJson (file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}
