import { inputChunks, isQueryReply } from './live-protocol.mjs'

const $ = id => document.getElementById(id)
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('live-token') || ''
if (token) sessionStorage.setItem('live-token', token)
history.replaceState(null, '', location.pathname)
const panels = new Map()
let state = null
let updating = null
let metadataError = ''
let noticeTimer
let laneDraft = []
const savedValue = key => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
const saveValue = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }
const writable = terminal => terminal?.connected === true && terminal?.writable === true

function connectionStatus() {
  if (metadataError) {
    $('connection').textContent = 'Orca unavailable · retrying'
    $('connection').title = metadataError
    $('connection').className = 'connection error'
    return
  }
  const live = [...panels.values()].filter(panel => panel.ready).length
  const total = state?.lanes.length || 0
  $('connection').textContent = !state?.paired ? 'Pairing needed' :
    total ? `${live} live${total > live ? ` · ${total - live} unavailable` : ` ${total === 1 ? 'lane' : 'lanes'}`}` : '0 lanes'
  $('connection').title = 'Live means a connected, writable terminal—not that the agent is currently working.'
  $('connection').className = `connection ${total > live ? 'error' : 'online'}`
}

function layout() {
  const count = Math.max(1, state?.lanes.length || 1)
  const grid = $('live-grid')
  const automatic = Math.max(1, Math.floor((grid.clientWidth - 8) / 440))
  const columns = Math.min(count, state?.columns || automatic)
  grid.style.setProperty('--live-columns', columns)
  const rows = Math.min(2, Math.ceil(count / columns))
  grid.style.setProperty('--live-height', `${Math.max(300, (grid.clientHeight - 16 - (rows - 1) * 8) / rows)}px`)
}

function notice(message) {
  $('notice').textContent = message
  $('notice').hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { $('notice').hidden = true }, 7000)
}

