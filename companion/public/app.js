import {
  composeAgentPrompt,
  shouldFocusComposer,
  shouldSubmitComposer,
  terminalInputAction
} from './composer-format.js'
import { terminalMessageBlocks } from './terminal-format.js'

const params = new URLSearchParams(location.search)
const token = params.get('token') || 'development-only-token'
const grid = document.querySelector('#grid')
const empty = document.querySelector('#empty')
const connection = document.querySelector('#connection')
const appVersion = document.querySelector('#app-version')
const managerDialog = document.querySelector('#manager-dialog')
const transcriptDialog = document.querySelector('#transcript-dialog')
const laneTemplate = document.querySelector('#lane-template')
const cards = new Map()
const laneSizeStorageKey = 'orca-control-room:lane-sizes:v1'
const minimumLaneWidth = 340
const minimumLaneHeight = 280
const maximumAttachmentCount = 4
const maximumAttachmentBytes = 12 * 1024 * 1024
const terminalTextBatchDelay = 40
let latestState = null
let editorLanes = []
let polling = false
let forcePollQueued = false
let pollFailureCount = 0
let automaticRetryAt = 0

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-control-room-token': token,
      ...(options.headers || {})
    }
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

function roleLabel(role) {
  if (role === 'strategist') return 'Planning strategist'
  if (role === 'advisor') return 'Advisor'
  return 'Department manager'
}

function setSendStatus(card, message, tone = '') {
  clearTimeout(card.sendStatusTimer)
  card.sendStatus.textContent = message
  card.sendStatus.className = 'send-status' + (tone ? ' ' + tone : '')
}

function resizeComposer(textarea) {
  textarea.style.height = 'auto'
  const nextHeight = Math.min(140, Math.max(34, textarea.scrollHeight))
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = textarea.scrollHeight > 140 ? 'auto' : 'hidden'
}

function updateComposerAvailability(card) {
  const disabled = card.sending || !card.lane?.terminal?.writable
  card.input.disabled = disabled
  card.fileInput.disabled = disabled || card.terminalMode
  card.attachButton.disabled = disabled || card.terminalMode
  card.terminalModeButton.disabled = disabled
  card.sendButton.disabled = disabled
}

function scheduleTerminalPoll(card) {
  clearTimeout(card.terminalPollTimer)
  card.terminalPollTimer = setTimeout(() => void poll(true), 120)
}

function enqueueTerminalInput(card, input) {
  const terminal = card.lane?.terminal
  if (!terminal?.writable) {
    setSendStatus(card, 'Terminal is not writable', 'error')
    return Promise.resolve()
  }
  const request = card.terminalSendChain
    .catch(() => undefined)
    .then(async () => {
      const result = await api('/api/input', {
        method: 'POST',
        body: JSON.stringify({ handle: terminal.handle, ...input })
      })
      if (result.send?.accepted !== true) throw new Error('Orca did not accept the terminal input')
      scheduleTerminalPoll(card)
    })
  card.terminalSendChain = request
  request.catch((error) => {
    setSendStatus(card, error instanceof Error ? error.message : String(error), 'error')
  })
  return request
}

function flushTerminalText(card) {
  clearTimeout(card.terminalTextTimer)
  card.terminalTextTimer = null
  if (!card.terminalTextBuffer) return card.terminalSendChain
  const text = card.terminalTextBuffer
  card.terminalTextBuffer = ''
  return enqueueTerminalInput(card, { text })
}

function queueTerminalText(card, text) {
  if (!text) return
  card.terminalTextBuffer += text
  clearTimeout(card.terminalTextTimer)
  card.terminalTextTimer = setTimeout(() => flushTerminalText(card), terminalTextBatchDelay)
}

function queueTerminalKey(card, key) {
  flushTerminalText(card)
  return enqueueTerminalInput(card, { key })
}

function setTerminalMode(card, enabled) {
  if (enabled && (card.input.value.length > 0 || card.attachments.length > 0)) {
    setSendStatus(card, 'Send or clear the current draft before enabling Keys', 'error')
    return
  }
  if (!enabled) flushTerminalText(card)
  card.terminalMode = enabled
  card.input.value = ''
  resizeComposer(card.input)
  card.composer.classList.toggle('terminal-input-mode', enabled)
  card.terminalModeButton.setAttribute('aria-pressed', String(enabled))
  card.terminalModeButton.textContent = enabled ? 'Keys On' : 'Keys'
  card.input.placeholder = enabled ? 'Type directly in terminal…' : 'Send a message…'
  card.input.setAttribute('aria-label', enabled ? 'Direct terminal input' : 'Message')
  card.sendButton.textContent = enabled ? 'Enter' : 'Send'
  setSendStatus(card, '')
  updateComposerAvailability(card)
  card.input.focus()
}

