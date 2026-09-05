import { createHash } from 'node:crypto'

export const MAX_LANES = 128
const roles = new Set(['strategist', 'manager', 'advisor', 'agent'])
const bounded = (value, fallback, min, max) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback

export function laneId(terminal) {
  return createHash('sha256').update(JSON.stringify([terminal.worktreePath, terminal.tabId, terminal.leafId || ''])).digest('hex').slice(0, 24)
}

export function bindLane(lane, terminals) {
  if (!lane) return null
  const matches = terminals.filter(t => t.worktreePath === lane.worktreePath && t.tabId === lane.tabId &&
    (!lane.leafId || t.leafId === lane.leafId))
  return matches.find(t => t.handle === lane.handle) || (matches.length === 1 ? matches[0] : null)
}

export function normalizeConfig(value) {
  const seen = new Set()
  const lanes = (Array.isArray(value?.lanes) ? value.lanes : []).slice(0, MAX_LANES).flatMap(lane => {
    if (!lane || typeof lane.worktreePath !== 'string' || !lane.worktreePath || typeof lane.tabId !== 'string' || !lane.tabId) return []
    const id = typeof lane.id === 'string' && lane.id ? lane.id.slice(0, 100) : laneId(lane)
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, worktreePath: lane.worktreePath, tabId: lane.tabId,
      leafId: typeof lane.leafId === 'string' ? lane.leafId : '',
      handle: typeof lane.handle === 'string' ? lane.handle : '',
      name: String(lane.name || lane.title || lane.worktreePath.split(/[\\/]/).at(-1) || 'Agent').trim().slice(0, 80) || 'Agent',
      role: roles.has(lane.role) ? lane.role : 'agent' }]
  })
  return { version: 2, columns: bounded(value?.columns, 0, 0, 12), fontSize: bounded(value?.fontSize, 12, 9, 20), lanes }
}

export function selectConfig(data, previous, available) {
  // Accept the original prototype request so a still-open old window can save safely.
  const selected = Array.isArray(data.lanes) ? data.lanes : data.handles?.map(handle => ({ handle }))
  if (!Array.isArray(selected) || selected.length > MAX_LANES) throw new Error(`Choose up to ${MAX_LANES} lanes`)
  const handles = new Set(), ids = new Set()
  const lanes = selected.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid lane selection')
    const terminal = available.find(t => t.handle === item.handle)
    const old = previous.lanes.find(l => l.id === item.id) || previous.lanes.find(l => bindLane(l, available)?.handle === item.handle)
    if (!terminal && (!old || item.handle)) throw new Error('Terminal no longer exists; refresh the list')
    const identity = terminal || old
    const id = old?.id || laneId(identity)
    const handle = terminal?.handle
    if (ids.has(id) || (handle && handles.has(handle))) throw new Error('Each terminal can appear only once')
    ids.add(id); if (handle) handles.add(handle)
    return { ...identity, id, name: item.name?.trim() || old?.name ||
      terminal?.worktreePath?.split(/[\\/]/).at(-1)?.replace(/^agent-/, '') || terminal?.title,
    role: item.role || old?.role || 'agent' }
  })
  return normalizeConfig({ ...previous, ...data, lanes })
}