async function api(path, value, timeout = 15000) {
  const response = await fetch(`/api/${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { 'x-control-room-token': token, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    signal: AbortSignal.timeout(timeout)
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Request failed')
  return result
}

const icons = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  reconnect: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
  maximize: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>'
}

function button(action, title) {
  const button = document.createElement('button')
  button.className = 'icon'
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[action]}</svg>`
  return button
}

class TerminalPanel {
  constructor(lane, index) {
    this.lane = lane
    this.index = index
    this.ready = false
    this.disposed = false
    this.pending = new Set()
    this.retryDelay = 1000
    this.metadataHealthy = !metadataError
    this.el = document.createElement('section')
    this.el.className = 'live-lane'
    this.el.dataset.lane = String(index)
    this.el.dataset.laneId = lane.id
    this.el.style.order = String(index)
    const header = document.createElement('header')
    this.title = document.createElement('h2')
    this.title.textContent = lane.name
    this.title.title = `${lane.name}\n${lane.worktreePath}`
    this.status = document.createElement('span')
    this.status.className = 'status'
    header.append(this.title, this.status)
    const image = button('image', 'Attach image')
    image.onclick = () => this.file.click()
    const reconnect = button('reconnect', 'Reconnect terminal view')
    reconnect.onclick = async () => { await refresh(); if (!this.disposed) this.connect() }
    const maximize = button('maximize', 'Maximize or restore terminal')
    maximize.onclick = () => { this.el.classList.toggle('maximized'); this.term.focus(); this.resize(true) }
    header.append(image, reconnect, maximize)
    this.banner = document.createElement('div')
    this.banner.className = 'lane-availability'
    this.banner.hidden = true
    this.banner.setAttribute('role', 'status')
    this.availability = document.createElement('span')
    this.reopen = document.createElement('button')
    this.reopen.textContent = 'Reopen in Orca'
    this.reopen.title = 'Open this exact saved tab in Orca using its normal restore behavior. No message is sent.'
    this.reopen.onclick = () => void this.recover()
    this.banner.append(this.availability, this.reopen)
    this.host = document.createElement('div')
    this.host.className = 'terminal-host'
    const footer = document.createElement('footer')
    this.dimensions = document.createElement('span')
    this.error = document.createElement('span')
    this.error.className = 'lane-error'
    footer.append(this.dimensions, this.error)
    this.file = document.createElement('input')
    this.file.type = 'file'
    this.file.accept = 'image/png,image/jpeg,image/webp,image/gif'
    this.file.hidden = true
    this.file.onchange = () => {
      if (this.file.files[0]) void this.attachImage(this.file.files[0])
      this.file.value = ''
    }
    this.el.append(header, this.banner, this.host, footer, this.file)
    $('live-grid').append(this.el)
    const saved = savedValue(`live-lane-size:${lane.id}`)
    if (saved?.width >= 340 && saved?.height >= 280) {
      this.el.style.width = `${saved.width}px`
      this.el.style.height = `${saved.height}px`
    }
    this.term = new window.Terminal({
      fontFamily: '"Maple Mono", "Maple Mono NF", "JetBrainsMono Nerd Font", monospace',
      fontSize: state?.fontSize || 12, lineHeight: 1.12, cursorBlink: true, scrollback: 10000,
      allowProposedApi: false, convertEol: false, disableStdin: true,
      theme: { background: '#0c0d10', foreground: '#d5d8df', cursor: '#7dd3fc',
        selectionBackground: '#334155', black: '#1b1d24', red: '#f38ba8', green: '#a6e3a1',
        yellow: '#f9e2af', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#d5d8df',
        brightBlack: '#7f849c', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
        brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#ffffff' }
    })
    this.fit = new window.FitAddon.FitAddon()
    this.term.loadAddon(this.fit)
    this.term.open(this.host)
    this.fit.fit()
    this.term.onData(data => {
      if (this.restoring || !this.ready) return
      if (isQueryReply(data)) this.send({ type: 'query-reply', data })
      else {
        this.term.scrollToBottom()
        for (const chunk of inputChunks(data)) {
          const id = crypto.randomUUID()
          this.pending.add(id)
          this.send({ type: 'input', data: chunk, id, viewport: this.size() })
        }
      }
    })
    this.term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        this.term.input('\x1b\r', true)
        return false
      }
      const mac = /Mac/.test(navigator.platform)
      if ((mac ? event.metaKey : event.ctrlKey && event.shiftKey) && !event.altKey && event.code === 'KeyC') {
        // Returning false only stops xterm; explicitly cancel Chrome's inspect shortcut too.
        // Consume Copy even without a selection so it can never become terminal Ctrl+C.
        event.preventDefault()
        event.stopPropagation()
        if (this.term.hasSelection()) {
          void navigator.clipboard.writeText(this.term.getSelection()).catch(() => notice('Copy failed; use the browser copy menu'))
        } else notice('Select terminal text to copy')
        return false
      }
      if ((mac ? event.metaKey : event.ctrlKey && event.shiftKey) && event.code === 'KeyV') return false
      return true
    })
    this.host.addEventListener('paste', event => {
      const item = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'))
      if (!item) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void this.attachImage(item.getAsFile())
    }, true)
    this.host.addEventListener('focusin', () => this.resize(true))
    this.host.addEventListener('pointerdown', event => {
      if (event.target === this.host) this.term.focus()
    })
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => {
        this.resize(this.host.contains(document.activeElement))
        if (!this.el.classList.contains('maximized') && (this.el.style.width || this.el.style.height)) {
          saveValue(`live-lane-size:${this.lane.id}`, { width: this.el.offsetWidth, height: this.el.offsetHeight })
        }
      }, 150)
    })
    this.resizeObserver.observe(this.host)
    this.connect()
  }

  update(lane, index) {
    const changedTerminal = this.lane.terminal?.handle !== lane.terminal?.handle
    const changedAvailability = writable(this.lane.terminal) !== writable(lane.terminal) || !this.metadataHealthy
    this.metadataHealthy = true
    this.lane = lane
    this.index = index
    this.el.dataset.lane = String(index)
    // CSS order preserves both the saved position and focused DOM node during reconnects.
    this.el.style.order = String(index)
    this.title.textContent = lane.name
    this.title.title = `${lane.name}\n${lane.worktreePath}`
    this.term.options.fontSize = state.fontSize
    if (changedTerminal || changedAvailability) this.connect()
  }

  size() {
    const size = this.fit.proposeDimensions() || { cols: 80, rows: 24 }
    return { cols: Math.max(2, Math.min(1000, size.cols)), rows: Math.max(2, Math.min(500, size.rows)) }
  }

  resize(claim = false) {
    if (!this.ready) return
    this.send({ type: 'resize', viewport: this.size(), claim })
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) this.ws.send(JSON.stringify(message))
    else if (message.type === 'input') this.error.textContent = 'Disconnected; input was not sent'
  }

  setStatus(text, kind = '') {
    this.status.textContent = text; this.status.className = `status ${kind}`
    connectionStatus()
  }

  stopView() {
    clearTimeout(this.retryTimer)
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.close() }
    this.ready = false
    this.term.options.disableStdin = true
    if (this.pending.size) {
      this.unconfirmed = true
      this.error.textContent = 'Input was unconfirmed; it will not be replayed'
    }
    this.pending.clear()
  }

  unavailable(message, recoverable = false) {
    this.stopView()
    this.banner.hidden = false
    this.availability.textContent = message
    this.reopen.hidden = !recoverable
    this.reopen.disabled = this.recovering === true
    this.el.classList.add('unavailable')
    this.setStatus(this.recovering ? 'Reopening…' : recoverable ? 'Unavailable' : 'Disconnected', 'error')
  }

  async recover() {
    if (this.recovering) return
    this.recovering = true
    this.reopen.disabled = true
    this.setStatus('Reopening…')
    try {
      const result = await api('reopen', { id: this.lane.id }, 45000)
      if (this.disposed) return
      this.error.textContent = ''
      this.availability.textContent = result.alreadyActive ? 'Terminal is active; reconnecting…' :
        'Saved tab opened in Orca. Waiting for its terminal; check Orca if it needs attention.'
      await refresh()
      if (!this.disposed && !this.ready && writable(this.lane.terminal)) this.connect()
    } catch (error) {
      if (!this.disposed) this.error.textContent = `${error.message} No input was replayed.`
    } finally {
      this.recovering = false
      this.reopen.disabled = false
      if (!this.disposed && !this.ready) this.setStatus('Unavailable', 'error')
    }
  }

  connect() {
    if (this.disposed) return
    this.stopView()
    if (!this.metadataHealthy) return this.unavailable('Cannot reach Orca. Last screen retained; reconnecting when Orca returns.')
    if (!writable(this.lane.terminal)) return this.unavailable(
      'Terminal is unavailable or read-only. Last screen retained.', true)
    this.banner.hidden = false
    this.availability.textContent = 'Connecting to the terminal. Any previous screen is not live yet.'
    this.reopen.hidden = true
    this.setStatus('Connecting…')
    const ws = this.ws = new WebSocket(`ws://${location.host}/live`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', token, handle: this.lane.terminal.handle, viewport: this.size() }))
    ws.onmessage = event => {
      if (this.ws !== ws || this.disposed) return
      const frame = JSON.parse(event.data)
      if (frame.type === 'scrollback') {
        this.restoring = true
        this.term.reset()
        if (frame.cols && frame.rows) this.term.resize(frame.cols, frame.rows)
        const snapshot = typeof frame.serialized === 'string' ? frame.serialized : (frame.lines || []).join('\r\n')
        this.term.write(snapshot, () => {
          if (this.ws !== ws || this.disposed || ws.readyState !== WebSocket.OPEN || !this.metadataHealthy || !writable(this.lane.terminal)) return
          this.restoring = false
          this.ready = true
          this.term.options.disableStdin = false
          this.retryDelay = 1000
          this.banner.hidden = true
          this.el.classList.remove('unavailable')
          this.setStatus('Live', 'online')
          if (!this.unconfirmed) this.error.textContent = ''
          this.dimensions.textContent = `${this.term.cols} × ${this.term.rows}${frame.truncated ? ' · partial scrollback' : ''}`
          this.resize(this.host.contains(document.activeElement))
        })
      } else if (frame.type === 'data') {
        this.term.write(frame.chunk)
      } else if (frame.type === 'fit-override-changed') {
        if (frame.cols && frame.rows) {
          this.term.resize(frame.cols, frame.rows)
          this.dimensions.textContent = `${frame.cols} × ${frame.rows}`
        }
      } else if (frame.type === 'input-ack') {
        this.pending.delete(frame.id)
        if (!this.pending.size) { this.unconfirmed = false; this.error.textContent = '' }
      } else if (frame.type === 'error') {
        this.error.textContent = frame.message
        this.ready = false
        this.term.options.disableStdin = true
        this.setStatus('Connection issue', 'error')
      }
    }
    ws.onerror = () => { if (this.ws === ws) { this.ready = false; this.term.options.disableStdin = true; this.setStatus('Connection issue', 'error') } }
    ws.onclose = () => {
      if (this.disposed || this.ws !== ws) return
      this.unavailable('Terminal connection lost. Last screen retained; checking Orca…')
      this.retryTimer = setTimeout(async () => {
        await refresh()
        if (!this.disposed && !this.ws) this.connect()
      }, this.retryDelay)
      this.retryDelay = Math.min(15000, this.retryDelay * 2)
    }
  }

  async attachImage(file) {
    if (!file || !this.ready) return notice('Wait for the terminal to connect before attaching an image')
    try {
      const response = await fetch('/api/attachment', { method: 'POST', headers: { 'x-control-room-token': token }, body: file })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      // Insert a quoted path into the native prompt; Enter remains the user's action.
      this.term.paste(JSON.stringify(result.attachment.path) + ' ')
      this.term.focus()
      notice('Image path inserted into this terminal’s prompt')
    } catch (error) { notice(error.message) }
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.retryTimer); clearTimeout(this.resizeTimer)
    this.resizeObserver.disconnect()
    this.ws?.close()
    this.term.dispose()
    this.el.remove()
  }
}

