import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { downloadAsked, wasAsked } from '../asked-downloads.js'

const contents = (): WebContents & { downloadURL: ReturnType<typeof vi.fn> } => ({ downloadURL: vi.fn() }) as unknown as WebContents & { downloadURL: ReturnType<typeof vi.fn> }

describe('downloads the person asked for', () => {
  it('starts the download and reads it as asked once, in the same tab, a moment after', () => {
    const tab = contents()
    downloadAsked(tab, 'https://a.example/cat.png', 1000)
    expect(tab.downloadURL).toHaveBeenCalledWith('https://a.example/cat.png')
    expect(wasAsked(contents(), 'https://a.example/cat.png', 1001)).toBe(false)
    expect(wasAsked(tab, 'https://a.example/cat.png', 1001)).toBe(true)
    expect(wasAsked(tab, 'https://a.example/cat.png', 1002)).toBe(false)
  })

  it("does not read a page's own download of the same address much later as asked", () => {
    const tab = contents()
    downloadAsked(tab, 'https://a.example/x.bin', 0)
    expect(wasAsked(tab, 'https://a.example/x.bin', 60_000)).toBe(false)
    expect(wasAsked(undefined, 'https://a.example/x.bin', 0)).toBe(false)
  })
})
