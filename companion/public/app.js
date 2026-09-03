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

function createCard(lane) {
  const node = laneTemplate.content.firstElementChild.cloneNode(true)
  const card = {
    node,
    name: node.querySelector('.lane-name'),
    role: node.querySelector('.lane-role'),
    dot: node.querySelector('.status-dot'),
    meta: node.querySelector('.lane-meta'),
    screen: node.querySelector('.screen'),
    children: node.querySelector('.children'),
    unread: node.querySelector('.unread'),
    composer: node.querySelector('.composer'),
    input: node.querySelector('.composer input')
  }
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
    try {
      await api('/api/send', {
        method: 'POST',
        body: JSON.stringify({ handle: current.handle, text })
      })
      card.input.value = ''
      await poll(true)
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
  card.name.textContent = lane.name
  card.role.textContent = roleLabel(lane.role)
  card.dot.className = `status-dot ${terminal?.connected ? 'active' : 'offline'}`
  card.meta.textContent = terminal
    ? `${terminal.workspaceName} · ${terminal.branch || terminal.worktreePath}`
    : `${lane.worktreePath} · terminal unavailable`
  card.unread.hidden = terminal?.unread !== true
  const childCount = terminal?.childCount ?? 0
  card.children.hidden = childCount === 0
  card.children.textContent = `${childCount} child${childCount === 1 ? '' : 'ren'}`
  const inputDisabled = !terminal?.writable
  const sendButton = card.composer.querySelector('button')
  if (sendButton.disabled !== inputDisabled) sendButton.disabled = inputDisabled
  if (card.input.disabled !== inputDisabled) card.input.disabled = inputDisabled
  const nextText = lane.screen?.lines?.join('\n') || terminal?.preview || 'Waiting for terminal…'
  if (card.screen.textContent !== nextText) {
    const previousScrollTop = card.screen.scrollTop
    const pinnedToBottom =
      card.screen.scrollHeight - card.screen.scrollTop - card.screen.clientHeight < 18
    card.screen.textContent = nextText
    card.screen.scrollTop = pinnedToBottom
      ? card.screen.scrollHeight
      : Math.min(previousScrollTop, Math.max(0, card.screen.scrollHeight - card.screen.clientHeight))
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
  if (polling && !force) return
  polling = true
  try {
    const state = await api('/api/state')
    renderState(state)
    connection.textContent = `Live · ${state.lanes.length} lanes`
    connection.classList.add('online')
  } catch (error) {
    connection.textContent = error instanceof Error ? error.message : String(error)
    connection.classList.remove('online')
  } finally {
    polling = false
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
  content.textContent = 'Loading…'
  transcriptDialog.showModal()
  try {
    const result = await api(`/api/transcript?handle=${encodeURIComponent(lane.terminal.handle)}`)
    content.textContent = result.lines.join('\n')
    content.scrollTop = content.scrollHeight
  } catch (error) {
    content.textContent = error instanceof Error ? error.message : String(error)
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