export function refresh() {
  if (updating) return updating
  updating = refreshState().finally(() => { updating = null })
  return updating
}

async function refreshState() {
  try {
    state = await api('state')
    metadataError = ''
    $('version').textContent = `v${state.version}`
    if (!state.paired) { if (!$('settings').open && !$('lanes').open) $('settings').showModal(); return }
    $('empty').hidden = state.lanes.length !== 0
    const ids = new Set(state.lanes.map(lane => lane.id))
    for (const [id, panel] of panels) {
      if (!ids.has(id)) { panel.dispose(); panels.delete(id) }
    }
    state.lanes.forEach((lane, index) => {
      const previous = panels.get(lane.id)
      if (previous) previous.update(lane, index)
      else panels.set(lane.id, new TerminalPanel(lane, index))
    })
    layout()
  } catch (error) {
    metadataError = error.message
    for (const panel of panels.values()) {
      panel.metadataHealthy = false
      panel.unavailable('Cannot reach Orca. Last screen retained; reconnecting when Orca returns.')
    }
  } finally { connectionStatus() }
}

function openLanes() {
  if (!state?.paired) return $('settings').showModal()
  laneDraft = state.lanes.map(l => ({ id: l.id, handle: l.terminal?.handle || '', name: l.name, role: l.role, worktreePath: l.worktreePath }))
  $('layout-columns').value = String(state.columns)
  $('font-size').value = String(state.fontSize)
  $('lanes-error').textContent = ''
  $('terminal-filter').value = ''
  renderLaneDraft()
  if (!$('lanes').open) $('lanes').showModal()
}

