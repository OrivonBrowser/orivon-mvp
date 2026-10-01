// Read aloud: one queue of units (a paragraph, a heading, a list item) spoken in order with the system's
// voices. The browser's speech object and its utterance are passed in, so the queue runs under a test with
// fakes. Pausing stops the speech and keeps the place: the platform pause call is unreliable, and
// resuming from the start of the unit is what a listener expects anyway.
export interface VoiceLike { readonly name: string, readonly lang: string, readonly voiceURI: string, readonly default?: boolean }

export interface UtteranceLike {
  rate: number
  voice: VoiceLike | null
  lang: string
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}

export interface SynthLike {
  speak: (utterance: UtteranceLike) => void
  cancel: () => void
  getVoices: () => VoiceLike[]
}

export interface SpeechEnv {
  readonly synth: SynthLike
  readonly utterance: (text: string) => UtteranceLike
}

export type SpeechState = 'idle' | 'playing' | 'paused'

export const RATES = [0.75, 1, 1.25, 1.5, 2] as const

const CHUNK = 220

/** Sentences gathered up to a length the engines read without cutting off; a sentence longer than that is split at spaces. */
export function chunkText (text: string): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/).filter((sentence) => sentence !== '')
  const chunks: string[] = []
  let current = ''
  const flush = (): void => { if (current !== '') chunks.push(current); current = '' }
  for (const sentence of sentences) {
    if (sentence.length > CHUNK) {
      flush()
      let rest = sentence
      while (rest.length > CHUNK) {
        const cut = rest.lastIndexOf(' ', CHUNK)
        const at = cut > 0 ? cut : CHUNK
        chunks.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      current = rest
    } else if (current.length + sentence.length + 1 > CHUNK) {
      flush()
      current = sentence
    } else {
      current = current === '' ? sentence : `${current} ${sentence}`
    }
  }
  flush()
  return chunks
}

/** The voice to read an article in: the one chosen, else one in the article's language, else the system's default. */
export function pickVoice (voices: readonly VoiceLike[], lang: string, chosen: string | null): VoiceLike | null {
  const picked = voices.find((voice) => voice.voiceURI === chosen)
  if (picked !== undefined) return picked
  const prefix = lang.toLowerCase().split('-')[0] ?? ''
  const same = prefix === '' ? undefined : voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix))
  return same ?? voices.find((voice) => voice.default === true) ?? voices[0] ?? null
}

export class SpeechController {
  state: SpeechState = 'idle'
  /** The unit being read, or the one a pause stopped at. */
  index = 0
  rate = 1
  voiceURI: string | null = null
  lang = ''
  private units: readonly string[] = []
  private generation = 0

  constructor (private readonly env: SpeechEnv, private readonly onChange: () => void) {}

  setUnits (units: readonly string[], lang: string): void {
    this.stop()
    this.units = units
    this.lang = lang
  }

  voices (): VoiceLike[] {
    return this.env.synth.getVoices()
  }

  get available (): boolean {
    return this.voices().length > 0
  }

  play (from = this.index): void {
    if (!this.available || this.units.length === 0) return
    this.index = Math.min(Math.max(0, from), this.units.length - 1)
    this.state = 'playing'
    this.speakUnit()
    this.onChange()
  }

  pause (): void {
    if (this.state !== 'playing') return
    this.generation += 1
    this.env.synth.cancel()
    this.state = 'paused'
    this.onChange()
  }

  stop (): void {
    this.generation += 1
    this.env.synth.cancel()
    this.state = 'idle'
    this.index = 0
    this.onChange()
  }

  next (): void {
    if (this.state === 'idle') return
    this.move(this.index + 1)
  }

  previous (): void {
    if (this.state === 'idle') return
    this.move(this.index - 1)
  }

  setRate (rate: number): void {
    this.rate = rate
    if (this.state === 'playing') this.play(this.index)
    else this.onChange()
  }

  setVoice (uri: string | null): void {
    this.voiceURI = uri
    if (this.state === 'playing') this.play(this.index)
    else this.onChange()
  }

  private move (to: number): void {
    if (to >= this.units.length) {
      this.stop()
      return
    }
    this.index = Math.max(0, to)
    if (this.state === 'playing') this.play(this.index)
    else this.onChange()
  }

  private speakUnit (): void {
    this.generation += 1
    const run = this.generation
    this.env.synth.cancel()
    const chunks = chunkText(this.units[this.index] ?? '')
    const voice = pickVoice(this.voices(), this.lang, this.voiceURI)
    const speakChunk = (at: number): void => {
      const chunk = chunks[at]
      if (chunk === undefined) {
        this.advance(run)
        return
      }
      const utterance = this.env.utterance(chunk)
      utterance.rate = this.rate
      if (voice !== null) {
        utterance.voice = voice
        utterance.lang = voice.lang
      }
      utterance.onend = () => { if (run === this.generation) speakChunk(at + 1) }
      utterance.onerror = (event) => {
        if (run !== this.generation) return
        if (event.error === 'canceled' || event.error === 'interrupted') return
        this.stop()
      }
      this.env.synth.speak(utterance)
    }
    speakChunk(0)
  }

  private advance (run: number): void {
    if (run !== this.generation) return
    if (this.index + 1 >= this.units.length) {
      this.stop()
      return
    }
    this.index += 1
    this.speakUnit()
    this.onChange()
  }
}
