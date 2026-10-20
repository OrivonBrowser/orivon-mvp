// Settles the decision-log conflict that two branches adding a row each always make. After `git merge origin/main`
// stops on docs/decisions/decision-log.md: main's rows stay as they are, the branch's rows follow them, renumbered
// after the highest d-number in the file, and in every other file the branch changed, the lines main does not have
// get their references to a renumbered id rewritten. Run it from the worktree root, read what it prints, then commit.
//
//   node scripts/ai/renumber-decisions.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isInvokedDirectly } from '../cli.mjs'

export const LOG = 'docs/decisions/decision-log.md'
const CONFLICT = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/m
const ID = /`d-(\d{4})`/g

/** The log with each conflict settled (theirs first, ours renumbered after), and which id became which. */
export function resolveLog (text) {
  const mapping = new Map()
  let out = text
  for (let match = CONFLICT.exec(out); match !== null; match = CONFLICT.exec(out)) {
    const [whole, ours, theirs] = match
    const rest = out.replace(whole, theirs)
    let next = Math.max(0, ...[...rest.matchAll(ID)].map((m) => Number(m[1]))) + 1
    const renumbered = ours.replace(/^\| `d-(\d{4})` \|/gm, (row, id) => {
      const to = `d-${String(next++).padStart(4, '0')}`
      mapping.set(`d-${id}`, to)
      return `| \`${to}\` |`
    })
    out = out.replace(whole, theirs + renumbered)
  }
  return { text: out, mapping }
}

/** `body` with the ids rewritten on the lines `mainLines` lacks: a line main also has may cite main's own row. */
export function rewriteLines (body, mainLines, mapping) {
  return body.split('\n').map((line) => {
    if (mainLines.has(line)) return line
    // Placeholders first, so d-0698 -> d-0700 and d-0699 -> d-0701 never collide midway.
    let next = line
    for (const [from, to] of mapping) next = next.replaceAll(from, `@@${to}@@`)
    return next.replace(/@@(d-\d{4})@@/g, '$1')
  }).join('\n')
}

if (isInvokedDirectly(import.meta.url)) {
  const { text, mapping } = resolveLog(readFileSync(LOG, 'utf8'))
  writeFileSync(LOG, text)
  const changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { encoding: 'utf8' })
    .split('\n').filter((file) => file !== '' && file !== LOG)
  for (const file of mapping.size === 0 ? [] : changed) {
    let body
    try { body = readFileSync(file, 'utf8') } catch { continue }
    let main
    try { main = execFileSync('git', ['show', `origin/main:${file}`], { encoding: 'utf8' }) } catch { main = '' }
    const out = rewriteLines(body, new Set(main.split('\n')), mapping)
    if (out !== body) { writeFileSync(file, out); console.log(`rewrote ids in ${file}`) }
  }
  for (const [from, to] of mapping) console.log(`${from} -> ${to}`)
  if (mapping.size === 0) console.log(`no conflict in ${LOG}`)
}
