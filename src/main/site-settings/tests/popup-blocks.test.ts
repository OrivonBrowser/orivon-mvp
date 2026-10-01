import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { MAX_BLOCKED_PER_PAGE, PopupBlocks } from '../popup-blocks.js'

class FakeTab extends EventEmitter {}

describe('PopupBlocks', () => {
  it('lists what a page tried to open, newest first, and counts it', () => {
    const blocks = new PopupBlocks<FakeTab>()
    const tab = new FakeTab()
    blocks.add(tab, 'https://a.example/1')
    blocks.add(tab, 'https://a.example/2')
    expect(blocks.list(tab)).toEqual(['https://a.example/2', 'https://a.example/1'])
    expect(blocks.count(tab)).toBe(2)
  })

  it('has nothing for a tab that was never blocked', () => {
    const blocks = new PopupBlocks<FakeTab>()
    expect(blocks.list(new FakeTab())).toEqual([])
    expect(blocks.count(new FakeTab())).toBe(0)
  })

  it('keeps at most the newest fifty', () => {
    const blocks = new PopupBlocks<FakeTab>()
    const tab = new FakeTab()
    for (let i = 0; i < MAX_BLOCKED_PER_PAGE + 5; i += 1) blocks.add(tab, `https://a.example/${String(i)}`)
    expect(blocks.count(tab)).toBe(MAX_BLOCKED_PER_PAGE)
    expect(blocks.list(tab)[0]).toBe(`https://a.example/${String(MAX_BLOCKED_PER_PAGE + 4)}`)
    expect(blocks.list(tab).at(-1)).toBe('https://a.example/5')
  })

  it('forgets everything when the tab loads another document, and says so', () => {
    const blocks = new PopupBlocks<FakeTab>()
    const tab = new FakeTab()
    const heard = vi.fn()
    blocks.add(tab, 'https://a.example/1')
    blocks.onChange(heard)
    tab.emit('did-navigate')
    expect(blocks.count(tab)).toBe(0)
    expect(heard).toHaveBeenCalledWith(tab)
  })

  it('says nothing when a navigation clears an empty record', () => {
    const blocks = new PopupBlocks<FakeTab>()
    const tab = new FakeTab()
    blocks.add(tab, 'https://a.example/1')
    tab.emit('did-navigate')
    const heard = vi.fn()
    blocks.onChange(heard)
    tab.emit('did-navigate')
    expect(heard).not.toHaveBeenCalled()
  })

  it('listens for navigations once however many are added, and keeps tabs apart', () => {
    const blocks = new PopupBlocks<FakeTab>()
    const tab = new FakeTab()
    const other = new FakeTab()
    blocks.add(tab, 'https://a.example/1')
    blocks.add(tab, 'https://a.example/2')
    blocks.add(other, 'https://b.example/')
    expect(tab.listenerCount('did-navigate')).toBe(1)
    tab.emit('did-navigate')
    expect(blocks.count(other)).toBe(1)
  })

  it('tells each listener of a change, survives one that throws, and stops after the removal', () => {
    const blocks = new PopupBlocks<FakeTab>()
    const tab = new FakeTab()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const heard = vi.fn()
    blocks.onChange(() => { throw new Error('boom') })
    const stop = blocks.onChange(heard)
    blocks.add(tab, 'https://a.example/1')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    blocks.add(tab, 'https://a.example/2')
    expect(heard).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
