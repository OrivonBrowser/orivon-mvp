// The smallest audio and image files a media element decodes, shared by the fixture page that serves
// them from its own listener and by the server the test runs outside the page.

/** 0.2 s of 8-bit mono silence at 8 kHz: the smallest file `<audio>` decodes. */
export function silentWav (): Uint8Array {
  const samples = 1600
  const bytes = new Uint8Array(44 + samples).fill(0x80)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string): void => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  ascii(36, 'data'); view.setUint32(40, samples, true)
  return bytes
}

/** A 1 x 1 GIF. */
export const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))
