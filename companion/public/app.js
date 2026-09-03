import { terminalLineKind } from './terminal-format.js'

const params = new URLSearchParams(location.search)
const token = params.get('token') || 'development-only-token'
const grid = document.querySelector('#grid')
const empty = document.querySelector('#empty')
const connection = document.querySelector('#connection')
const managerDialog = document.querySelector('#manager-dialog')
const transcriptDialog = document.querySelector('#transcript-dialog')
const laneTemplate = document.querySelector('#lane-template')
const cards = new Map()
let latestState = null
let editorLanes = []
let polling = false
let forcePollQueued = false

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

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 18
}

function renderTerminalLines(element, lines) {
  const fragment = document.createDocumentFragment()
  for (const line of lines) {
    const row = document.createElement('span')
    row.className = `terminal-line terminal-${terminalLineKind(line)}`
    row.textContent = line || '\u00a0'
    fragment.append(row)
  }
  element.replaceChildren(fragment)
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
    input: node.querySelector('.composer input'),
    sendStatus: node.querySelector('.send-status'),
    screenText: null,
    sendStatusTimer: null
  }
  card.jumpLatest.addEventListener('click', () => {
    card.screen.scrollTop = card.screen.scrollHeight
    card.jumpLatest.hidden = true
  })
  card.screen.addEventListener('scroll', () => {
    if (isNearBottom(card.screen)) card.jumpLatest.hidden = true
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
  card.composer.addEventListener('submit', async (event) => {
    event.preventDefault()
    const current = card.lane?.terminal
    const text = card.input.value.trim()
    if (!current || !text) return
    card.input.disabled = true
    setSendStatus(card, 'Sending…')
    try {
      const result = await api('/api/send', {
        method: 'POST',
        body: JSON.stringify({ handle: current.handle, text })
      })
      if (result.send?.accepted !== true) throw new Error('Orca did not accept the message')
      card.input.value = ''
      setSendStatus(card, 'Sent', 'success')
      card.sendStatusTimer = setTimeout(() => setSendStatus(card, ''), 2_000)
      void poll(true)
    } catch (error) {
      setSendStatus(card, error instanceof Error ? error.message : String(error), 'error')
    } finally {
      card.input.disabled = false
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
  const inputDisabled = !terminal?.writable
  const sendButton = card.composer.querySelector('button')
  if (sendButton.disabled !== inputDisabled) sendButton.disabled = inputDisabled
  if (card.input.disabled !== inputDisabled) card.input.disabled = inputDisabled
  const nextLines = visibleLines(lane, terminal)
  const nextText = nextLines.join('\n')
  if (card.screenText !== nextText) {
    const hadPreviousFrame = card.screenText !== null
    const previousScrollTop = card.screen.scrollTop
    const pinnedToBottom = isNearBottom(card.screen)
    renderTerminalLines(card.screen, nextLines)
    card.screenText = nextText
    card.screen.scrollTop = pinnedToBottom
      ? card.screen.scrollHeight
      : Math.min(previousScrollTop, Math.max(0, card.screen.scrollHeight - card.screen.clientHeight))
    card.jumpLatest.hidden = pinnedToBottom || !hadPreviousFrame
  }
}

function renderState(state) {
  latestState = state
  document.documentElement.style.setProperty('--columns', String(state.config.columns))
  empty.hidden = state.lanes.length > 0
  grid.hidden = state.lanes.length === 0
  const activeIds = new Set(state.lanes.map((lane) => lane.id))
  for (const [id, card] of cards) {
    if (!activeIds.has(id)) {
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
  } catch (error) {
    connection.textContent = error instanceof Error ? error.message : String(error)
    connection.classList.remove('online')
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
    renderTerminalLines(content, result.lines)
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
