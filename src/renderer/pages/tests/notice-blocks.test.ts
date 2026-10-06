import { describe, expect, it } from 'vitest'
import { noticeBlocks } from '../settings/notice-blocks.js'

describe('noticeBlocks', () => {
  it('reads headings, paragraphs, lists and tables, and drops the marks', () => {
    const blocks = noticeBlocks([
      '# Privacy notice', '', 'First line', 'of **one** paragraph, see [the page](https://example.org/x).', '',
      '## What it sends', '', '- one `thing`', '- two', '',
      '| Field | Meaning |', '|---|---|', '| `classes.web3` | Seconds. |', '| `stream` | A random number. |'
    ].join('\n'))
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Privacy notice' },
      { kind: 'paragraph', text: 'First line of one paragraph, see the page.' },
      { kind: 'heading', level: 2, text: 'What it sends' },
      { kind: 'list', items: ['one thing', 'two'] },
      { kind: 'table', header: ['Field', 'Meaning'], rows: [['classes.web3', 'Seconds.'], ['stream', 'A random number.']] }
    ])
  })

  it('never produces markup: a tag in the file stays text', () => {
    const [block] = noticeBlocks('<img src=x onerror=alert(1)> hello')
    expect(block).toEqual({ kind: 'paragraph', text: '<img src=x onerror=alert(1)> hello' })
  })

  it('reads an empty file as nothing', () => {
    expect(noticeBlocks('')).toEqual([])
  })
})
