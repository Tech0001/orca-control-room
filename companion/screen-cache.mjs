function terminalLinesEqual(left, right) {
  if (left.length !== right.length) return false
  return left.every((line, index) => line === right[index])
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}

export async function refreshBoundTerminalScreens(
  bindings,
  screenCache,
  readScreen,
  { concurrency = 4, now = () => Date.now(), canRead = () => true } = {}
) {
  await mapWithConcurrency(bindings, concurrency, async ({ terminal }) => {
    if (!terminal?.connected || !canRead(terminal)) return
    const previous = screenCache.get(terminal.stableId)
    const readAt = now()
    try {
      const screen = await readScreen(terminal.handle)
      const lines = Array.isArray(screen.tail) ? screen.tail : []
      const changed = !previous || !terminalLinesEqual(previous.lines, lines)
      screenCache.set(terminal.stableId, {
        lastOutputAt: terminal.lastOutputAt,
        lines,
        source: screen.source ?? 'unknown',
        draft: typeof screen.draft === 'string' ? screen.draft : '',
        readAt,
        changedAt: changed ? readAt : previous.changedAt,
        error: null
      })
    } catch (error) {
      screenCache.set(terminal.stableId, {
        ...previous,
        lastOutputAt: terminal.lastOutputAt,
        lines: previous?.lines ?? [],
        source: previous?.source ?? 'unknown',
        draft: previous?.draft ?? '',
        readAt: previous?.readAt ?? null,
        changedAt: previous?.changedAt ?? null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
