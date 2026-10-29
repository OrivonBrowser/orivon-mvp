import { describe, expect, it } from 'vitest'
import { configureSwarmNode, swarmSwitchedOff } from '../swarm-node-subsystem.js'

describe('the person\'s switch for the Swarm node, as the verifier host is told of it', () => {
  it('is on until the settings are read, and follows the setting after', () => {
    expect(swarmSwitchedOff()).toBe(false)
    configureSwarmNode({ enabled: () => false })
    expect(swarmSwitchedOff()).toBe(true)
    configureSwarmNode({ enabled: () => true })
    expect(swarmSwitchedOff()).toBe(false)
  })
})
