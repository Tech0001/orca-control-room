export function terminalLineKind(value) {
  const line = String(value ?? '').trim()
  if (!line) return 'blank'
  if (/^[›❯]\s/.test(line)) return 'prompt'
  if (/^(?:error|fatal|failed|failure)\b/i.test(line) || /^[✗✖⨯]\s?/.test(line)) {
    return 'error'
  }
  if (/^(?:warning|warn)\b/i.test(line) || /^[⚠]\s?/.test(line)) return 'warning'
  if (/^(?:success|done|completed|passed)\b/i.test(line) || /^[✓✔]\s?/.test(line)) {
    return 'success'
  }
  if (/^[╭╮╰╯┌┐└┘├┤┬┴┼│┃─━┄┅┈┉]/.test(line)) return 'frame'
  if (/^(?:[$]|~\s*[❯>$])\s/.test(line)) return 'command'
  if (/^(?:•|●|○|◦|[-*+]|\d+[.)])\s/.test(line)) return 'bullet'
  if (
    /^(?:#{1,6}\s|(?:conversation recap|recommendation|summary|status|plan|objective|result)s?:?\s*$)/i.test(
      line
    )
  ) {
    return 'heading'
  }
  if (/^(?:baked|worked|thinking) for\b|^auto mode\b|^esc to interrupt\b/i.test(line)) {
    return 'status'
  }
  return 'plain'
}
