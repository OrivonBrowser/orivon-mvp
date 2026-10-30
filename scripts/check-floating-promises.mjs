/**
 * Fails the build if main-process code floats a promise that can reject.
 *
 * src/main/start.ts ends the whole browser on any unhandled rejection (every tab goes with it), so
 * `void p`, a bare `p`, and `p.then(cb)` with no rejection handler are each a latent crash for a
 * user. A promise is handled when it is awaited, returned, stored, or ends in `.catch(...)` or
 * `.then(a, b)`; `.finally(f)` hands the question to what it is chained on. Electron's
 * `loadURL`/`loadFile` attach their own no-op catch, and `clipboard.writeText` answers a promise that
 * is already resolved: both are allowed. `clipboard.write` is an async function that can reject, so it
 * is awaited like any other.
 *
 * SCOPE: the files the main entries (src/main/start.ts, src/main/index.ts) import, followed
 * through relative imports, tests excluded. The renderer and the preload are never reached, and a
 * rejection there does not end the browser. The verifier host is a utility process whose entry logs
 * an unhandled rejection and keeps running, so only the files it shares with main are in scope.
 * Vendored sources bundled into main (vendor/tsconfig.json) are scanned under the same rule.
 *
 * TYPES: this needs the type checker (a floated call is a promise only by its type), so it asks
 * the TypeScript 7 API (`typescript/unstable/sync`, which drives the native compiler) for the repo's
 * own project. Known limit: an `async` function handed to a callback slot (`emitter.on('x', async
 * () => { ... })`) is not a statement and is not seen.
 *
 * A call that provably cannot reject opts out with `// orivon:floating-ok -- <why>` on its line or the one above.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

/** The files a main-process bundle starts from; `index.ts` is loaded by `start.ts` through `require`. */
export const MAIN_ENTRIES = ['src/main/start.ts', 'src/main/index.ts']

/** Projects whose files are bundled into main, each with the folders of it that are. */
export const PROJECTS = [
  { tsconfig: 'tsconfig.json', entries: MAIN_ENTRIES },
  {
    tsconfig: 'vendor/tsconfig.json',
    entries: ['vendor/electron-chrome-extensions/src/browser/index.ts', 'vendor/electron-chrome-web-store/src/browser/index.ts']
  }
]

const NOT_SOURCE = /(^|\/)tests?\/|\.test\.[cm]?[jt]sx?$|\.d\.ts$/
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\1/g
const OPT_OUT = /orivon:floating-ok\s+--\s+\S/
/**
 * Electron methods allowed to float. `loadURL`/`loadFile`: WebContents attaches its own no-op catch. `writeText`: the
 * main-process clipboard writes the text before it answers, and its promise is resolved already, so it never rejects.
 */
const SELF_HANDLED = new Set(['loadURL', 'loadFile', 'writeText'])

/** `file` as the program names it, or undefined: `./x.js` is `x.ts`, a folder is its index. */
function resolveImport (fromFile, specifier, known) {
  const base = resolve(dirname(fromFile), specifier).replace(/\\/g, '/')
  const stem = base.replace(/\.(?:m|c)?js$/, '')
  for (const candidate of [base, `${stem}.ts`, `${stem}.mts`, `${base}.ts`, `${base}/index.ts`, `${stem}.mjs`, `${base}.mjs`]) {
    if (known.has(candidate)) return candidate
  }
  return undefined
}

/** Every non-test file reachable from `entries` through relative imports, among the `known` files. */
export function reachableFiles (entries, known, read = (file) => readFileSync(file, 'utf8')) {
  const seen = new Set()
  const queue = entries.filter((entry) => known.has(entry))
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || NOT_SOURCE.test(file)) continue
    seen.add(file)
    for (const match of read(file).matchAll(IMPORT)) {
      const target = resolveImport(file, match[2], known)
      if (target !== undefined && !seen.has(target)) queue.push(target)
    }
  }
  return seen
}

/**
 * The leaf expressions of a statement's expression that nothing handles, as `{ node, needsType }`.
 * A `.catch(...)` or a two-argument `.then(...)` ends a chain as handled; `void`, parentheses,
 * `&&`, `||`, `??`, `?:` and the comma operator are looked through; `.finally(f)` is its receiver.
 */
function leaves (node, kinds, out) {
  const { SyntaxKind } = kinds
  switch (node.kind) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.VoidExpression:
      leaves(node.expression, kinds, out)
      return
    case SyntaxKind.AwaitExpression:
      return
    case SyntaxKind.ConditionalExpression:
      leaves(node.whenTrue, kinds, out)
      leaves(node.whenFalse, kinds, out)
      return
    case SyntaxKind.BinaryExpression: {
      const op = node.operatorToken.kind
      if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
        leaves(node.right, kinds, out)
      } else if (op === SyntaxKind.CommaToken) {
        leaves(node.left, kinds, out)
        leaves(node.right, kinds, out)
      }
      return
    }
    case SyntaxKind.CallExpression: {
      const callee = node.expression
      if (callee.kind === SyntaxKind.PropertyAccessExpression) {
        const name = callee.name.text
        if (name === 'catch') { out.push({ node, handledIfPromise: true }); return }
        if (name === 'then' && node.arguments.length >= 2) { out.push({ node, handledIfPromise: true }); return }
        if (name === 'finally') { leaves(callee.expression, kinds, out); return }
        if (SELF_HANDLED.has(name)) { out.push({ node, selfHandled: name }); return }
      }
      out.push({ node })
      return
    }
    case SyntaxKind.Identifier:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.NewExpression:
      out.push({ node })
  }
}

