/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapter standing in for Chrome's RE2 limits on `regexFilter` (see
// vendor/firefox-dnr/UPSTREAM.md patch 18). Firefox and Chrome both match
// `regexFilter` in time linear in the URL; this engine hands the pattern to
// the JavaScript RegExp engine, which backtracks, and runs it on the main
// thread for every request. So the pattern is judged before it is ever
// compiled: a pattern whose match time can grow exponentially, or with a
// high power of the URL length, is refused the way RE2 refuses a pattern it
// cannot hold, and `isRegexSupported` answers the same.
//
// The analysis is deliberately conservative. It parses the pattern into a
// small tree and works on the ASCII characters a URL can hold (a URL is
// ASCII once serialised). It refuses:
//   - a pattern over MAX_REGEX_FILTER_LENGTH characters (Chrome's 2 KB cap);
//   - backreferences and lookarounds, which RE2 does not have at all;
//   - a variable repetition inside a repeated group unless one delimiter
//     character starts or ends every iteration and appears nowhere else in
//     it, so each iteration has exactly one way to be cut ("(a+)+", "(a*)*",
//     "([a-z]+\.?)+" are refused; "(?:[a-z0-9-]+\.)*" is kept);
//   - an alternation inside a repeated group whose branches can start with
//     the same character ("(a|a)+");
//   - three unbounded repetitions in one sequence that can trade characters
//     ("(.*)a(.*)b(.*)").
// Everything an ordinary content-blocker rule needs (anchors, classes,
// literals, one or two ".*", an optional or delimited group) passes.

export const MAX_REGEX_FILTER_LENGTH = 2048

/** A repetition counts as unbounded for the analysis from this many repeats on. */
const MANY = 8
/** More unbounded repetitions than this in one sequence is refused outright. */
const MAX_UNBOUNDED_PER_SEQUENCE = 64

const ASCII = 128

function emptySet() {
  return new Uint8Array(ASCII)
}

function setOfCode(code) {
  const set = emptySet()
  if (code < ASCII) set[code] = 1
  return set
}

function fillRange(set, from, to) {
  for (let c = Math.max(0, from); c <= Math.min(ASCII - 1, to); c++) set[c] = 1
}

function unionOf(...sets) {
  const out = emptySet()
  for (const set of sets) {
    for (let c = 0; c < ASCII; c++) if (set[c]) out[c] = 1
  }
  return out
}

function complementOf(set) {
  const out = emptySet()
  for (let c = 0; c < ASCII; c++) out[c] = set[c] ? 0 : 1
  return out
}

function intersects(a, b) {
  for (let c = 0; c < ASCII; c++) if (a[c] && b[c]) return true
  return false
}

function isSubset(a, b) {
  for (let c = 0; c < ASCII; c++) if (a[c] && !b[c]) return false
  return true
}

/** Add the other case of every letter: the `i` flag may be on, so assume it. */
function foldCase(set) {
  for (let c = 65; c <= 90; c++) {
    if (set[c] || set[c + 32]) {
      set[c] = 1
      set[c + 32] = 1
    }
  }
  return set
}

function digitSet() {
  const set = emptySet()
  fillRange(set, 48, 57)
  return set
}

function wordSet() {
  const set = digitSet()
  fillRange(set, 65, 90)
  fillRange(set, 97, 122)
  set[95] = 1
  return set
}

function spaceSet() {
  const set = emptySet()
  for (const c of [9, 10, 11, 12, 13, 32]) set[c] = 1
  return set
}

function dotSet() {
  const set = complementOf(emptySet())
  set[10] = 0
  set[13] = 0
  return set
}

class Unsupported extends Error {}

const CLASS_ESCAPES = {
  d: digitSet,
  D: () => complementOf(digitSet()),
  w: wordSet,
  W: () => complementOf(wordSet()),
  s: spaceSet,
  S: () => complementOf(spaceSet()),
}

const CONTROL_ESCAPES = { t: 9, n: 10, v: 11, f: 12, r: 13, 0: 0 }

