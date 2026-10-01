import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { TabRecord } from '../../shell/tab-types.js'
import { restoredTitle, showTitleUntilLoaded } from '../restored-title.js'

const record = (): TabRecord => ({}) as TabRecord
const page = (title: string): WebContents => ({ getTitle: () => title }) as unknown as WebContents

describe('the restored title', () => {
  it('shows the title a tab had until its page has one of its own', () => {
    const tab = record()
    showTitleUntilLoaded(tab, 'Invoice 2231')
    expect(restoredTitle.state?.(tab, page(''))).toEqual({ title: 'Invoice 2231' })
    expect(restoredTitle.state?.(tab, page('Loaded'))).toEqual({})
    // Once the page has spoken, a later empty title is the page's, not the old one.
    expect(restoredTitle.state?.(tab, page(''))).toEqual({})
  })

  it('adds nothing to a tab that was not restored, or restored without a title', () => {
    const tab = record()
    expect(restoredTitle.state?.(tab, page(''))).toEqual({})
    showTitleUntilLoaded(tab, '')
    expect(restoredTitle.state?.(tab, page(''))).toEqual({})
  })
})
