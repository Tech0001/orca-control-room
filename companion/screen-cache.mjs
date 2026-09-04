import { filterTerminalUiNoise, isTransientTerminalStatus } from './public/terminal-format.js'

function terminalLinesEqual(left, right) {
  if (left.length !== right.length) return false
  return left.every((line, index) => line === right[index])
}

const MAX_LANE_HISTORY_LINES = 600

function comparableLine(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

export function restoreTranscriptParagraphs(screenLines, transcriptLines) {
  const screen = Array.isArray(screenLines) ? screenLines.map(String) : []
  const transcript = Array.isArray(transcriptLines) ? transcriptLines.map(String) : []
  if (screen.length < 2 || !transcript.some((line) => !line.trim())) return screen

  const screenKeys = screen.map(comparableLine)
  const transcriptKeys = transcript.map(comparableLine)
  const lengths = Array.from(
    { length: screen.length + 1 },
    () => new Uint16Array(transcript.length + 1)
  )
  for (let screenIndex = 1; screenIndex <= screen.length; screenIndex += 1) {
    for (let transcriptIndex = 1; transcriptIndex <= transcript.length; transcriptIndex += 1) {
      lengths[screenIndex][transcriptIndex] =
        screenKeys[screenIndex - 1] &&
        screenKeys[screenIndex - 1] === transcriptKeys[transcriptIndex - 1]
          ? lengths[screenIndex - 1][transcriptIndex - 1] + 1
          : Math.max(
              lengths[screenIndex - 1][transcriptIndex],
              lengths[screenIndex][transcriptIndex - 1]
            )
    }
  }

  const matchedTranscriptIndex = new Map()
  let screenIndex = screen.length
  let transcriptIndex = transcript.length
  while (screenIndex > 0 && transcriptIndex > 0) {
    if (
      screenKeys[screenIndex - 1] &&
      screenKeys[screenIndex - 1] === transcriptKeys[transcriptIndex - 1]
    ) {
      matchedTranscriptIndex.set(screenIndex - 1, transcriptIndex - 1)
      screenIndex -= 1
      transcriptIndex -= 1
    } else if (
      lengths[screenIndex - 1][transcriptIndex] >=
      lengths[screenIndex][transcriptIndex - 1]
    ) {
      screenIndex -= 1
    } else {
      transcriptIndex -= 1
    }
  }

  const restored = []
  for (let index = 0; index < screen.length; index += 1) {
    const previousMatch = matchedTranscriptIndex.get(index - 1)
    const currentMatch = matchedTranscriptIndex.get(index)
    if (
      previousMatch !== undefined &&
      currentMatch !== undefined &&
      currentMatch > previousMatch + 1
    ) {
      const between = transcript.slice(previousMatch + 1, currentMatch)
      if (between.length > 0 && between.every((line) => !line.trim())) restored.push('')
    }
    restored.push(screen[index])
  }
  return restored
}

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

export function createStaggeredScreenRefresher(
  refresh,
  {
    gapMs = 120,
    minimumIntervalMs = 4_000,
    now = () => Date.now(),
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onError = () => undefined
  } = {}
) {
  if (typeof refresh !== 'function') throw new TypeError('A screen refresh function is required')

  const entries = new Map()
  const queue = []
  const pending = new Set()
  const idleWaiters = []
  let activeId = null
  let running = false
  let stopped = false

  function resolveIdle() {
    if (running || queue.length > 0) return
    for (const resolve of idleWaiters.splice(0)) resolve()
  }

  function enqueue(id, priority = false) {
    if (pending.has(id) || stopped) return false
    pending.add(id)
    if (priority) queue.unshift(id)
    else queue.push(id)
    return true
  }

  async function pump() {
    if (running || stopped) return
    running = true
    while (!stopped && queue.length > 0) {
      const id = queue.shift()
      const entry = entries.get(id)
      if (!entry) {
        pending.delete(id)
        continue
      }

      activeId = id
      try {
        await refresh(entry.binding)
      } catch (error) {
        onError(error, entry.binding)
      }
      entry.lastCompletedAt = now()
      activeId = null
      pending.delete(id)

      if (entry.rerun && !stopped) {
        entry.rerun = false
        enqueue(id, true)
      }
      if (!stopped && queue.length > 0 && gapMs > 0) await wait(gapMs)
    }
    running = false
    activeId = null
    resolveIdle()
  }

  function schedule(bindings, { force = false } = {}) {
    if (stopped) return
    const liveIds = new Set()
    const timestamp = now()
    for (const binding of bindings) {
      const id = binding?.terminal?.stableId
      if (!id) continue
      liveIds.add(id)
      const entry = entries.get(id) ?? {
        binding,
        lastCompletedAt: null,
        rerun: false
      }
      entry.binding = binding
      entries.set(id, entry)
      if (
        force ||
        entry.lastCompletedAt === null ||
        timestamp - entry.lastCompletedAt >= minimumIntervalMs
      ) {
        enqueue(id)
      }
    }

    for (const id of entries.keys()) {
      if (!liveIds.has(id) && id !== activeId) entries.delete(id)
    }
    void pump()
  }

  function prioritizeHandle(handle) {
    if (stopped) return false
    const match = [...entries.entries()].find(([, entry]) => entry.binding?.terminal?.handle === handle)
    if (!match) return false
    const [id, entry] = match
    if (activeId === id) {
      entry.rerun = true
      return true
    }

    const queuedIndex = queue.indexOf(id)
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1)
      queue.unshift(id)
    } else {
      enqueue(id, true)
    }
    void pump()
    return true
  }

  function whenIdle() {
    if (!running && queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  function stop() {
    stopped = true
    queue.length = 0
    pending.clear()
    if (!running) resolveIdle()
  }

  return { schedule, prioritizeHandle, whenIdle, stop }
}

export async function refreshBoundTerminalScreens(
  bindings,
  screenCache,
  readScreen,
  {
    concurrency = 4,
    now = () => Date.now(),
    canRead = () => true,
    readTranscript = null
  } = {}
) {
  await mapWithConcurrency(bindings, concurrency, async ({ terminal }) => {
    if (!terminal?.connected || !canRead(terminal)) return
    const previous = screenCache.get(terminal.stableId)
    const readAt = now()
    try {
      const screen = await readScreen(terminal.handle)
      const rawFrameLines = Array.isArray(screen.tail) ? screen.tail.map(String) : []
      const previousRawFrame = previous?.rawFrameLines ?? previous?.frameLines ?? previous?.lines ?? []
      const rawFrameChanged = !previous || !terminalLinesEqual(previousRawFrame, rawFrameLines)
      let frameLines = rawFrameChanged ? rawFrameLines : previous?.frameLines ?? rawFrameLines
      if (rawFrameChanged && typeof readTranscript === 'function') {
        try {
          const transcript = await readTranscript(terminal.handle)
          frameLines = restoreTranscriptParagraphs(frameLines, transcript?.tail)
        } catch {
          // The rendered screen remains usable when transcript enrichment is unavailable.
        }
      }
      const previousFrame = previous?.frameLines ?? previousRawFrame
      const changed =
        !previous ||
        !terminalLinesEqual(
          filterTerminalUiNoise(previousRawFrame),
          filterTerminalUiNoise(rawFrameLines)
        )
      const lines = mergeTerminalHistory(previous?.lines, previousFrame, frameLines)
      screenCache.set(terminal.stableId, {
        lastOutputAt: terminal.lastOutputAt,
        lines,
        frameLines,
        rawFrameLines,
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
        rawFrameLines: previous?.rawFrameLines ?? previous?.frameLines ?? previous?.lines ?? [],
        source: previous?.source ?? 'unknown',
        draft: previous?.draft ?? '',
        readAt: previous?.readAt ?? null,
        changedAt: previous?.changedAt ?? null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
