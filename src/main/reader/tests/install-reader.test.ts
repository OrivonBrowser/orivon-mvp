import { describe, expect, it } from 'vitest'
import type { TabLifecycleListener } from '../../shell/tab-lifecycle.js'
import { installReader } from '../install-reader.js'
import { readerArticles } from '../reader-store.js'

function installed (): TabLifecycleListener {
  let listener: TabLifecycleListener = {}
  const services = {
    settings: { onChange: () => () => {} },
    internalPages: { publish: () => {} },
    tabLifecycle: { subscribe: (next: TabLifecycleListener) => { listener = next } }
  }
  installReader.install({} as never, services as never, {} as never, {} as never)
  return listener
}

const article = { title: 'T', byline: '', site: '', url: 'https://example.com/', lang: 'en', words: 1, blocks: [] }

describe('the reader tab leaving a window', () => {
  it('lets go of its article when it closes, and keeps it when it is only handed to another window', () => {
    const listener = installed()
    const record = { internalPage: 'reader' }
    readerArticles.set(record, article, [], 'a')
    listener.tabClosing?.({ id: 'r', index: 1, record: record as never, reason: 'moved', window: undefined })
    expect(readerArticles.get(record)).toBeDefined()
    listener.tabClosing?.({ id: 'r', index: 1, record: record as never, reason: 'closed', window: undefined })
    expect(readerArticles.get(record)).toBeUndefined()
  })

  it('never touches the article of a tab that is not a reader', () => {
    const listener = installed()
    const record = { internalPage: null }
    readerArticles.set(record, article, [], 'a')
    listener.tabClosing?.({ id: 'x', index: 0, record: record as never, reason: 'closed', window: undefined })
    expect(readerArticles.get(record)).toBeDefined()
  })
})