function handleTerminalKeydown(event, card) {
  const hasSelection = card.input.selectionStart !== card.input.selectionEnd
  const action = terminalInputAction(event, hasSelection)
  if (!action) return
  if (action.preventDefault) event.preventDefault()
  if (action.text) {
    queueTerminalText(card, action.text)
    return
  }
  queueTerminalKey(card, action.key)
  if (action.key === 'Enter' || action.key === 'Interrupt') {
    card.input.value = ''
    resizeComposer(card.input)
  }
}

function pasteTerminalText(event, card) {
  const text = event.clipboardData?.getData('text/plain') || ''
  const hasImage = [...(event.clipboardData?.items || [])].some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  )
  if (!text && hasImage) {
    event.preventDefault()
    setSendStatus(card, 'Switch off Keys to send images', 'error')
    return
  }
  if (!text) return
  event.preventDefault()
  const start = card.input.selectionStart ?? card.input.value.length
  const end = card.input.selectionEnd ?? start
  card.input.setRangeText(text, start, end, 'end')
  resizeComposer(card.input)
  queueTerminalText(card, text)
}

function renderAttachments(card) {
  card.attachmentList.hidden = card.attachments.length === 0
  const items = card.attachments.map((attachment, index) => {
    const item = document.createElement('div')
    item.className = 'attachment-item'
    const preview = document.createElement('img')
    preview.src = attachment.previewUrl
    preview.alt = ''
    const name = document.createElement('span')
    name.textContent = attachment.file.name || `Pasted image ${index + 1}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove-attachment'
    remove.textContent = '×'
    remove.title = 'Remove image'
    remove.setAttribute('aria-label', `Remove ${name.textContent}`)
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(attachment.previewUrl)
      card.attachments.splice(index, 1)
      renderAttachments(card)
      card.input.focus()
    })
    item.append(preview, name, remove)
    return item
  })
  card.attachmentList.replaceChildren(...items)
}

function addAttachments(card, files) {
  for (const file of files) {
    if (card.attachments.length >= maximumAttachmentCount) {
      setSendStatus(card, `Up to ${maximumAttachmentCount} images per message`, 'error')
      break
    }
    if (!file.type.startsWith('image/')) {
      setSendStatus(card, 'Only image attachments are supported', 'error')
      continue
    }
    if (file.size > maximumAttachmentBytes) {
      setSendStatus(card, `${file.name || 'Image'} exceeds 12 MiB`, 'error')
      continue
    }
    card.attachments.push({
      file,
      previewUrl: URL.createObjectURL(file),
      uploaded: null
    })
  }
  renderAttachments(card)
}

function clearAttachments(card) {
  for (const attachment of card.attachments) URL.revokeObjectURL(attachment.previewUrl)
  card.attachments = []
  renderAttachments(card)
}

async function uploadAttachment(attachment) {
  if (attachment.uploaded) return attachment.uploaded
  const result = await api('/api/attachment', {
    method: 'POST',
    headers: { 'content-type': attachment.file.type || 'application/octet-stream' },
    body: attachment.file
  })
  attachment.uploaded = result.attachment
  return attachment.uploaded
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 18
}

function renderTerminalLines(element, lines, agentName = 'Agent') {
  const fragment = document.createDocumentFragment()
  for (const block of terminalMessageBlocks(lines, agentName)) {
    const container = document.createElement(block.kind === 'terminal' ? 'div' : 'section')
    container.className = `terminal-block terminal-block-${block.kind}`
    if (block.label) {
      const label = document.createElement('span')
      label.className = 'terminal-block-label'
      label.textContent = block.label
      container.append(label)
    }
    const body = document.createElement('div')
    body.className = 'terminal-block-lines'
    for (const line of block.lines) {
      const row = document.createElement('span')
      row.className = `terminal-line terminal-${line.kind}`
      row.textContent = line.text || '\u00a0'
      body.append(row)
    }
    container.append(body)
    fragment.append(container)
  }
  element.replaceChildren(fragment)
}

function readLaneSizes() {
  try {
    const value = JSON.parse(localStorage.getItem(laneSizeStorageKey) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function writeLaneSize(laneId, size) {
  const sizes = readLaneSizes()
  if (size) sizes[laneId] = size
  else delete sizes[laneId]
  localStorage.setItem(laneSizeStorageKey, JSON.stringify(sizes))
}

function applySavedLaneSize(card, laneId) {
  const size = readLaneSizes()[laneId]
  if (!size) return
  if (Number.isFinite(size.width)) card.node.style.width = `${Math.max(minimumLaneWidth, size.width)}px`
  if (Number.isFinite(size.height)) card.node.style.height = `${Math.max(minimumLaneHeight, size.height)}px`
}

function startLaneResize(event, card) {
  if (card.node.classList.contains('maximized')) return
  event.preventDefault()
  const start = card.node.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const pointerId = event.pointerId
  card.resizeHandle.setPointerCapture(pointerId)
  document.body.classList.add('resizing-lane')

  const move = (nextEvent) => {
    if (nextEvent.pointerId !== pointerId) return
    const maximumWidth = Math.max(minimumLaneWidth, grid.getBoundingClientRect().width)
    const width = Math.min(maximumWidth, Math.max(minimumLaneWidth, start.width + nextEvent.clientX - startX))
    const height = Math.min(2400, Math.max(minimumLaneHeight, start.height + nextEvent.clientY - startY))
    card.node.style.width = `${Math.round(width)}px`
    card.node.style.height = `${Math.round(height)}px`
  }
  const end = (nextEvent) => {
    if (nextEvent.pointerId !== pointerId) return
    card.resizeHandle.removeEventListener('pointermove', move)
    card.resizeHandle.removeEventListener('pointerup', end)
    card.resizeHandle.removeEventListener('pointercancel', end)
    document.body.classList.remove('resizing-lane')
    const finalSize = card.node.getBoundingClientRect()
    writeLaneSize(card.lane.id, {
      width: Math.round(finalSize.width),
      height: Math.round(finalSize.height)
    })
  }
  card.resizeHandle.addEventListener('pointermove', move)
  card.resizeHandle.addEventListener('pointerup', end)
  card.resizeHandle.addEventListener('pointercancel', end)
}

function resizeLaneWithKeyboard(event, card) {
  const directions = {
    ArrowLeft: [-40, 0],
    ArrowRight: [40, 0],
    ArrowUp: [0, -40],
    ArrowDown: [0, 40]
  }
  const delta = directions[event.key]
  if (!delta || card.node.classList.contains('maximized')) return
  event.preventDefault()
  const current = card.node.getBoundingClientRect()
  const width = Math.max(minimumLaneWidth, current.width + delta[0])
  const height = Math.max(minimumLaneHeight, current.height + delta[1])
  card.node.style.width = `${Math.round(width)}px`
  card.node.style.height = `${Math.round(height)}px`
  writeLaneSize(card.lane.id, { width: Math.round(width), height: Math.round(height) })
}

function visibleLines(lane, terminal) {
  if (Array.isArray(lane.screen?.lines) && lane.screen.lines.length > 0) {
    return lane.screen.lines.map(String)
  }
  if (terminal?.preview) return String(terminal.preview).split(/\r?\n/)
  return ['Waiting for terminal…']
}

function createCard(lane) {
  const node = laneTemplate.content.firstElementChild.cloneNode(true)
  const card = {
    node,
    name: node.querySelector('.lane-name'),
    role: node.querySelector('.lane-role'),
    dot: node.querySelector('.status-dot'),
    meta: node.querySelector('.lane-meta'),
    screen: node.querySelector('.screen'),
    jumpLatest: node.querySelector('.jump-latest'),
    children: node.querySelector('.children'),
    unread: node.querySelector('.unread'),
    composer: node.querySelector('.composer'),
    input: node.querySelector('.composer textarea'),
    attachmentList: node.querySelector('.attachment-list'),
    attachButton: node.querySelector('.attach-image'),
    terminalModeButton: node.querySelector('.terminal-mode'),
    fileInput: node.querySelector('.attachment-input'),
    sendButton: node.querySelector('.composer button[type="submit"]'),
    sendStatus: node.querySelector('.send-status'),
    resizeHandle: node.querySelector('.lane-resize-handle'),
    lane,
    attachments: [],
    sending: false,
    terminalMode: false,
    terminalTextBuffer: '',
    terminalTextTimer: null,
    terminalPollTimer: null,
    terminalSendChain: Promise.resolve(),
    screenText: null,
    sendStatusTimer: null
  }
  applySavedLaneSize(card, lane.id)
  card.resizeHandle.addEventListener('pointerdown', (event) => startLaneResize(event, card))
  card.resizeHandle.addEventListener('keydown', (event) => resizeLaneWithKeyboard(event, card))
  card.resizeHandle.addEventListener('dblclick', () => {
    card.node.style.removeProperty('width')
    card.node.style.removeProperty('height')
    writeLaneSize(card.lane.id, null)
  })
  card.jumpLatest.addEventListener('click', () => {
    card.screen.scrollTop = card.screen.scrollHeight
    card.jumpLatest.hidden = true
  })
  card.screen.addEventListener('scroll', () => {
    if (isNearBottom(card.screen)) card.jumpLatest.hidden = true
  })
  card.screen.addEventListener('click', () => {
    const selection = window.getSelection()
    if (!shouldFocusComposer(selection)) return
    if (!card.input.disabled) card.input.focus({ preventScroll: true })
  })
  node.querySelector('.maximize').addEventListener('click', () => {
    node.classList.toggle('maximized')
    node.querySelector('.maximize').textContent = node.classList.contains('maximized') ? '↙' : '↗'
  })
  node.querySelector('.open-native').addEventListener('click', async () => {
    const current = card.lane?.terminal
    if (!current) return
    await api('/api/switch', {
      method: 'POST',
      body: JSON.stringify({ handle: current.handle })
    })
  })
  node.querySelector('.transcript').addEventListener('click', () => void showTranscript(card.lane))
  card.input.addEventListener('input', () => resizeComposer(card.input))
  card.input.addEventListener('keydown', (event) => {
    if (card.terminalMode) {
      handleTerminalKeydown(event, card)
      return
    }
    if (!shouldSubmitComposer(event)) return
    event.preventDefault()
    card.composer.requestSubmit()
  })
  card.input.addEventListener('paste', (event) => {
    if (card.terminalMode) {
      pasteTerminalText(event, card)
      return
    }
    const images = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (images.length === 0) return
    event.preventDefault()
    addAttachments(card, images)
  })
  card.terminalModeButton.addEventListener('click', () => {
    setTerminalMode(card, !card.terminalMode)
  })
  card.attachButton.addEventListener('click', () => card.fileInput.click())
  card.fileInput.addEventListener('change', () => {
    addAttachments(card, [...card.fileInput.files])
    card.fileInput.value = ''
  })
  card.composer.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (card.terminalMode) {
      if (card.sending) return
      queueTerminalKey(card, 'Enter')
      card.input.value = ''
      resizeComposer(card.input)
      return
    }
    const current = card.lane?.terminal
    const text = card.input.value.trim()
    if (!current || (!text && card.attachments.length === 0) || card.sending) return
    card.sending = true
    updateComposerAvailability(card)
    try {
      const uploaded = []
      for (const [index, attachment] of card.attachments.entries()) {
        setSendStatus(card, `Uploading image ${index + 1}/${card.attachments.length}…`)
        uploaded.push(await uploadAttachment(attachment))
      }
      const prompt = composeAgentPrompt(text, uploaded)
      setSendStatus(card, 'Delivering…')
      const result = await api('/api/send', {
        method: 'POST',
        body: JSON.stringify({ handle: current.handle, text: prompt })
      })
      if (result.send?.accepted !== true) throw new Error('Orca did not accept the message')
      card.input.value = ''
      resizeComposer(card.input)
      clearAttachments(card)
      setSendStatus(card, 'Sent', 'success')
      card.sendStatusTimer = setTimeout(() => setSendStatus(card, ''), 2_000)
      void poll(true)
    } catch (error) {
      setSendStatus(card, error instanceof Error ? error.message : String(error), 'error')
    } finally {
      card.sending = false
      updateComposerAvailability(card)
      card.input.focus()
    }
  })
  cards.set(lane.id, card)
  return card
}

function updateCard(card, lane) {
  card.lane = lane
  const terminal = lane.terminal
  const screenError = lane.screen?.error
  const livePtyView = lane.screen?.source === 'stream'
  const fallbackView =
    lane.screen?.source && lane.screen.source !== 'screen' && lane.screen.source !== 'stream'
  card.name.textContent = lane.name
  card.role.textContent = roleLabel(lane.role)
  card.dot.className = `status-dot ${terminal?.connected ? 'active' : 'offline'}`
  const terminalMeta = terminal
    ? `${terminal.workspaceName} · ${terminal.branch || terminal.worktreePath}`
    : `${lane.worktreePath} · terminal unavailable`
  const mirrorMeta = screenError
    ? ' · mirror retrying…'
    : livePtyView
      ? ' · live PTY feed'
      : fallbackView
        ? ' · text fallback'
        : ''
  card.meta.textContent = `${terminalMeta}${mirrorMeta}`
  card.meta.classList.toggle('stale', Boolean(screenError))
  card.meta.title = screenError || ''
  card.unread.hidden = terminal?.unread !== true
  const childCount = terminal?.childCount ?? 0
  card.children.hidden = childCount === 0
  card.children.textContent = `${childCount} child${childCount === 1 ? '' : 'ren'}`
  updateComposerAvailability(card)
  const nextLines = visibleLines(lane, terminal)
  const nextText = nextLines.join('\n')
  if (card.screenText !== nextText) {
    const hadPreviousFrame = card.screenText !== null
    const previousScrollTop = card.screen.scrollTop
    const pinnedToBottom = isNearBottom(card.screen)
    renderTerminalLines(card.screen, nextLines, lane.name)
    card.screenText = nextText
    card.screen.scrollTop = pinnedToBottom
      ? card.screen.scrollHeight
      : Math.min(previousScrollTop, Math.max(0, card.screen.scrollHeight - card.screen.clientHeight))
    card.jumpLatest.hidden = pinnedToBottom || !hadPreviousFrame
  }
}

function renderState(state) {
  latestState = state
  appVersion.textContent = state.version ? `v${state.version}` : 'Backend restart required'
  appVersion.classList.toggle('stale', !state.version)
  document.documentElement.style.setProperty('--columns', String(state.config.columns))
  const gridGap = 7
  const availableWidth = Math.max(0, window.innerWidth - 16)
  const gridWidth = Math.max(
    availableWidth,
    state.config.columns * 420 + (state.config.columns - 1) * gridGap
  )
  const defaultLaneWidth =
    (gridWidth - (state.config.columns - 1) * gridGap) / state.config.columns
  grid.style.width = `${Math.round(gridWidth)}px`
  document.documentElement.style.setProperty('--default-lane-width', `${defaultLaneWidth}px`)
  empty.hidden = state.lanes.length > 0
  grid.hidden = state.lanes.length === 0
  const activeIds = new Set(state.lanes.map((lane) => lane.id))
  for (const [id, card] of cards) {
    if (!activeIds.has(id)) {
      clearTimeout(card.terminalTextTimer)
      clearTimeout(card.terminalPollTimer)
      clearAttachments(card)
      card.node.remove()
      cards.delete(id)
    }
  }
  for (const [index, lane] of state.lanes.entries()) {
    const card = cards.get(lane.id) || createCard(lane)
    updateCard(card, lane)
    const nodeAtIndex = grid.children[index] ?? null
    if (nodeAtIndex !== card.node) grid.insertBefore(card.node, nodeAtIndex)
  }
}

async function poll(force = false) {
  if (!force && Date.now() < automaticRetryAt) return
  if (polling) {
    if (force) forcePollQueued = true
    return
  }
  polling = true
  try {
    const state = await api(force ? '/api/state?force=1' : '/api/state')
    renderState(state)
    connection.textContent = `Live · ${state.lanes.length} lanes`
    connection.classList.add('online')
    pollFailureCount = 0
    automaticRetryAt = 0
  } catch (error) {
    connection.textContent = error instanceof Error ? error.message : String(error)
    connection.classList.remove('online')
    pollFailureCount += 1
    automaticRetryAt = Date.now() + Math.min(30_000, 2_000 * 2 ** (pollFailureCount - 1))
  } finally {
    polling = false
    if (forcePollQueued) {
      forcePollQueued = false
      void poll(true)
    }
  }
}

function pinnedRow(lane, index) {
  const row = document.createElement('div')
  row.className = 'terminal-row'
  const details = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = lane.name
  const path = document.createElement('small')
  path.textContent = lane.worktreePath
  const fields = document.createElement('div')
  fields.className = 'pinned-fields'
  const name = document.createElement('input')
  name.value = lane.name
  name.placeholder = 'Lane name'
  name.addEventListener('input', () => {
    editorLanes[index].name = name.value
  })
  const role = document.createElement('select')
  for (const [value, label] of [
    ['strategist', 'Strategist'],
    ['manager', 'Manager'],
    ['advisor', 'Advisor']
  ]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    role.append(option)
  }
  role.value = lane.role
  role.addEventListener('change', () => {
    editorLanes[index].role = role.value
  })
  fields.append(name, role)
  details.append(title, path, fields)
  const actions = document.createElement('div')
  for (const [label, delta] of [
    ['↑', -1],
    ['↓', 1]
  ]) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', () => {
      const next = index + delta
      if (next < 0 || next >= editorLanes.length) return
      ;[editorLanes[index], editorLanes[next]] = [editorLanes[next], editorLanes[index]]
      renderManager()
    })
    actions.append(button)
  }
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = 'Remove'
  remove.addEventListener('click', () => {
    editorLanes.splice(index, 1)
    renderManager()
  })
  actions.append(remove)
  row.append(details, actions)
  return row
}

function availableRow(terminal) {
  const row = document.createElement('div')
  row.className = 'terminal-row'
  const details = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = terminal.workspaceName
  const path = document.createElement('small')
  path.textContent = terminal.title || terminal.worktreePath
  details.append(title, path)
  const add = document.createElement('button')
  add.type = 'button'
  add.textContent = 'Add'
  add.addEventListener('click', () => {
    editorLanes.push({
      id: crypto.randomUUID(),
      worktreePath: terminal.worktreePath,
      tabId: terminal.tabId,
      name: terminal.workspaceName.replace(/^agent-/i, ''),
      role: 'manager'
    })
    renderManager()
  })
  row.append(details, add)
  return row
}

function renderManager() {
  const pinned = document.querySelector('#pinned-list')
  const available = document.querySelector('#available-list')
  const filter = document.querySelector('#terminal-filter').value.toLowerCase()
  pinned.replaceChildren(...editorLanes.map(pinnedRow))
  const selected = new Set(editorLanes.map((lane) => `${lane.worktreePath}\u0000${lane.tabId}`))
  const choices = (latestState?.available || []).filter(
    (terminal) =>
      !selected.has(terminal.stableId) &&
      `${terminal.workspaceName} ${terminal.title} ${terminal.worktreePath}`
        .toLowerCase()
        .includes(filter)
  )
  available.replaceChildren(...choices.map(availableRow))
}

function openManager() {
  if (!latestState) return
  editorLanes = structuredClone(latestState.config.lanes)
  document.querySelector('#columns').value = latestState.config.columns
  document.querySelector('#save-status').textContent = ''
  renderManager()
  managerDialog.showModal()
}

async function saveManager() {
  const saveStatus = document.querySelector('#save-status')
  saveStatus.textContent = 'Saving…'
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        columns: Number(document.querySelector('#columns').value),
        lanes: editorLanes
      })
    })
    managerDialog.close()
    await poll(true)
  } catch (error) {
    saveStatus.textContent = error instanceof Error ? error.message : String(error)
  }
}

async function showTranscript(lane) {
  if (!lane?.terminal) return
  document.querySelector('#transcript-title').textContent = `${lane.name} history`
  const content = document.querySelector('#transcript-content')
  renderTerminalLines(content, ['Loading…'])
  transcriptDialog.showModal()
  try {
    const result = await api(`/api/transcript?handle=${encodeURIComponent(lane.terminal.handle)}`)
    renderTerminalLines(content, result.lines, lane.name)
    content.scrollTop = content.scrollHeight
  } catch (error) {
    renderTerminalLines(content, [error instanceof Error ? error.message : String(error)])
  }
}

document.querySelector('#manage').addEventListener('click', openManager)
document.querySelector('#empty-manage').addEventListener('click', openManager)
document.querySelector('#refresh').addEventListener('click', () => void poll(true))
document.querySelector('#terminal-filter').addEventListener('input', renderManager)
document.querySelector('#save-config').addEventListener('click', () => void saveManager())
document.querySelector('#close-transcript').addEventListener('click', () => transcriptDialog.close())

await poll()
setInterval(() => void poll(), 2_000)