// Tree nodes: { t: 'lit', set } one character from a set; { t: 'seq', items };
// { t: 'alt', alts }; { t: 'rep', body, min, max }. Zero-width items (anchors,
// word boundaries) are dropped: they match no character.

function seqOf(items) {
  const flat = []
  for (const item of items) {
    if (item.t === 'seq') flat.push(...item.items)
    else flat.push(item)
  }
  return flat.length === 1 ? flat[0] : { t: 'seq', items: flat }
}

class Parser {
  constructor(source) {
    this.src = source
    this.pos = 0
  }

  parse() {
    const node = this.alternation()
    if (this.pos < this.src.length) throw new Unsupported('unbalanced group')
    return node
  }

  alternation() {
    const alts = [this.sequence()]
    while (this.src[this.pos] === '|') {
      this.pos++
      alts.push(this.sequence())
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', alts }
  }

  sequence() {
    const items = []
    while (this.pos < this.src.length && this.src[this.pos] !== '|' && this.src[this.pos] !== ')') {
      const atom = this.atom()
      if (atom === null) continue
      items.push(this.quantified(atom))
    }
    return seqOf(items)
  }

  quantified(atom) {
    const ch = this.src[this.pos]
    let min
    let max
    if (ch === '*') [min, max] = [0, Infinity]
    else if (ch === '+') [min, max] = [1, Infinity]
    else if (ch === '?') [min, max] = [0, 1]
    else if (ch === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(this.pos))
      if (!m) return atom
      min = Number(m[1])
      max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min
      this.pos += m[0].length - 1
    } else return atom
    this.pos++
    if (this.src[this.pos] === '?') this.pos++
    if (max === 1 && min === 1) return atom
    return { t: 'rep', body: atom, min, max }
  }

  atom() {
    const ch = this.src[this.pos++]
    switch (ch) {
      case '(':
        return this.group()
      case '[':
        return this.characterClass()
      case '.':
        return { t: 'lit', set: dotSet() }
      case '^':
      case '$':
        return null
      case '\\':
        return this.escape()
      case '*':
      case '+':
      case '?':
        throw new Unsupported('nothing to repeat')
      default:
        return { t: 'lit', set: foldCase(setOfCode(ch.charCodeAt(0))) }
    }
  }

  group() {
    if (this.src[this.pos] === '?') {
      const kind = this.src.slice(this.pos, this.pos + 3)
      if (kind.startsWith('?=') || kind.startsWith('?!') || kind === '?<=' || kind === '?<!') {
        throw new Unsupported('lookaround')
      }
      if (kind.startsWith('?:')) this.pos += 2
      else if (kind.startsWith('?<')) {
        const end = this.src.indexOf('>', this.pos)
        if (end < 0) throw new Unsupported('group name')
        this.pos = end + 1
      } else throw new Unsupported('group syntax')
    }
    const inner = this.alternation()
    if (this.src[this.pos] !== ')') throw new Unsupported('unbalanced group')
    this.pos++
    return inner
  }

  escape() {
    const ch = this.src[this.pos++]
    if (ch === undefined) throw new Unsupported('trailing backslash')
    if (CLASS_ESCAPES[ch]) return { t: 'lit', set: CLASS_ESCAPES[ch]() }
    if (ch === 'b' || ch === 'B') return null
    if (/[1-9]/.test(ch) || ch === 'k') throw new Unsupported('backreference')
    return { t: 'lit', set: foldCase(setOfCode(this.escapedCode(ch))) }
  }

  /** The code of a single-character escape; `ch` was just consumed. */
  escapedCode(ch) {
    if (ch in CONTROL_ESCAPES) return CONTROL_ESCAPES[ch]
    if (ch === 'x') return this.hexDigits(2)
    if (ch === 'u') return this.hexDigits(4)
    if (ch === 'c') {
      const letter = this.src[this.pos++] ?? ''
      return letter.charCodeAt(0) % 32
    }
    return ch.charCodeAt(0)
  }

