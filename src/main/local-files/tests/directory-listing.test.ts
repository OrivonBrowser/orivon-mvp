import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_LISTED_ENTRIES, readDirectory, renderDirectoryListing } from '../directory-listing.js'

describe('renderDirectoryListing', () => {
  it('lists folders first, each with a trailing slash, then files, in name order', () => {
    const page = renderDirectoryListing('file:///home/u/docs', [
      { name: 'b.txt', isDirectory: false }, { name: 'sub', isDirectory: true }, { name: 'a.txt', isDirectory: false }, { name: 'Zeta', isDirectory: true }
    ])
    expect(page.indexOf('>sub/<')).toBeLessThan(page.indexOf('>a.txt<'))
    expect(page.indexOf('>Zeta/<')).toBeLessThan(page.indexOf('>a.txt<'))
    expect(page.indexOf('>a.txt<')).toBeLessThan(page.indexOf('>b.txt<'))
  })

  it('links each entry by an absolute file: address with its name percent-encoded', () => {
    const page = renderDirectoryListing('file:///home/u/docs', [{ name: 'a b#c.html', isDirectory: false }, { name: 'd', isDirectory: true }])
    expect(page).toContain('href="file:///home/u/docs/a%20b%23c.html"')
    expect(page).toContain('href="file:///home/u/docs/d/"')
  })

  it('escapes a name that holds markup, in the text and in the address, and carries no script of its own', () => {
    const name = '"><script>alert(1)</script>.html'
    const page = renderDirectoryListing('file:///home/u/docs/', [{ name, isDirectory: false }])
    expect(page).not.toContain('<script')
    expect(page).not.toContain(name)
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.html')
    expect(page).toContain('%22%3E%3Cscript%3E')
  })

  it('escapes the folder\'s own path in the title and the heading', () => {
    const page = renderDirectoryListing('file:///home/u/%3Cb%3Ex', [])
    expect(page).not.toContain('<b>x')
    expect(page).toContain('&lt;b&gt;x')
  })

  it('links to the parent folder except at the root, and says when it is empty', () => {
    expect(renderDirectoryListing('file:///home/u/docs', [])).toContain('href="file:///home/u/"')
    expect(renderDirectoryListing('file:///', [])).not.toContain('Parent folder')
    expect(renderDirectoryListing('file:///home/u/docs', [])).toContain('This folder is empty')
  })

  it('shows at most MAX_LISTED_ENTRIES and says how many were left out', () => {
    const entries = Array.from({ length: MAX_LISTED_ENTRIES + 3 }, (_, n) => ({ name: `f${String(n).padStart(6, '0')}`, isDirectory: false }))
    const page = renderDirectoryListing('file:///', entries)
    expect(page.match(/<li>/g)).toHaveLength(MAX_LISTED_ENTRIES)
    expect(page).toContain('3 more not shown')
  })
})

describe('readDirectory', () => {
  let dir: string | undefined
  afterEach(async () => { if (dir !== undefined) await rm(dir, { recursive: true, force: true }); dir = undefined })

  it('reads a folder\'s entries, folders marked, and answers undefined for a file or nothing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-listing-'))
    await writeFile(join(dir, 'a.txt'), 'x')
    await mkdir(join(dir, 'sub'))
    await symlink(join(dir, 'sub'), join(dir, 'link'))
    expect(await readDirectory(join(dir, 'a.txt'))).toBeUndefined()
    expect(await readDirectory(join(dir, 'missing'))).toBeUndefined()
    const entries = await readDirectory(dir)
    expect(entries?.map((entry) => [entry.name, entry.isDirectory]).sort()).toEqual([['a.txt', false], ['link', true], ['sub', true]])
  })
})
