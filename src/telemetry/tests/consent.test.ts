import { describe, expect, it } from 'vitest'
import {
  NOTICE_VERSION, NO_REASK_MS, UNDECIDED, effectiveConsent, mayAskAgain, parseConsentRecord, recordChoice, serializeConsentRecord, shouldOfferAtWelcome
} from '../consent.js'

const NOW = Date.UTC(2026, 9, 6)

describe('parseConsentRecord', () => {
  it('round-trips a recorded choice', () => {
    const record = recordChoice('accepted', NOW, 'settings')
    expect(parseConsentRecord(serializeConsentRecord(record))).toEqual(record)
    expect(record.noticeVersion).toBe(NOTICE_VERSION)
  })

  it('reads a missing, corrupt or malformed file as no choice', () => {
    for (const raw of [undefined, '', '{', 'null', '[]', '{"state":"yes","atMs":1,"noticeVersion":2}', '{"state":"accepted"}', '{"state":"accepted","atMs":"x","noticeVersion":2}']) {
      expect(parseConsentRecord(raw)).toEqual(UNDECIDED)
    }
  })
})

describe('whether an acceptance ever happened', () => {
  it('is false until the person accepts, stays true through a later refusal, and is false for a refusal alone', () => {
    expect(UNDECIDED.everAccepted).toBe(false)
    expect(recordChoice('declined', NOW, 'welcome').everAccepted).toBe(false)
    const accepted = recordChoice('accepted', NOW, 'welcome')
    expect(accepted.everAccepted).toBe(true)
    expect(recordChoice('declined', NOW + 1, 'settings', NOTICE_VERSION, accepted).everAccepted).toBe(true)
    expect(recordChoice('accepted', NOW + 2, 'settings', NOTICE_VERSION, UNDECIDED).everAccepted).toBe(true)
  })

  it('reads a file without the field as false, unless it records an acceptance', () => {
    expect(parseConsentRecord('{"state":"declined","atMs":1,"noticeVersion":2}').everAccepted).toBe(false)
    expect(parseConsentRecord('{"state":"accepted","atMs":1,"noticeVersion":2}').everAccepted).toBe(true)
    expect(parseConsentRecord('{"state":"declined","atMs":1,"noticeVersion":2,"everAccepted":true}').everAccepted).toBe(true)
    expect(parseConsentRecord('{"state":"declined","atMs":1,"noticeVersion":2,"everAccepted":"yes"}').everAccepted).toBe(false)
  })
})

describe('effectiveConsent', () => {
  it('voids an acceptance given under another notice version, and only an acceptance', () => {
    expect(effectiveConsent(recordChoice('accepted', NOW, 'welcome', NOTICE_VERSION - 1))).toBe('undecided')
    expect(effectiveConsent(recordChoice('accepted', NOW, 'welcome'))).toBe('accepted')
    expect(effectiveConsent(recordChoice('declined', NOW, 'welcome', NOTICE_VERSION - 1))).toBe('declined')
    expect(effectiveConsent(UNDECIDED)).toBe('undecided')
  })
})

describe('asking again', () => {
  it('never asks again within six months of a refusal, then may', () => {
    const declined = recordChoice('declined', NOW, 'welcome')
    expect(mayAskAgain(declined, NOW + 1)).toBe(false)
    expect(mayAskAgain(declined, NOW + NO_REASK_MS - 1)).toBe(false)
    expect(mayAskAgain(declined, NOW + NO_REASK_MS)).toBe(true)
  })

  it('has no question for a person who accepted, and one for a person who has not chosen or whose acceptance is void', () => {
    expect(mayAskAgain(recordChoice('accepted', NOW, 'welcome'), NOW)).toBe(false)
    expect(mayAskAgain(UNDECIDED, NOW)).toBe(true)
    expect(mayAskAgain(recordChoice('accepted', NOW, 'welcome', 1), NOW)).toBe(true)
  })

  it('offers the welcome box only while the system consent is open', () => {
    expect(shouldOfferAtWelcome(UNDECIDED, NOW)).toBe(true)
    expect(shouldOfferAtWelcome(recordChoice('accepted', NOW, 'welcome', 1), NOW)).toBe(true)
    expect(shouldOfferAtWelcome(recordChoice('accepted', NOW, 'welcome'), NOW)).toBe(false)
    expect(shouldOfferAtWelcome(recordChoice('declined', NOW, 'settings'), NOW)).toBe(false)
    expect(shouldOfferAtWelcome(recordChoice('declined', NOW, 'settings'), NOW + 10 * NO_REASK_MS)).toBe(false)
  })
})
