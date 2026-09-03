const userPromptPattern = /^[›❯](?:\s+|$)/
const agentLeadPattern = /^(?:●|•)(?:\s+|$)/
const completedActivityPattern = /^(?:[✻✽✶*]\s*)?.+\bfor\s+\d+(?:\.\d+)?(?:ms|s|m|h)\b/i
const transientActivityPattern =
  /^(?:[✻✽✶✢✣✤✥✦✧⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*]\s*)?(?:baking|brewing|churning|cogitating|combobulating|cooking|crunching|pondering|processing|reasoning|sautéing|stewing|thinking|working)\b/i
const toolLeadPattern =
  /^(?:bash|called|edit|edited|executed|fetch|glob|grep|inspect|inspected|read|ran|running|search|searched|shell|task|tool|update|updated|web|write|wrote)(?:\b|\()/i

export function isTransientTerminalStatus(value) {
  const line = String(value ?? '').trim()
  return (
    !/^[╭╮╰╯┌┐└┘├┤┬┴┼│┃─━┄┅┈┉]/.test(line) &&
    transientActivityPattern.test(line) &&
    (/^[✻✽✶✢✣✤✥✦✧⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*]/.test(line) || /…|\.{3}/.test(line)) &&
    !/\bdone\b/i.test(line) &&
    !completedActivityPattern.test(line)
  )
}

export function terminalLineKind(value) {
  const line = String(value ?? '').trim()
  if (!line) return 'blank'
  if (userPromptPattern.test(line)) return 'prompt'
  if (/^(?:error|fatal|failed|failure)\b/i.test(line) || /^[✗✖⨯]\s?/.test(line)) {
    return 'error'
  }
  if (/^(?:warning|warn)\b/i.test(line) || /^[⚠]\s?/.test(line)) return 'warning'
  if (/^(?:success|done|completed|passed)\b/i.test(line) || /^[✓✔]\s?/.test(line)) {
    return 'success'
  }
  if (isTransientTerminalStatus(line) || completedActivityPattern.test(line)) return 'status'
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
  if (/^auto mode\b|^esc to interrupt\b/i.test(line)) {
    return 'status'
  }
  return 'plain'
}

function withoutConversationIndent(line) {
  return line.startsWith('  ') ? line.slice(2) : line
}

function isPlaceholderPrompt(text) {
  return /^(?:ask (?:codex|claude) to do anything|type a message)/i.test(text)
}

function isTerminalChrome(line, kind) {
  const text = line.trim()
  return (
    kind === 'frame' ||
    kind === 'command' ||
    /^\/[a-z][\w-]*$/i.test(text) ||
    /^(?:auto mode|esc to interrupt|gpt-[\w.-]+\b|…\/)/i.test(text)
  )
}

function isToolLead(line) {
  return agentLeadPattern.test(line) && toolLeadPattern.test(line.replace(agentLeadPattern, ''))
}

export function terminalMessageBlocks(values, agentName = 'Agent') {
  const blocks = []
  let current = null

  const start = (kind, label, line, lineKind, transient = false) => {
    current = { kind, label, transient, lines: [{ text: line, kind: lineKind }] }
    blocks.push(current)
  }
  const append = (line, lineKind) => {
    current.lines.push({ text: line, kind: lineKind })
  }
  const terminal = (line, lineKind) => {
    if (current?.kind === 'terminal') append(line, lineKind)
    else start('terminal', '', line, lineKind)
  }

  for (const value of values ?? []) {
    const raw = String(value ?? '')
    const trimmed = raw.trim()
    const lineKind = terminalLineKind(raw)

    if (!trimmed) {
      if (current && ['user', 'agent', 'tool'].includes(current.kind)) append('', 'blank')
      else terminal('', 'blank')
      continue
    }

    if (userPromptPattern.test(trimmed)) {
      const prompt = trimmed.replace(userPromptPattern, '')
      if (!prompt || isPlaceholderPrompt(prompt)) terminal(trimmed, 'frame')
      else start('user', 'You', prompt, 'prompt')
      continue
    }

    if (lineKind === 'status') {
      const text = trimmed.replace(/^[✻✽✶*]\s*/, '')
      const transient = isTransientTerminalStatus(trimmed)
      if (transient && current?.kind === 'activity' && current.transient) {
        current.lines = [{ text, kind: 'status' }]
      } else {
        start('activity', transient ? 'Thinking' : 'Activity', text, 'status', transient)
      }
      continue
    }

    if (isToolLead(trimmed)) {
      start('tool', 'Tool', trimmed.replace(agentLeadPattern, ''), 'command')
      continue
    }

    if (agentLeadPattern.test(trimmed)) {
      start('agent', agentName, trimmed.replace(agentLeadPattern, ''), 'bullet')
      continue
    }

    if (isTerminalChrome(raw, lineKind)) {
      terminal(raw, lineKind)
      continue
    }

    if (current && ['user', 'agent', 'tool'].includes(current.kind)) {
      append(withoutConversationIndent(raw), lineKind)
      continue
    }

    // A screen can begin halfway through a response after the viewport moves.
    // Treat unmarked prose as agent context instead of anonymous terminal noise.
    start('agent', agentName, withoutConversationIndent(raw), lineKind)
  }

  return blocks
}