  hexDigits(count) {
    const digits = this.src.slice(this.pos, this.pos + count)
    if (!new RegExp(`^[0-9a-fA-F]{${String(count)}}$`).test(digits)) return 0x10000
    this.pos += count
    return parseInt(digits, 16)
  }

  characterClass() {
    let negated = false
    if (this.src[this.pos] === '^') {
      negated = true
      this.pos++
    }
    const set = emptySet()
    while (this.pos < this.src.length && this.src[this.pos] !== ']') {
      const first = this.classAtom()
      const isRange = this.src[this.pos] === '-' && this.src[this.pos + 1] !== ']' && this.pos + 1 < this.src.length
      if (typeof first !== 'number') {
        for (let c = 0; c < ASCII; c++) if (first[c]) set[c] = 1
      } else if (isRange) {
        this.pos++
        const last = this.classAtom()
        if (typeof last !== 'number') {
          set[first] = 1
          set[45] = 1
          for (let c = 0; c < ASCII; c++) if (last[c]) set[c] = 1
        } else fillRange(set, first, last)
      } else if (first < ASCII) set[first] = 1
    }
    if (this.src[this.pos] !== ']') throw new Unsupported('unterminated class')
    this.pos++
    foldCase(set)
    return { t: 'lit', set: negated ? complementOf(set) : set }
  }

  /** A character code, or a set for a class escape. */
  classAtom() {
    const ch = this.src[this.pos++]
    if (ch !== '\\') return ch.charCodeAt(0)
    const esc = this.src[this.pos++]
    if (esc === undefined) throw new Unsupported('trailing backslash')
    if (CLASS_ESCAPES[esc]) return CLASS_ESCAPES[esc]()
    if (esc === 'b') return 8
    return this.escapedCode(esc)
  }
}

function nullable(node) {
  switch (node.t) {
    case 'lit':
      return false
    case 'seq':
      return node.items.every(nullable)
    case 'alt':
      return node.alts.some(nullable)
    default:
      return node.min === 0 || nullable(node.body)
  }
}

function charsOf(node) {
  switch (node.t) {
    case 'lit':
      return node.set
    case 'seq':
      return unionOf(...node.items.map(charsOf))
    case 'alt':
      return unionOf(...node.alts.map(charsOf))
    default:
      return charsOf(node.body)
  }
}

function firstOf(node) {
  switch (node.t) {
    case 'lit':
      return node.set
    case 'seq': {
      const sets = []
      for (const item of node.items) {
        sets.push(firstOf(item))
        if (!nullable(item)) break
      }
      return unionOf(...sets)
    }
    case 'alt':
      return unionOf(...node.alts.map(firstOf))
    default:
      return firstOf(node.body)
  }
}

/** Whether some repetition inside `node` (or `node` itself) can repeat a variable number of times. */
function hasVariableRepeat(node) {
  switch (node.t) {
    case 'lit':
      return false
    case 'seq':
      return node.items.some(hasVariableRepeat)
    case 'alt':
      return node.alts.some(hasVariableRepeat)
    default:
      return node.max !== node.min || hasVariableRepeat(node.body)
  }
}

function branchesOf(node) {
  return node.t === 'alt' ? node.alts : [node]
}

function itemsOf(node) {
  return node.t === 'seq' ? node.items : [node]
}

/**
 * Whether every iteration of `body` begins (or every one ends) with a single
 * character no other part of the iteration can match, so consecutive
 * iterations can only be cut apart one way.
 */
function isDelimited(body) {
  for (const atEnd of [true, false]) {
    const delimiters = []
    const rests = []
    let ok = true
    for (const branch of branchesOf(body)) {
      const items = itemsOf(branch)
      const edge = atEnd ? items[items.length - 1] : items[0]
      if (!edge || edge.t !== 'lit') {
        ok = false
        break
      }
      delimiters.push(edge.set)
      const rest = atEnd ? items.slice(0, -1) : items.slice(1)
      rests.push(...rest.map(charsOf))
    }
    if (!ok) continue
    const delimiter = unionOf(...delimiters)
    if (!rests.some(rest => intersects(rest, delimiter))) return true
  }
  return false
}

