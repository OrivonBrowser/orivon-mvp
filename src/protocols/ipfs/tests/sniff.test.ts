import { describe, expect, it } from 'vitest'
import { looksLikeHtml } from '../sniff.js'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('looksLikeHtml', () => {
  it('accepts a document that opens with a known tag, any case, after whitespace or a BOM', () => {
    for (const text of ['<!doctype html><title>x</title>', '  \n\t<HTML>', '<html lang="en">', '<head>', '<body>', '<script>1</script>', '<h1>hi</h1>', '<!-- c -->', '﻿<!DOCTYPE HTML>']) {
      expect(looksLikeHtml(bytes(text)), text).toBe(true)
    }
  })

  it('refuses everything else, including a tag name that only starts like one', () => {
    for (const text of ['%PDF-1.7', '', '   ', 'hello', '<htmlx>', '<abbr>', '<?xml version="1.0"?>', '{"a":1}', '<html', '<!doctype svg>']) {
      expect(looksLikeHtml(bytes(text)), text).toBe(false)
    }
    expect(looksLikeHtml(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
  })
})