function renderAvailable() {
  const selected = new Set(laneDraft.map(l => l.handle))
  const filter = $('terminal-filter').value.trim().toLowerCase()
  $('available-terminals').replaceChildren()
  for (const terminal of state.available) {
    const title = `${terminal.title} · ${terminal.worktreePath || ''}`
    if (selected.has(terminal.handle) || !title.toLowerCase().includes(filter)) continue
    const option = document.createElement('option')
    option.value = terminal.handle
    option.textContent = `${title} · ${terminal.tabId.slice(0, 6)}/${terminal.leafId?.slice(0, 6) || ''}`
    $('available-terminals').append(option)
  }
  $('add-lane').disabled = !$('available-terminals').options.length || laneDraft.length >= state.maxLanes
}

function renderLaneDraft() {
  $('lane-list').replaceChildren()
  $('lane-count').textContent = `${laneDraft.length} selected · ordered left to right, then next row`
  laneDraft.forEach((lane, index) => {
    const row = document.createElement('div')
    row.className = 'lane-choice'
    const number = document.createElement('span')
    number.className = 'lane-number'
    number.textContent = String(index + 1)
    const fields = document.createElement('div')
    fields.className = 'lane-choice-fields'
    const name = document.createElement('input')
    name.value = lane.name
    name.maxLength = 80
    name.setAttribute('aria-label', `Lane ${index + 1} name`)
    name.oninput = () => { lane.name = name.value }
    const details = document.createElement('small')
    const terminal = state.available.find(t => t.handle === lane.handle)
    details.textContent = terminal ? `${terminal.title} · ${terminal.worktreePath} · ${terminal.tabId.slice(0, 6)}/${terminal.leafId?.slice(0, 6) || ''}` : `${lane.worktreePath} · currently unavailable; retained`
    fields.append(name, details)
    row.append(number, fields)
    for (const [label, title, action, disabled] of [
      ['↑', 'Move lane up', () => { [laneDraft[index - 1], laneDraft[index]] = [laneDraft[index], laneDraft[index - 1]]; renderLaneDraft() }, index === 0],
      ['↓', 'Move lane down', () => { [laneDraft[index + 1], laneDraft[index]] = [laneDraft[index], laneDraft[index + 1]]; renderLaneDraft() }, index === laneDraft.length - 1],
      ['×', 'Remove lane from view', () => { laneDraft.splice(index, 1); renderLaneDraft() }, false]
    ]) {
      const control = document.createElement('button')
      control.textContent = label; control.title = title; control.setAttribute('aria-label', title)
      control.disabled = disabled; control.onclick = action
      row.append(control)
    }
    $('lane-list').append(row)
  })
  renderAvailable()
}

