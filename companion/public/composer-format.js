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
