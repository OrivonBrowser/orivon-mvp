import { describe, expect, it } from 'vitest'
import { firstWindowOptions } from '../first-window.js'
import type { ShellServices } from '../shell-services.js'

describe('firstWindowOptions', () => {
  it('changes nothing about how a launch opens until a feature fills it', () => {
    const services = {} as unknown as ShellServices
    expect(firstWindowOptions({ services, isPrivate: false, argv: ['orivon', 'https://a.example/'] })).toEqual({})
    expect(firstWindowOptions({ services, isPrivate: true, argv: [] })).toEqual({})
  })
})