$('terminal-filter').oninput = renderAvailable
$('add-lane').onclick = () => {
  const terminal = state.available.find(t => t.handle === $('available-terminals').value)
  if (!terminal || laneDraft.some(l => l.handle === terminal.handle) || laneDraft.length >= state.maxLanes) return
  laneDraft.push({ handle: terminal.handle, name: terminal.worktreePath?.split(/[\\/]/).at(-1)?.replace(/^agent-/, '') || terminal.title, role: 'agent' })
  renderLaneDraft()
}
$('import-roster').onclick = async () => {
  try {
    const roster = await api('roster')
    let added = 0, unavailable = 0
    for (const lane of roster.lanes) {
      const matches = state.available.filter(t => t.worktreePath === lane.worktreePath && t.tabId === lane.tabId && (!lane.leafId || t.leafId === lane.leafId))
      if (matches.length !== 1) { unavailable++; continue }
      if (laneDraft.some(l => l.handle === matches[0].handle)) continue
      if (laneDraft.length >= state.maxLanes) break
      laneDraft.push({ handle: matches[0].handle, name: lane.name, role: lane.role })
      added++
    }
    renderLaneDraft()
    $('lanes-error').textContent = `${added} lanes added to this draft.${unavailable ? ` ${unavailable} unavailable or ambiguous lanes skipped.` : ''} Click Save layout to apply.`
  } catch (error) { $('lanes-error').textContent = error.message }
}
$('reset-sizes').onclick = () => {
  for (const panel of panels.values()) {
    saveValue(`live-lane-size:${panel.lane.id}`, null)
    panel.el.style.width = ''; panel.el.style.height = ''
    panel.el.classList.remove('maximized')
  }
  layout()
  notice('Tiles reset to the grid size')
}
$('empty-manage').onclick = openLanes
$('refresh').onclick = () => { location.reload() }

$('manage').onclick = async () => { await refresh(); openLanes() }
$('setup').onclick = () => { if (!$('settings').open) $('settings').showModal() }
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close() })
$('pair').onclick = async () => {
  $('pair').disabled = true
  $('pair-error').textContent = ''
  try {
    await api('pair', { code: $('pair-code').value })
    $('pair-code').value = ''
    $('settings').close()
    await refresh()
  } catch (error) { $('pair-error').textContent = error.message } finally { $('pair').disabled = false }
}
$('save-lanes').onclick = async () => {
  $('save-lanes').disabled = true
  try {
    await api('config', { lanes: laneDraft, columns: Number($('layout-columns').value), fontSize: Number($('font-size').value) })
    $('lanes').close()
    await refresh()
  } catch (error) { $('lanes-error').textContent = error.message } finally { $('save-lanes').disabled = false }
}
window.addEventListener('beforeunload', () => { for (const panel of panels.values()) panel.dispose() })
window.addEventListener('resize', layout)
window.addEventListener('online', () => void refresh())
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
void refresh()
setInterval(refresh, 20000)
