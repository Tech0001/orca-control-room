const MAX_TERMINAL_TEXT_LENGTH = 32_000

const terminalKeys = Object.freeze({
  ArrowUp: Object.freeze({ text: '\x1b[A' }),
  ArrowDown: Object.freeze({ text: '\x1b[B' }),
  ArrowRight: Object.freeze({ text: '\x1b[C' }),
  ArrowLeft: Object.freeze({ text: '\x1b[D' }),
  Enter: Object.freeze({ enter: true }),
  Escape: Object.freeze({ text: '\x1b' }),
  Tab: Object.freeze({ text: '\t' }),
  ShiftTab: Object.freeze({ text: '\x1b[Z' }),
  Backspace: Object.freeze({ text: '\x7f' }),
  Delete: Object.freeze({ text: '\x1b[3~' }),
  Home: Object.freeze({ text: '\x1b[H' }),
  End: Object.freeze({ text: '\x1b[F' }),
  PageUp: Object.freeze({ text: '\x1b[5~' }),
  PageDown: Object.freeze({ text: '\x1b[6~' }),
  Interrupt: Object.freeze({ interrupt: true })
})

export function resolveTerminalInput(value) {
  const body = value && typeof value === 'object' ? value : {}
  const hasText = Object.hasOwn(body, 'text')
  const hasKey = Object.hasOwn(body, 'key')
  if (hasText === hasKey) throw new Error('Terminal input must contain exactly one text or key action')

  if (hasText) {
    if (
      typeof body.text !== 'string' ||
      body.text.length === 0 ||
      body.text.length > MAX_TERMINAL_TEXT_LENGTH
    ) {
      throw new Error('Terminal text must contain 1–32,000 characters')
    }
    return { text: body.text }
  }

  if (typeof body.key !== 'string' || !Object.hasOwn(terminalKeys, body.key)) {
    throw new Error('Unsupported terminal key')
  }
  return { ...terminalKeys[body.key] }
}
