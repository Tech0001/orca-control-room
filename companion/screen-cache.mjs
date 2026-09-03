import { filterTerminalUiNoise, isTransientTerminalStatus } from './public/terminal-format.js'

function terminalLinesEqual(left, right) {
  if (left.length !== right.length) return false
  return left.every((line, index) => line === right[index])
}

const MAX_LANE_HISTORY_LINES = 600

function sequenceIndex(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return -1
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        matches = false
        break
      }
    }
    if (matches) return start
  }
  return -1
}

function suffixPrefixOverlap(previous, next) {
  const maximum = Math.min(previous.length, next.length)
  for (let length = maximum; length > 0; length -= 1) {
    let matches = true
    for (let index = 0; index < length; index += 1) {
      if (previous[previous.length - length + index] !== next[index]) {
        matches = false
        break
      }
    }
    if (matches) return length
  }
  return 0
}

function commonPrefixLength(previous, next) {
  const maximum = Math.min(previous.length, next.length)
  let length = 0
  while (length < maximum && previous[length] === next[length]) length += 1
  return length
}

export function mergeTerminalHistory(
  previousHistory,
  previousFrame,
  nextFrame,
  limit = MAX_LANE_HISTORY_LINES
) {
  const sourceHistory = Array.isArray(previousHistory) ? previousHistory.map(String) : []
  const sourcePrior = Array.isArray(previousFrame) ? previousFrame.map(String) : []
  const sourceNext = Array.isArray(nextFrame) ? nextFrame.map(String) : []
  const rawHistory = filterTerminalUiNoise(sourceHistory)
  const rawPrior = filterTerminalUiNoise(sourcePrior)
  const rawNext = filterTerminalUiNoise(sourceNext)
  const history = rawHistory.filter((line) => !isTransientTerminalStatus(line))
  const prior = rawPrior.filter((line) => !isTransientTerminalStatus(line))
  const next = rawNext.filter((line) => !isTransientTerminalStatus(line))
  const activeStatus = rawNext.filter(isTransientTerminalStatus).slice(-1)
  if (sourceNext.length === 0 || terminalLinesEqual(rawPrior, rawNext)) {
    return [...history, ...activeStatus].slice(-limit)
  }
  if (history.length === 0) return [...next, ...activeStatus].slice(-limit)

  let appended
  if (sequenceIndex(prior, next) >= 0) {
    // A terminal can temporarily report only a few rows while accepting a prompt.
    // Keep the longer history instead of collapsing the card and its scrollbar.
    appended = []
  } else {
    const priorInsideNext = sequenceIndex(next, prior)
    if (priorInsideNext >= 0) {
      appended = next.slice(priorInsideNext + prior.length)
    } else {
      const overlap = suffixPrefixOverlap(prior, next)
      appended =
        overlap > 0 ? next.slice(overlap) : next.slice(commonPrefixLength(prior, next))
    }
  }
  return [...history, ...appended, ...activeStatus].slice(-limit)
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
      const frameLines = Array.isArray(screen.tail) ? screen.tail.map(String) : []
      const previousFrame = previous?.frameLines ?? previous?.lines ?? []
      const changed =
        !previous ||
        !terminalLinesEqual(
          filterTerminalUiNoise(previousFrame),
          filterTerminalUiNoise(frameLines)
        )
      const lines = mergeTerminalHistory(previous?.lines, previousFrame, frameLines)
      screenCache.set(terminal.stableId, {
        lastOutputAt: terminal.lastOutputAt,
        lines,
        frameLines,
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
        frameLines: previous?.frameLines ?? previous?.lines ?? [],
        source: previous?.source ?? 'unknown',
        draft: previous?.draft ?? '',
        readAt: previous?.readAt ?? null,
        changedAt: previous?.changedAt ?? null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
