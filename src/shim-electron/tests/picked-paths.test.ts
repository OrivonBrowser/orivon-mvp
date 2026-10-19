import { describe, expect, it } from 'vitest'
import type { DirectoryHandle, FileHandle } from '../../contracts/handles.js'
import { PICKED_ROOT, registerPickedDirectory, registerPickedFile, resolvePickedPath } from '../picked-paths.js'

function fileHandle (closed: Promise<void> = new Promise(() => {})): FileHandle {
  return { id: 'f', closed } as unknown as FileHandle
}
function directoryHandle (closed: Promise<void> = new Promise(() => {})): DirectoryHandle {
  return { id: 'd', closed } as unknown as DirectoryHandle
}

describe('stand-in paths', () => {
  it('a picked file is <root>/<id>/<name> and a picked folder is <root>/<id>', () => {
    const file = registerPickedFile(fileHandle(), 'report.pdf')
    const folder = registerPickedDirectory(directoryHandle())
    expect(file).toMatch(new RegExp(`^${PICKED_ROOT}/[0-9a-f]{24}/report\\.pdf$`))
    expect(folder).toMatch(new RegExp(`^${PICKED_ROOT}/[0-9a-f]{24}$`))
  })

  it('never lies inside the app root, and two picks of one file get two ids', () => {
    const handle = fileHandle()
    const first = registerPickedFile(handle, 'a.txt')
    const second = registerPickedFile(handle, 'a.txt')
    expect(first).not.toBe(second)
    expect(first.startsWith('/orivon/app')).toBe(false)
    expect(PICKED_ROOT.startsWith('/orivon/app/')).toBe(false)
  })

  it('resolves the file, the folder around it and a path inside a picked folder', () => {
    const handle = fileHandle()
    const file = registerPickedFile(handle, 'a.txt')
    const folderPath = registerPickedDirectory(directoryHandle())
    const fileResolved = resolvePickedPath(file)
    expect(fileResolved).toMatchObject({ status: 'pick', relative: 'a.txt', entry: { kind: 'file', name: 'a.txt', handle } })
    expect(resolvePickedPath(file.slice(0, file.lastIndexOf('/')))).toMatchObject({ status: 'pick', relative: '' })
    expect(resolvePickedPath(folderPath)).toMatchObject({ status: 'pick', relative: '', entry: { kind: 'directory' } })
    expect(resolvePickedPath(`${folderPath}/sub//dir/./x.bin`)).toMatchObject({ status: 'pick', relative: 'sub/dir/x.bin' })
  })

  it('a path outside the picked root is not its business, including the app root and a relative path', () => {
    expect(resolvePickedPath('/orivon/app/x')).toBeUndefined()
    expect(resolvePickedPath('/orivon/pickedx/y')).toBeUndefined()
    expect(resolvePickedPath('/etc/passwd')).toBeUndefined()
    expect(resolvePickedPath('picked/x')).toBeUndefined()
  })

  it('the root itself is a list that holds nothing', () => {
    expect(resolvePickedPath(PICKED_ROOT)).toEqual({ status: 'list' })
    expect(resolvePickedPath(`${PICKED_ROOT}/`)).toEqual({ status: 'list' })
  })

  it('an id nothing holds is stale, never another pick', () => {
    expect(resolvePickedPath(`${PICKED_ROOT}/0123456789abcdef01234567/a.txt`)).toEqual({ status: 'stale', id: '0123456789abcdef01234567' })
  })

  it('a .. is resolved before anything is matched: it never stays inside one pick while reaching past its root', () => {
    const one = registerPickedDirectory(directoryHandle())
    const other = registerPickedFile(fileHandle(), 'secret.txt')
    const otherId = other.split('/')[3]!
    // The path names the other pick by its own id, which the page already holds; it resolves to that pick, never to
    // a relative path handed to the first pick's handle.
    expect(resolvePickedPath(`${one}/../${otherId}/secret.txt`)).toMatchObject({ status: 'pick', relative: 'secret.txt', entry: { id: otherId } })
    expect(resolvePickedPath(`${one}/../../app/notes.txt`)).toBeUndefined()
    expect(resolvePickedPath(`${one}/../../../../etc/passwd`)).toBeUndefined()
    expect(resolvePickedPath(`${one}/sub/../../..`)).toBeUndefined()
    expect(resolvePickedPath(`${one}/..`)).toEqual({ status: 'list' })
    expect(resolvePickedPath(`${one}/sub/..`)).toMatchObject({ status: 'pick', relative: '' })
  })

  it('a name with a separator or control character is one safe segment, and an empty or dot name is replaced', () => {
    expect(registerPickedFile(fileHandle(), 'a/b\\c\nd.txt').split('/').slice(4)).toEqual(['a_b_c_d.txt'])
    expect(registerPickedFile(fileHandle(), '..').endsWith('/file')).toBe(true)
    expect(registerPickedFile(fileHandle(), '').endsWith('/file')).toBe(true)
  })

  it('a pick whose handle closed (revoked, or closed by the page) reads as stale from then on', async () => {
    let close: () => void = () => {}
    const closed = new Promise<void>((resolve) => { close = resolve })
    const path = registerPickedFile(fileHandle(closed), 'gone.txt')
    expect(resolvePickedPath(path)?.status).toBe('pick')
    close()
    await closed
    await Promise.resolve()
    expect(resolvePickedPath(path)?.status).toBe('stale')
  })
})
