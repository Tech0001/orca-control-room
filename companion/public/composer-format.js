export function composeAgentPrompt(text, attachments = []) {
  const message = String(text ?? '').trim()
  const imageReferences = attachments
    .map((attachment, index) => {
      const path = typeof attachment?.path === 'string' ? attachment.path : ''
      return path ? `[Attached image ${index + 1}: ${path}]` : ''
    })
    .filter(Boolean)
  return [message, imageReferences.join('\n')].filter(Boolean).join('\n\n')
}

export function shouldSubmitComposer(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing
}

export function shouldFocusComposer(selection) {
  return !selection || selection.isCollapsed
}

const directTerminalKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown'
])

export function terminalInputAction(event, hasSelection = false) {
  if (event.isComposing) return null

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    String(event.key).toLowerCase() === 'c' &&
    !hasSelection
  ) {
    return { key: 'Interrupt', preventDefault: true }
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  if (event.key === 'Tab' && event.shiftKey) {
    return { key: 'ShiftTab', preventDefault: true }
  }
  if (directTerminalKeys.has(event.key)) {
    return {
      key: event.key,
      preventDefault: ['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab', 'PageUp', 'PageDown'].includes(
        event.key
      )
    }
  }
  if (typeof event.key === 'string' && event.key.length === 1) {
    return { text: event.key, preventDefault: false }
  }
  return null
}
