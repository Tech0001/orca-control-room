import { bindLane } from './live-model.mjs'

export const isWritable = terminal => terminal?.connected === true && terminal?.writable === true

// Reopen an existing saved tab through Orca's own desktop restore path. Never
// infer a launch command, create a new tab, kill a process, or send agent input.
export function createLaneRecovery({ getLane, listTerminals, connectDirectory }) {
  const pending = new Map()
  return function recover(id) {
    if (pending.has(id)) return pending.get(id)
    const operation = (async () => {
      const lane = getLane(id)
      if (!lane) throw new Error('Lane not found; refresh Control Room')
      if (!lane.leafId) throw new Error('This lane has no saved pane identity. Open it in Orca and select it again in Manage lanes.')
      const current = bindLane(lane, await listTerminals({ fresh: true }))
      if (isWritable(current)) return { ok: true, alreadyActive: true }
      const rpc = await connectDirectory()
      const worktree = `path:${lane.worktreePath}`
      let snapshot
      try { snapshot = await rpc.request('session.tabs.list', { worktree }) }
      catch { throw new Error('Cannot inspect the saved tab. Check Orca is running, then open this lane there if recovery is unavailable.') }
      const matches = (snapshot.tabs || []).filter(tab => tab.type === 'terminal' &&
        tab.parentTabId === lane.tabId && tab.leafId === lane.leafId)
      if (matches.length !== 1) throw new Error('The saved tab is missing or ambiguous. Open the correct terminal in Orca and select it in Manage lanes; no replacement was started.')
      // The user may have removed/reassigned this lane while the query was running.
      if (getLane(id) !== lane) throw new Error('Lane settings changed; refresh before reopening')
      try {
        await rpc.request('session.tabs.activate', {
          worktree, tabId: lane.tabId, leafId: lane.leafId, navigation: 'host', intent: 'user'
        })
      } catch {
        throw new Error('Orca did not confirm reopening. Check the saved tab in Orca before retrying; no input was replayed.')
      }
      return { ok: true, alreadyActive: false }
    })().finally(() => pending.delete(id))
    pending.set(id, operation)
    return operation
  }
}
