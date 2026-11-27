import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { hashOf, sameAddress } from '../hex.js'

describe('hashOf', () => {
  it("is the keccak-256 of a text's UTF-8 bytes, which is what an indexed string of a log carries", () => {
    expect(hashOf('contentcontract')).toBe('0x58d1a44eb778f49875f62ace52dcda3a77ed4f1b085b6668edba23e2aea510ec')
  })

  it('hashes a text that looks like hexadecimal as the characters it is written with, not the bytes it spells', () => {
    const address = '0x4F53Eae17346d6c0f96215Af157c7F8e093E17F1'
    expect(hashOf(address)).toBe(keccak256(new TextEncoder().encode(address)))
    expect(hashOf(address)).toBe('0x76ba0644f6f0a16e5d91f84e29b7f7e11a9e821ba5c1548b58f1d9615695f7b8')
  })
})

describe('sameAddress', () => {
  it('ignores the case an address is written in', () => {
    expect(sameAddress('0xAbC0000000000000000000000000000000000001', '0xabc0000000000000000000000000000000000001')).toBe(true)
    expect(sameAddress('0xabc0000000000000000000000000000000000001', '0xabc0000000000000000000000000000000000002')).toBe(false)
  })
})