function alternativesOverlap(node) {
  switch (node.t) {
    case 'lit':
      return false
    case 'seq':
      return node.items.some(alternativesOverlap)
    case 'alt': {
      const firsts = node.alts.map(firstOf)
      for (let i = 0; i < firsts.length; i++) {
        for (let j = i + 1; j < firsts.length; j++) if (intersects(firsts[i], firsts[j])) return true
      }
      return node.alts.some(alternativesOverlap)
    }
    default:
      return alternativesOverlap(node.body)
  }
}

const NESTED = 'regexFilter repeats a group whose repetitions can match the same text in many ways'
const POLYNOMIAL = 'regexFilter has too many overlapping unbounded repetitions'

/** Returns a reason when the repeated body can be cut up in more than one way. */
function repeatedBodyProblem(rep) {
  if (rep.max < MANY) return null
  const body = rep.body
  if (alternativesOverlap(body)) return NESTED
  if (!hasVariableRepeat(body)) return null
  if (nullable(body) || !isDelimited(body)) return NESTED
  return null
}

/** Two unbounded repetitions in one sequence "trade characters" when the items between them can be shared out. */
function interacts(items, i, j) {
  const left = charsOf(items[i])
  const right = charsOf(items[j])
  if (!intersects(left, right)) return false
  const middle = items.slice(i + 1, j).filter(item => !nullable(item)).map(charsOf)
  for (let split = 0; split <= middle.length; split++) {
    if (middle.slice(0, split).every(set => isSubset(set, left)) &&
        middle.slice(split).every(set => isSubset(set, right))) {
      return true
    }
  }
  return false
}

function sequenceProblem(items) {
  const unbounded = []
  items.forEach((item, index) => {
    if (item.t === 'rep' && item.max >= MANY) unbounded.push(index)
  })
  if (unbounded.length < 3) return null
  if (unbounded.length > MAX_UNBOUNDED_PER_SEQUENCE) return POLYNOMIAL
  const edge = (a, b) => interacts(items, unbounded[a], unbounded[b])
  for (let a = 0; a < unbounded.length; a++) {
    for (let b = a + 1; b < unbounded.length; b++) {
      if (!edge(a, b)) continue
      for (let c = b + 1; c < unbounded.length; c++) if (edge(a, c) && edge(b, c)) return POLYNOMIAL
    }
  }
  return null
}

function treeProblem(node) {
  switch (node.t) {
    case 'lit':
      return null
    case 'seq':
      return sequenceProblem(node.items) ?? firstProblem(node.items)
    case 'alt':
      return firstProblem(node.alts)
    default:
      return repeatedBodyProblem(node) ?? treeProblem(node.body)
  }
}

function firstProblem(nodes) {
  for (const node of nodes) {
    const problem = treeProblem(node)
    if (problem) return problem
  }
  return null
}

/**
 * Why a `regexFilter` may not be run by the JavaScript RegExp engine, or
 * `null` when it may. Syntax errors are the caller's own `new RegExp` check.
 *
 * @param {string} regexFilter
 * @returns {{ kind: 'syntax' | 'complexity', message: string } | null}
 */
export function regexFilterProblem(regexFilter) {
  if (regexFilter.length > MAX_REGEX_FILTER_LENGTH) {
    return {
      kind: 'complexity',
      message: `regexFilter is longer than ${String(MAX_REGEX_FILTER_LENGTH)} characters`,
    }
  }
  let tree
  try {
    tree = new Parser(regexFilter).parse()
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error
    return { kind: 'syntax', message: `regexFilter uses syntax that is not supported (${error.message})` }
  }
  const problem = treeProblem(tree)
  return problem ? { kind: 'complexity', message: problem } : null
}
