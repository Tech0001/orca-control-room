import { randomUUID } from 'node:crypto'

export const DEFAULT_COLUMNS = 6
export const MAX_LANES = 32

export function terminalStableId(terminal) {
  return `${terminal.worktreePath}\u0000${terminal.tabId}`
}

export function inferredLaneName(terminal) {
  const pathParts = String(terminal.worktreePath ?? '').split(/[\\/]/).filter(Boolean)
  const pathName = pathParts.at(-1) ?? 'Agent'
  return pathName.replace(/^agent-/i, '') || pathName
}

function normalizeRole(value) {
  return value === 'strategist' || value === 'manager' || value === 'advisor'
    ? value
    : 'manager'
}

function normalizeLane(value, index) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.worktreePath !== 'string' || value.worktreePath.length === 0) return null
  const tabId = typeof value.tabId === 'string' ? value.tabId : ''
  const name =
    typeof value.name === 'string' && value.name.trim()
      ? value.name.trim().slice(0, 80)
      : value.worktreePath.split(/[\\/]/).filter(Boolean).at(-1) || `Lane ${index + 1}`
  return {
    id: typeof value.id === 'string' && value.id ? value.id : randomUUID(),
    worktreePath: value.worktreePath,
    tabId,
    name,
    role: normalizeRole(value.role),
    order: index
  }
}

export function normalizeConfig(value) {
  const candidate = value && typeof value === 'object' ? value : {}
  const rawColumns = Number(candidate.columns)
  const columns = Number.isInteger(rawColumns)
    ? Math.min(8, Math.max(1, rawColumns))
    : DEFAULT_COLUMNS
  const lanes = Array.isArray(candidate.lanes)
    ? candidate.lanes
        .slice(0, MAX_LANES)
        .map(normalizeLane)
        .filter(Boolean)
        .map((lane, order) => ({ ...lane, order }))
    : []
  return { version: 1, columns, lanes }
}

export function bindLane(lane, terminals) {
  return (
    terminals.find(
      (terminal) =>
        terminal.worktreePath === lane.worktreePath &&
        lane.tabId.length > 0 &&
        terminal.tabId === lane.tabId
    ) ?? terminals.find((terminal) => terminal.worktreePath === lane.worktreePath) ?? null
  )
}

export function enrichTerminal(terminal, worktrees) {
  const worktree = worktrees.find((entry) => entry.path === terminal.worktreePath) ?? null
  const agents = Array.isArray(worktree?.agents) ? worktree.agents : []
  const nestedAgents = agents.filter((agent) => agent.parentPaneKey != null).length
  const childWorktrees = Array.isArray(worktree?.childWorktreeIds)
    ? worktree.childWorktreeIds.length
    : 0
  return {
    stableId: terminalStableId(terminal),
    handle: terminal.handle,
    worktreePath: terminal.worktreePath,
    worktreeId: terminal.worktreeId,
    tabId: terminal.tabId,
    title: terminal.title,
    connected: terminal.connected === true,
    writable: terminal.writable === true,
    lastOutputAt: terminal.lastOutputAt ?? 0,
    branch: terminal.branch ?? worktree?.branch ?? '',
    workspaceName: worktree?.displayName || worktree?.repo || inferredLaneName(terminal),
    status: worktree?.status ?? 'unknown',
    unread: worktree?.unread === true,
    preview: terminal.preview || worktree?.preview || '',
    childCount: nestedAgents + childWorktrees
  }
}
