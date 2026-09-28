import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrivonShimError } from '../../errors.js'
import { splitCommand } from '../command-line.js'
import { loadProgram, programUrls } from '../program.js'

const ORIGIN = 'https://app.test'
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])

function serve (files: Record<string, Uint8Array<ArrayBuffer>>): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async (url: string) => {
    const bytes = files[new URL(url).pathname]
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes)
  })
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

afterEach(() => { vi.unstubAllGlobals() })

describe('programUrls', () => {
  it('looks for the program at its path on the app\'s origin, then with .wasm added', () => {
    expect(programUrls('/bin/tool', ORIGIN)).toEqual([`${ORIGIN}/bin/tool`, `${ORIGIN}/bin/tool.wasm`])
    expect(programUrls('tool', ORIGIN)).toEqual([`${ORIGIN}/tool`, `${ORIGIN}/tool.wasm`])
    expect(programUrls('/bin/tool.wasm', ORIGIN)).toEqual([`${ORIGIN}/bin/tool.wasm`])
  })

  it('names nothing on another origin', () => {
    expect(programUrls('//elsewhere.test/tool', ORIGIN)).toEqual([])
  })
})

describe('loadProgram', () => {
  it('compiles a WebAssembly program found under its .wasm name, and fetches it once', async () => {
    const fetchStub = serve({ '/bin/cached.wasm': WASM })
    expect(await loadProgram('/bin/cached', [], ORIGIN)).toBeInstanceOf(WebAssembly.Module)
    await loadProgram('/bin/cached', [], ORIGIN)
    expect(fetchStub.mock.calls.filter(([url]) => String(url).endsWith('cached.wasm'))).toHaveLength(1)
  })

  it('refuses a native program by name, as ENOEXEC', async () => {
    serve({ '/bin/native': ELF })
    await expect(loadProgram('/bin/native', ['-v'], ORIGIN)).rejects.toMatchObject({
      code: 'ENOEXEC', syscall: 'spawn /bin/native', path: '/bin/native', spawnargs: ['-v'], reason: 'excluded'
    })
  })

  it('is ENOENT for a program that is not there, as Node reports a missing one', async () => {
    serve({})
    await expect(loadProgram('git', ['--version'], ORIGIN)).rejects.toMatchObject({ code: 'ENOENT', errno: -2, message: 'spawn git ENOENT' })
  })

  it('is EACCES for a program on another origin, and ENOEXEC for bytes that are not valid WebAssembly', async () => {
    serve({ '/bin/broken.wasm': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 9, 9, 9, 9]) })
    await expect(loadProgram('//elsewhere.test/tool', [], ORIGIN)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(loadProgram('/bin/broken.wasm', [], ORIGIN)).rejects.toMatchObject({ code: 'ENOEXEC' })
  })
})

describe('splitCommand', () => {
  it('splits words and honours quotes and backslashes, as a shell splits a simple command', () => {
    expect(splitCommand('git  clone "a b" \'c d\' e\\ f')).toEqual(['git', 'clone', 'a b', 'c d', 'e f'])
    expect(splitCommand('say "quote \\" inside"')).toEqual(['say', 'quote " inside'])
    expect(splitCommand('empty ""')).toEqual(['empty', ''])
    expect(splitCommand('issue#42 "#quoted"')).toEqual(['issue#42', '#quoted'])
  })

  it('refuses by name a command that needs a shell: pipes, redirects, variables, globs', () => {
    for (const command of ['a | b', 'a > out', 'echo $HOME', 'ls *.txt', 'a && b', 'echo "$HOME"', 'unterminated "quote', 'tool --flag # a comment']) {
      expect(() => splitCommand(command)).toThrow(OrivonShimError)
    }
  })
})
