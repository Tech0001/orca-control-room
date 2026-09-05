import { inputChunks, isQueryReply } from './live-protocol.mjs'

const $ = id => document.getElementById(id)
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('live-token') || ''
if (token) sessionStorage.setItem('live-token', token)
history.replaceState(null, '', location.pathname)
const panels = new Map()
let state = null
let updating = false
let noticeTimer

function notice(message) {
  $('notice').textContent = message
  $('notice').hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { $('notice').hidden = true }, 7000)
}

async function api(path, value) {
  const response = await fetch(`/api/${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { 'x-control-room-token': token, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    signal: AbortSignal.timeout(15000)
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
    this.el = document.createElement('section')
    this.el.className = 'live-lane'
    this.el.dataset.lane = String(index)
    const header = document.createElement('header')
    this.title = document.createElement('h2')
    this.title.textContent = lane.name
    this.status = document.createElement('span')
    this.status.className = 'status'
    header.append(this.title, this.status)
    const image = button('image', 'Attach image')
    image.onclick = () => this.file.click()
    const reconnect = button('reconnect', 'Reconnect terminal view')
    reconnect.onclick = () => this.connect()
    const maximize = button('maximize', 'Maximize or restore terminal')
    maximize.onclick = () => { this.el.classList.toggle('maximized'); this.term.focus(); this.resize(true) }
    header.append(image, reconnect, maximize)
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
    this.el.append(header, this.host, footer, this.file)
    $('live-grid').append(this.el)
    const saved = JSON.parse(localStorage.getItem(`live-size-${index}`) || 'null')
    if (saved?.width >= 340 && saved?.height >= 280) {
      this.el.style.width = `${saved.width}px`
      this.el.style.height = `${saved.height}px`
    }
    this.term = new window.Terminal({
      fontFamily: '"Maple Mono", "Maple Mono NF", "JetBrainsMono Nerd Font", monospace',
      fontSize: 12, lineHeight: 1.12, cursorBlink: true, scrollback: 10000,
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
      if ((mac ? event.metaKey : event.ctrlKey && event.shiftKey) && event.code === 'KeyC' && this.term.hasSelection()) {
        void navigator.clipboard.writeText(this.term.getSelection()).catch(() => notice('Copy failed; use the browser copy menu'))
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
        if (!this.el.classList.contains('maximized')) {
          localStorage.setItem(`live-size-${index}`, JSON.stringify({ width: this.el.offsetWidth, height: this.el.offsetHeight }))
        }
      }, 150)
    })
    this.resizeObserver.observe(this.host)
    this.connect()
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

  setStatus(text, kind = '') { this.status.textContent = text; this.status.className = `status ${kind}` }

  connect() {
    clearTimeout(this.retryTimer)
    if (this.ws) { this.ws.onclose = null; this.ws.close() }
    if (this.pending.size) this.error.textContent = 'Some input was unconfirmed; check the terminal before resending'
    this.pending.clear()
    this.ready = false
    this.term.options.disableStdin = true
    if (!this.lane.terminal) { this.setStatus('Unavailable'); return }
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
          this.restoring = false
          this.ready = true
          this.term.options.disableStdin = false
          this.retryDelay = 1000
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
        this.setStatus('Connection issue', 'error')
      }
    }
    ws.onerror = () => { this.setStatus('Connection issue', 'error') }
    ws.onclose = () => {
      if (this.disposed || this.ws !== ws) return
      this.ready = false
      this.term.options.disableStdin = true
      this.setStatus('Reconnecting…')
      if (this.pending.size) {
        this.unconfirmed = true
        this.error.textContent = 'Input was unconfirmed; it will not be replayed'
      }
      this.retryTimer = setTimeout(() => { void refresh(); this.connect() }, this.retryDelay)
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

async function refresh() {
  if (updating) return
  updating = true
  try {
    state = await api('state')
    $('version').textContent = `v${state.version}`
    $('connection').textContent = state.paired ? 'Two live terminal views' : 'Pairing needed'
    $('connection').className = `connection ${state.paired ? 'online' : ''}`
    if (!state.paired) { if (!$('settings').open && !$('lanes').open) $('settings').showModal(); return }
    if (state.lanes.length !== 2 && !$('lanes').open) { openLanes(); return }
    state.lanes.forEach((lane, index) => {
      const previous = panels.get(index)
      if (previous?.lane.terminal?.handle === lane.terminal?.handle && previous?.lane.tabId === lane.tabId) return
      previous?.dispose()
      panels.set(index, new TerminalPanel(lane, index))
    })
  } catch (error) {
    $('connection').textContent = error.message
    $('connection').className = 'connection error'
  } finally { updating = false }
}

function openLanes() {
  if (!state?.paired) return $('settings').showModal()
  for (const [index, id] of ['left-lane', 'right-lane'].entries()) {
    const select = $(id)
    select.replaceChildren()
    for (const terminal of state.available) {
      const option = document.createElement('option')
      option.value = terminal.handle
      option.textContent = `${terminal.title} · ${terminal.worktreePath || ''}`
      select.append(option)
    }
    select.value = state.lanes[index]?.terminal?.handle || state.available[index]?.handle || ''
  }
  if (!$('lanes').open) $('lanes').showModal()
}

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
    await api('config', { handles: [$('left-lane').value, $('right-lane').value] })
    $('lanes').close()
    await refresh()
  } catch (error) { $('lanes-error').textContent = error.message } finally { $('save-lanes').disabled = false }
}
window.addEventListener('beforeunload', () => { for (const panel of panels.values()) panel.dispose() })
void refresh()
setInterval(refresh, 20000)
