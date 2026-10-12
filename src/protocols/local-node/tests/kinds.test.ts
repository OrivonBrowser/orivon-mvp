import { describe, expect, it } from 'vitest'
import { kindNamed } from '../kinds.js'
import { envName } from '../protocol.js'

describe('kindNamed', () => {
  it('finds the kinds this build runs by their names, and nothing else', () => {
    expect(kindNamed('swarm-node')?.noun).toBe('Swarm node')
    expect(kindNamed('nothing-node')).toBeUndefined()
    expect(kindNamed('')).toBeUndefined()
  })
})

describe('envName', () => {
  it('writes a kind\'s variable as ORIVON_<NAME>_<SUFFIX>', () => {
    expect(envName('swarm-node', 'DIR')).toBe('ORIVON_SWARM_NODE_DIR')
    expect(envName('swarm-node', 'LOG')).toBe('ORIVON_SWARM_NODE_LOG')
  })
})