/** True when a value of `type` has a `then` member to await: a promise, or a union that may be one. */
function makeThenable (checker, typeFlags) {
  const cache = new Map()
  const test = (type) => {
    if (type === undefined) return false
    const cached = cache.get(type.id)
    if (cached !== undefined) return cached
    let result = false
    if ((type.flags & (typeFlags.Any | typeFlags.Unknown | typeFlags.Never)) !== 0) result = false
    else if ((type.flags & (typeFlags.Union | typeFlags.Intersection)) !== 0) result = type.getTypes().some(test)
    else result = checker.getPropertyOfType(type, 'then') !== undefined
    cache.set(type.id, result)
    return result
  }
  return test
}

/** Does the method called by `call` come from Electron's own typings? */
function isElectronMethod (checker, call) {
  const symbol = checker.getSymbolAtLocation(call.expression.name)
  const declaration = symbol?.declarations[0]?.resolve()
  return declaration !== undefined && /node_modules[\\/]electron[\\/]/.test(declaration.getSourceFile().fileName)
}

/** The 1-based line and column of `offset` in `text`. */
function positionOf (text, offset) {
  let line = 1
  let lineStart = 0
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) { line++; lineStart = at + 1 }
  return { line, column: offset - lineStart + 1 }
}

/**
 * Every floated, unhandled promise in the main-process files of `project`.
 * @returns {Array<{file: string, line: number, column: number, text: string}>}
 */
function scanProject (api, kinds, root, { tsconfig, entries }) {
  const snapshot = api.updateSnapshot({ openProject: join(root, tsconfig) })
  const project = snapshot.getProject(join(root, tsconfig).replace(/\\/g, '/')) ?? snapshot.getProjects()[0]
  const program = project.program
  const known = new Set(program.getSourceFileNames().map((file) => file.replace(/\\/g, '/')))
  const rootPosix = root.replace(/\\/g, '/')
  const inScope = reachableFiles(entries.map((entry) => `${rootPosix}/${entry}`), known)
  const thenable = makeThenable(project.checker, kinds.TypeFlags)

  const findings = []
  for (const file of [...inScope].sort()) {
    const sourceFile = program.getSourceFile(file)
    if (sourceFile === undefined) continue
    const candidates = []
    const visit = (node) => {
      if (node.kind === kinds.SyntaxKind.ExpressionStatement) {
        const found = []
        leaves(node.expression, kinds, found)
        for (const leaf of found) candidates.push({ statement: node, ...leaf })
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
    if (candidates.length === 0) continue

    const types = project.checker.getTypeAtLocation(candidates.map((candidate) => candidate.node))
    candidates.forEach((candidate, index) => {
      if (candidate.handledIfPromise === true || !thenable(types[index])) return
      if (candidate.selfHandled !== undefined && isElectronMethod(project.checker, candidate.node)) return
      const start = candidate.statement.getStart(sourceFile)
      const { line, column } = positionOf(sourceFile.text, start)
      const lines = sourceFile.text.split('\n')
      if (OPT_OUT.test(lines[line - 1] ?? '') || OPT_OUT.test(lines[line - 2] ?? '')) return
      findings.push({
        file: file.startsWith(`${rootPosix}/`) ? file.slice(rootPosix.length + 1) : file,
        line,
        column,
        text: candidate.statement.getText(sourceFile).split('\n')[0].trim()
      })
    })
  }
  return findings
}

/**
 * @param {string} root Directory to check, typically the repo root.
 * @param {typeof PROJECTS} [projects] Projects to scan, each with its entry files.
 * @returns {Promise<{ ok: boolean, findings: Array<{file: string, line: number, column: number, text: string}> }>}
 */
export async function checkFloatingPromises (root, projects = PROJECTS) {
  const api = await import('typescript/unstable/sync')
  const ast = await import('typescript/unstable/ast')
  const kinds = { SyntaxKind: ast.SyntaxKind, TypeFlags: api.TypeFlags }
  const client = new api.API({ cwd: root })
  const findings = []
  try {
    for (const project of projects) {
      if (existsSync(join(root, project.tsconfig))) findings.push(...scanProject(client, kinds, root, project))
    }
  } finally {
    client.close()
  }
  // A file two projects both reach is scanned by each.
  const unique = [...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.column}`, finding])).values()]
  unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
  return { ok: unique.length === 0, findings: unique }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = await checkFloatingPromises(process.cwd())
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result.findings))
    process.exit(0)
  }
  if (!result.ok) {
    console.error('\nA promise floated in main-process code. A rejection ends the whole browser (src/main/start.ts):\n')
    for (const { file, line, text } of result.findings) console.error(`  ${file}:${line}  ${text}`)
    console.error(
      '\nEnd the chain with .catch((error: unknown) => { console.error(\'[area] what failed:\', error) }),' +
      '\nor await it. A call that provably cannot reject takes `// orivon:floating-ok -- <why>`.\n'
    )
    process.exit(1)
  }
  console.log('check-floating-promises: ok (no unhandled promise in the main process)')
}
