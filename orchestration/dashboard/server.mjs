/**
 * The owner's panel for the autonomous build loop.
 *
 * Shows what is running, what needs a decision, and what is waiting for review.
 * Lets the owner answer a queued question, pause a category, or stop the loop.
 *
 * NO DEPENDENCIES (Rule 8) and BOUND TO 127.0.0.1 ONLY. This server has write
 * endpoints -- it can stop the loop and inject answers the loop acts on -- so
 * it is never exposed beyond loopback, and it rejects any request carrying a
 * non-localhost Origin. That second check is not belt-and-braces: a page on any
 * website can POST to 127.0.0.1 in the user's browser, and DNS rebinding turns
 * a hostname the attacker controls into a loopback address. It is the same
 * threat class as T12 in the security model, and a local server with write
 * endpoints is exactly its target.
 *
 *   npm run panel        -> http://127.0.0.1:7717
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendJsonl, ensureState, loadBoard, loadControl, readJsonl,
  readHeartbeat, saveControl, statePaths
} from '../board.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const STATE = join(REPO, 'orchestration', 'state')
const PORT = Number(process.env.ORIVON_PANEL_PORT ?? 7717)

ensureState(STATE)

/**
 * A browser page on any origin can POST to 127.0.0.1. Requiring the Origin
 * header to be absent (curl, fetch from the page itself) or loopback is what
 * stops a random tab from stopping the build loop.
 */
function originAllowed (req) {
  const origin = req.headers.origin
  if (origin === undefined) return true // non-browser client
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody (req) {
  const chunks = []
  for await (const c of req) {
    chunks.push(c)
    // A local panel has no reason to accept a large body, and an unbounded
    // read is a trivial memory exhaustion.
    if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) throw new Error('body too large')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new Error('invalid json')
  }
}

function snapshot () {
  const p = statePaths(STATE)
  const board = loadBoard(STATE)
  const control = loadControl(STATE)
  const questions = readJsonl(p.questions)
  const answered = new Set(readJsonl(p.answers).map((a) => a.id))
  const beat = readHeartbeat(STATE)

  const tasks = board.tasks ?? []
  const by = (s) => tasks.filter((t) => t.status === s)

  const staleMs = beat?.at ? Date.now() - Date.parse(beat.at) : null

  return {
    // Order matters: this is the order the page renders, and it is by how much
    // the owner's attention is needed.
    awaitingReview: by('pr-open'),
    openQuestions: questions.filter((q) => !answered.has(q.id)),
    onAssumption: tasks.filter((t) => t.status === 'running' && t.assumption),
    running: by('running'),
    blocked: tasks.filter((t) => (t.blockedOn ?? []).length > 0 && t.status === 'todo'),
    conflicts: by('conflict'),
    counts: {
      todo: by('todo').length,
      running: by('running').length,
      prOpen: by('pr-open').length,
      merged: by('merged').length,
      abandoned: by('abandoned').length,
      total: tasks.length
    },
    control,
    cycle: board.cycle ?? 0,
    heartbeat: beat,
    // The loop runs every 23 minutes; more than ~50 without a beat means it is
    // not running at all, which otherwise looks identical to "nothing to do".
    stalled: staleMs !== null && staleMs > 50 * 60 * 1000,
    categories: [...new Set(tasks.map((t) => t.category))].sort()
  }
}

const server = createServer(async (req, res) => {
  if (!originAllowed(req)) return json(res, 403, { error: 'cross-origin requests are refused' })

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(join(HERE, 'index.html'), 'utf8'))
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, snapshot())
    }

    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const { id, answer } = await readBody(req)
      if (!id || typeof answer !== 'string' || answer.trim() === '') {
        return json(res, 400, { error: 'id and a non-empty answer are required' })
      }
      appendJsonl(statePaths(STATE).answers, {
        id, answer: answer.trim(), at: new Date().toISOString(), by: 'owner'
      })
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/control') {
      const { pause, resume, globalStop } = await readBody(req)
      const control = loadControl(STATE)
      const paused = new Set(control.pausedCategories ?? [])
      if (typeof pause === 'string') paused.add(pause)
      if (typeof resume === 'string') paused.delete(resume)
      if (typeof globalStop === 'boolean') control.globalStop = globalStop
      control.pausedCategories = [...paused].sort()
      saveControl(STATE, control)
      return json(res, 200, control)
    }

    return json(res, 404, { error: 'not found' })
  } catch (error) {
    return json(res, 400, { error: String(error.message ?? error) })
  }
})

// 127.0.0.1 explicitly, never 0.0.0.0. This is the actual control; the Origin
// check above is what handles the browser-side attack that loopback alone does
// not stop.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Orivon panel: http://127.0.0.1:${PORT}`)
  console.log(`State: ${STATE}`)
})
