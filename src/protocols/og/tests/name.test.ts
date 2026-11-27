import { describe, expect, it } from 'vitest'
import { MAX_LABEL_BYTES, keyOf, ogLabelFromHost } from '../name.js'

const refused = expect.objectContaining({ failure: 'invalid-name' })

describe('ogLabelFromHost', () => {
  it('reads the label of a name under .og, with or without a trailing dot', () => {
    expect(ogLabelFromHost('alice.og')).toBe('alice')
    expect(ogLabelFromHost('a.og')).toBe('a')
    expect(ogLabelFromHost('a-b-9.og')).toBe('a-b-9')
    expect(ogLabelFromHost('alice.og.')).toBe('alice')
  })

  it('refuses a host that is not under .og', () => {
    for (const host of ['alice.eth', 'alice', 'alice.og.eth', '', 'og', '.og', 'alice.ogg']) expect(() => ogLabelFromHost(host), host).toThrow(refused)
  })

  it('refuses a label that is not in ENSIP-15 form, so one name has one spelling', () => {
    for (const host of ['Alice.og', 'al ice.og', 'al_ice.og', 'ａlice.og', `a${String.fromCodePoint(0x200d)}b.og`]) expect(() => ogLabelFromHost(host), host).toThrow(refused)
  })

  it('refuses a host with a label before the name, since Linagee has no sub-names', () => {
    for (const host of ['a.b.og', 'www.alice.og', '..og', 'alice..og']) expect(() => ogLabelFromHost(host), host).toThrow(refused)
    expect(() => ogLabelFromHost('www.alice.og')).toThrow(/no sub-names/)
  })

  it('refuses an internationalised host in punycode, which the address bar sends for any non-ASCII name', () => {
    expect(() => ogLabelFromHost('xn--vitlik-6qa.og')).toThrow(refused)
  })

  it('refuses a label over 32 bytes and takes one of exactly 32', () => {
    expect(ogLabelFromHost(`${'a'.repeat(MAX_LABEL_BYTES)}.og`)).toBe('a'.repeat(MAX_LABEL_BYTES))
    expect(() => ogLabelFromHost(`${'a'.repeat(MAX_LABEL_BYTES + 1)}.og`)).toThrow(refused)
  })

  it('refuses a host that is not ASCII', () => {
    expect(() => ogLabelFromHost('é.og')).toThrow(refused)
  })
})

describe('keyOf', () => {
  it("is the label's UTF-8 bytes, padded with zeros to 32", () => {
    expect(keyOf('ecdn')).toBe(`0x6563646e${'00'.repeat(28)}`)
    expect(keyOf('é')).toBe(`0xc3a9${'00'.repeat(30)}`)
    expect(keyOf('a'.repeat(32))).toBe(`0x${'61'.repeat(32)}`)
  })

  it('is what the registry files the live names under', () => {
    expect(keyOf('chaosroadsmint')).toBe('0x6368616f73726f6164736d696e74000000000000000000000000000000000000')
    expect(keyOf('mason')).toBe(`0x6d61736f6e${'00'.repeat(27)}`)
  })
})
