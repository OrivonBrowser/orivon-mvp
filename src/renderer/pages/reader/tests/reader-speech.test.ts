import { describe, expect, it } from 'vitest'
import { SpeechController, chunkText, pickVoice } from '../speech.js'
import type { SpeechEnv, UtteranceLike, VoiceLike } from '../speech.js'

const VOICES: VoiceLike[] = [
  { name: 'Anna', lang: 'de-DE', voiceURI: 'anna' },
  { name: 'Sam', lang: 'en-US', voiceURI: 'sam', default: true },
  { name: 'Kate', lang: 'en-GB', voiceURI: 'kate' }
]

function fake (voices: VoiceLike[] = VOICES) {
  const spoken: Array<{ text: string, rate: number, voice: string | null, utterance: UtteranceLike }> = []
  let cancels = 0
  const texts = new Map<UtteranceLike, string>()
  const env: SpeechEnv = {
    synth: {
      speak: (utterance) => { spoken.push({ text: texts.get(utterance) ?? '', rate: utterance.rate, voice: utterance.voice?.voiceURI ?? null, utterance }) },
      cancel: () => { cancels += 1 },
      getVoices: () => voices
    },
    utterance: (text) => {
      const utterance: UtteranceLike = { rate: 1, voice: null, lang: '', onend: null, onerror: null }
      texts.set(utterance, text)
      return utterance
    }
  }
  const finish = (): void => { spoken[spoken.length - 1]?.utterance.onend?.() }
  return { env, spoken, finish, cancels: () => cancels }
}

describe('chunkText', () => {
  it('keeps a short text whole and splits a long one at sentences', () => {
    expect(chunkText('One. Two.')).toEqual(['One. Two.'])
    const long = `${'Word '.repeat(30).trim()}. ${'More '.repeat(30).trim()}.`
    const chunks = chunkText(long)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true)
    expect(chunks.join(' ')).toBe(long)
  })

  it('splits one very long sentence at spaces', () => {
    const chunks = chunkText('word '.repeat(200).trim())
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true)
    expect(chunks.join(' ').split(' ')).toHaveLength(200)
  })
})

describe('pickVoice', () => {
  it('prefers the chosen voice, then the article\'s language, then the default', () => {
    expect(pickVoice(VOICES, 'en', 'anna')?.voiceURI).toBe('anna')
    expect(pickVoice(VOICES, 'de', null)?.voiceURI).toBe('anna')
    expect(pickVoice(VOICES, 'fr', null)?.voiceURI).toBe('sam')
    expect(pickVoice([], 'en', null)).toBeNull()
  })
})

describe('SpeechController', () => {
  const run = (voices?: VoiceLike[]) => {
    const f = fake(voices)
    const changes: string[] = []
    const speech = new SpeechController(f.env, () => { changes.push(speech.state) })
    speech.setUnits(['First paragraph.', 'Second one.', 'Third.'], 'en')
    return { f, speech, changes }
  }

  it('is unavailable without voices, and then speaks nothing', () => {
    const { f, speech } = run([])
    expect(speech.available).toBe(false)
    speech.play()
    expect(f.spoken).toEqual([])
    expect(speech.state).toBe('idle')
  })

  it('reads the units in order and stops after the last', () => {
    const { f, speech } = run()
    speech.play(0)
    expect(f.spoken.map((s) => s.text)).toEqual(['First paragraph.'])
    expect(speech.state).toBe('playing')
    f.finish()
    expect(speech.index).toBe(1)
    f.finish()
    f.finish()
    expect(f.spoken.map((s) => s.text)).toEqual(['First paragraph.', 'Second one.', 'Third.'])
    expect(speech.state).toBe('idle')
  })

  it('uses the chosen speed and a voice in the article\'s language', () => {
    const { f, speech } = run()
    speech.setRate(1.5)
    speech.play(0)
    expect(f.spoken[0]).toMatchObject({ rate: 1.5, voice: 'sam' })
    speech.setVoice('kate')
    expect(f.spoken[f.spoken.length - 1]).toMatchObject({ rate: 1.5, voice: 'kate', text: 'First paragraph.' })
  })

  it('pauses by stopping and resumes at the same unit', () => {
    const { f, speech } = run()
    speech.play(1)
    speech.pause()
    expect(speech.state).toBe('paused')
    expect(speech.index).toBe(1)
    const before = f.spoken.length
    speech.play()
    expect(f.spoken.length).toBe(before + 1)
    expect(f.spoken[f.spoken.length - 1]?.text).toBe('Second one.')
  })

  it('moves by paragraph, and a late end event of a cancelled unit does nothing', () => {
    const { f, speech } = run()
    speech.play(0)
    const first = f.spoken[0]?.utterance
    speech.next()
    expect(speech.index).toBe(1)
    first?.onend?.()
    expect(speech.index).toBe(1)
    speech.previous()
    speech.previous()
    expect(speech.index).toBe(0)
    speech.next(); speech.next(); speech.next()
    expect(speech.state).toBe('idle')
  })

  it('stops on a real speech error but not on a cancel', () => {
    const { f, speech } = run()
    speech.play(0)
    f.spoken[0]?.utterance.onerror?.({ error: 'canceled' })
    expect(speech.state).toBe('playing')
    f.spoken[0]?.utterance.onerror?.({ error: 'synthesis-failed' })
    expect(speech.state).toBe('idle')
  })
})
