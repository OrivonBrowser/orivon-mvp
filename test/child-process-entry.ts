// Bundled against the shim by ./e2e-child-process.test.ts into the fixture
// app's page script: it drives `child_process` the way ported Node code does.

import { execFile, fork, spawn } from 'child_process'

export interface ChildProcessResults {
  readonly echo: { events: string[], stdout: string }
  readonly native: { code?: string, reason?: string }
  readonly missing: { code?: string }
  readonly forked: { reply?: unknown, fileText?: string, exitCode?: number | null }
  readonly killed: { events: string[] }
  readonly component: { events: string[], stdout: string, stderr: string, fileText?: string }
  readonly error?: string
}

function track (child: ReturnType<typeof spawn>): Promise<string[]> {
  const events: string[] = []
  child.on('spawn', () => events.push('spawn'))
  child.on('exit', (code: number | null, signal: string | null) => events.push(`exit ${String(code)} ${String(signal)}`))
  return new Promise((resolve) => child.on('close', () => resolve(events)))
}

function failure (file: string): Promise<{ code?: string, reason?: string }> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], (error) => {
      const { code, reason } = (error ?? {}) as { code?: string, reason?: string }
      resolve({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
    })
  })
}

const progress: string[] = []
;(globalThis as unknown as { childProcessProgress: string[] }).childProcessProgress = progress

async function run (): Promise<ChildProcessResults> {
  progress.push('spawn echo')
  const echoChild = spawn('/bin/echo', [])
  echoChild.on('error', (error: Error) => progress.push(`echo error ${error.message}`))
  echoChild.on('spawn', () => progress.push('echo spawned'))
  echoChild.on('exit', (code: number | null, signal: string | null) => progress.push(`echo exit ${String(code)} ${String(signal)}`))
  echoChild.stderr?.on('data', (chunk: { toString: () => string }) => progress.push(`echo stderr ${chunk.toString()}`))
  let stdout = ''
  echoChild.stdout?.on('data', (chunk: { toString: () => string }) => { stdout += chunk.toString() })
  const echoEvents = track(echoChild)
  echoChild.stdin?.end('ping from the page')

  progress.push('fork')
  const forkedChild = fork('/child.js', ['argument'], { silent: true })
  forkedChild.stderr?.on('data', (chunk: { toString: () => string }) => progress.push(`fork stderr ${chunk.toString()}`))
  forkedChild.on('exit', (code: number | null, signal: string | null) => progress.push(`fork exit ${String(code)} ${String(signal)}`))
  forkedChild.on('error', (error: Error) => progress.push(`fork error ${error.message}`))
  forkedChild.on('spawn', () => progress.push('fork spawned'))
  forkedChild.stdout?.on('data', (chunk: { toString: () => string }) => progress.push(`fork stdout ${chunk.toString()}`))
  const reply = await new Promise((resolve) => { forkedChild.once('message', resolve); forkedChild.send({ text: 'written by a forked child' }) })
  progress.push('fork replied')
  const orivon = (window as unknown as { orivon: { fs: { readFile: (path: string) => Promise<Uint8Array> } } }).orivon
  const fileText = new TextDecoder().decode(await orivon.fs.readFile('forked.txt'))
  forkedChild.send({ exit: 5 })
  const exitCode = await new Promise<number | null>((resolve) => forkedChild.once('exit', resolve))

  progress.push('kill case')
  const killedChild = spawn('/bin/echo', [])
  const killedEvents = track(killedChild)
  await new Promise((resolve) => killedChild.once('spawn', resolve))
  killedChild.kill()

  progress.push('component')
  const componentChild = spawn('/bin/tour', [])
  componentChild.on('error', (error: Error) => progress.push(`component error ${error.message}`))
  let componentOut = ''
  let componentErr = ''
  componentChild.stdout?.on('data', (chunk: { toString: () => string }) => { componentOut += chunk.toString() })
  componentChild.stderr?.on('data', (chunk: { toString: () => string }) => { componentErr += chunk.toString() })
  const componentEvents = track(componentChild)
  componentChild.stdin?.end('from a component\n')
  const componentFinished = await componentEvents
  const written = await orivon.fs.readFile('from-component.txt').catch(() => undefined)

  return {
    component: { events: componentFinished, stdout: componentOut, stderr: componentErr, ...(written === undefined ? {} : { fileText: new TextDecoder().decode(written) }) },
    echo: { events: await echoEvents, stdout },
    native: await failure('/bin/native'),
    missing: await failure('git'),
    forked: { reply, fileText, exitCode },
    killed: { events: await killedEvents }
  }
}

;(globalThis as unknown as { childProcessE2e: { run: () => Promise<ChildProcessResults> } }).childProcessE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } as ChildProcessResults } }
}
