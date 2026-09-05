import { filterTerminalUiNoise, isTransientTerminalStatus } from './public/terminal-format.js'

function terminalLinesEqual(left, right) {
  if (left.length !== right.length) return false
  return left.every((line, index) => line === right[index])
}

const MAX_LANE_HISTORY_LINES = 600

function comparableLine(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function compactLine(value) {
  return String(value ?? '').replace(/\s+/g, '')
}

function transcriptParagraphs(lines) {
  const paragraphs = []
  let current = []
  for (const line of lines) {
    if (line.trim()) {
      current.push(line)
    } else if (current.length > 0) {
      paragraphs.push({ compact: compactLine(current.join('')) })
      current = []
    }
  }
  if (current.length > 0) paragraphs.push({ compact: compactLine(current.join('')) })
  return paragraphs
}

function reflowedParagraphBreaks(screen, transcript) {
  const paragraphs = transcriptParagraphs(transcript)
  if (paragraphs.length < 2) return new Set()

  // Work backwards so a visible terminal viewport aligns with the newest matching
  // transcript text. Removing whitespace lets a rendered row match even when the
  // transcript wrapped the same sentence (or URL) at different columns.
  const matchedParagraph = new Map()
  let paragraphCeiling = paragraphs.length - 1
  let offsetCeiling = Number.POSITIVE_INFINITY
  for (let screenIndex = screen.length - 1; screenIndex >= 0; screenIndex -= 1) {
    const key = compactLine(screen[screenIndex])
    if (!key) continue

    for (let paragraphIndex = paragraphCeiling; paragraphIndex >= 0; paragraphIndex -= 1) {
      const paragraph = paragraphs[paragraphIndex].compact
      const maximumOffset =
        paragraphIndex === paragraphCeiling && Number.isFinite(offsetCeiling)
          ? Math.min(offsetCeiling, paragraph.length - key.length)
          : paragraph.length - key.length
      if (maximumOffset < 0) continue
      const offset = paragraph.lastIndexOf(key, maximumOffset)
      if (offset < 0) continue

      matchedParagraph.set(screenIndex, paragraphIndex)
      paragraphCeiling = paragraphIndex
      offsetCeiling = offset - 1
      break
    }
  }

  const breaks = new Set()
  let previousMatch
  for (let screenIndex = 0; screenIndex < screen.length; screenIndex += 1) {
    const paragraph = matchedParagraph.get(screenIndex)
    if (paragraph === undefined) continue
    if (
      previousMatch &&
      paragraph > previousMatch.paragraph &&
      screen
        .slice(previousMatch.screenIndex + 1, screenIndex)
        .every((line) => line.trim())
    ) {
      breaks.add(screenIndex)
    }
    previousMatch = { paragraph, screenIndex }
  }
  return breaks
}

function listItemMarker(value) {
  return String(value ?? '').trim().match(/^([-*+])\s/)?.[1] ?? null
}

function breakWouldSplitList(screen, index) {
  const marker = listItemMarker(screen[index])
  if (!marker) return false
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const line = screen[previousIndex]
    if (!line.trim()) return false
    const previousMarker = listItemMarker(line)
    if (previousMarker) return previousMarker === marker
    if (/^[›❯●•](?:\s+|$)/.test(line.trim())) return false
  }
  return false
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

  const breaks = reflowedParagraphBreaks(screen, transcript)
  for (let index = 0; index < screen.length; index += 1) {
    const previousMatch = matchedTranscriptIndex.get(index - 1)
    const currentMatch = matchedTranscriptIndex.get(index)
    if (
      previousMatch !== undefined &&
      currentMatch !== undefined &&
      currentMatch > previousMatch + 1
    ) {
      const between = transcript.slice(previousMatch + 1, currentMatch)
      if (between.length > 0 && between.every((line) => !line.trim())) breaks.add(index)
    }
  }

  const restored = []
  for (let index = 0; index < screen.length; index += 1) {
    if (
      breaks.has(index) &&
      restored.at(-1)?.trim() &&
      !breakWouldSplitList(screen, index)
    ) {
      restored.push('')
    }
    restored.push(screen[index])
  }
  return restored
}

function mergeLineKey(value) {
  const key = comparableLine(value)
  if (!key || /^[╭╮╰╯┌┐└┘├┤┬┴┼│┃─━┄┅┈┉]+$/.test(key)) return ''
  return key
}

function matchingLinePairs(previous, next) {
  const previousKeys = previous.map(mergeLineKey)
  const nextKeys = next.map(mergeLineKey)
  const lengths = Array.from(
    { length: previous.length + 1 },
    () => new Uint16Array(next.length + 1)
  )
  for (let previousIndex = 1; previousIndex <= previous.length; previousIndex += 1) {
    for (let nextIndex = 1; nextIndex <= next.length; nextIndex += 1) {
      lengths[previousIndex][nextIndex] =
        previousKeys[previousIndex - 1] &&
        previousKeys[previousIndex - 1] === nextKeys[nextIndex - 1]
          ? lengths[previousIndex - 1][nextIndex - 1] + 1
          : Math.max(lengths[previousIndex - 1][nextIndex], lengths[previousIndex][nextIndex - 1])
    }
  }

  const pairs = []
  let previousIndex = previous.length
  let nextIndex = next.length
  while (previousIndex > 0 && nextIndex > 0) {
    if (
      previousKeys[previousIndex - 1] &&
      previousKeys[previousIndex - 1] === nextKeys[nextIndex - 1]
    ) {
      pairs.push({ previousIndex: previousIndex - 1, nextIndex: nextIndex - 1 })
      previousIndex -= 1
      nextIndex -= 1
    } else if (lengths[previousIndex - 1][nextIndex] >= lengths[previousIndex][nextIndex - 1]) {
      previousIndex -= 1
    } else {
      nextIndex -= 1
    }
  }
  return pairs.reverse()
}

function historyBeforeFrame(history, frame) {
  if (frame.length === 0) return history
  if (frame.length > history.length) return []
  const candidate = history.slice(-frame.length)
  return terminalLinesEqual(candidate, frame) ? history.slice(0, -frame.length) : []
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

  // Keep one replaceable current-frame suffix behind the archived rows. A TUI
  // redraw can insert output above a stable footer, reflow wrapped lines, or
  // shift the viewport. Appending the entire changed frame makes those redraws
  // appear as repeated conversations. Replacing the prior frame preserves its
  // scrolled-off prefix only when the new frame begins at a proven shared row.
  const archive = historyBeforeFrame(history, prior)
  const pairs = matchingLinePairs(prior, next)
  if (pairs.length === 0) {
    return [...archive, ...prior, ...next, ...activeStatus].slice(-limit)
  }

  const first = pairs[0]
  const nextStartsAtMatch = next.slice(0, first.nextIndex).every((line) => !mergeLineKey(line))
  const retiredPrefix = nextStartsAtMatch ? prior.slice(0, first.previousIndex) : []
  return [...archive, ...retiredPrefix, ...next, ...activeStatus].slice(-limit)
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
      let paragraphEnrichmentAttempts = rawFrameChanged
        ? 0
        : previous?.paragraphEnrichmentAttempts ?? 0
      let paragraphEnrichmentPending = rawFrameChanged
      let enrichmentTranscriptLines = null
      let restoredParagraphBreak = false
      if (
        typeof readTranscript === 'function' &&
        (rawFrameChanged || previous?.paragraphEnrichmentPending)
      ) {
        paragraphEnrichmentAttempts += 1
        try {
          const transcript = await readTranscript(terminal.handle)
          enrichmentTranscriptLines = Array.isArray(transcript?.tail)
            ? transcript.tail.map(String)
            : []
          const enrichedFrameLines = restoreTranscriptParagraphs(
            rawFrameLines,
            enrichmentTranscriptLines
          )
          restoredParagraphBreak = enrichedFrameLines.length > rawFrameLines.length
          frameLines = restoredParagraphBreak ? enrichedFrameLines : frameLines
          paragraphEnrichmentPending =
            !restoredParagraphBreak && paragraphEnrichmentAttempts < 2
        } catch {
          // The rendered screen remains usable when transcript enrichment is unavailable.
          paragraphEnrichmentPending = paragraphEnrichmentAttempts < 2
        }
      }
      const previousFrame = previous?.frameLines ?? previousRawFrame
      const changed =
        !previous ||
        !terminalLinesEqual(
          filterTerminalUiNoise(previousRawFrame),
          filterTerminalUiNoise(rawFrameLines)
        )
      const lines =
        !rawFrameChanged && restoredParagraphBreak
          ? restoreTranscriptParagraphs(previous?.lines, enrichmentTranscriptLines)
          : mergeTerminalHistory(previous?.lines, previousFrame, frameLines)
      screenCache.set(terminal.stableId, {
        lastOutputAt: terminal.lastOutputAt,
        lines,
        frameLines,
        rawFrameLines,
        paragraphEnrichmentAttempts,
        paragraphEnrichmentPending,
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
        paragraphEnrichmentAttempts: previous?.paragraphEnrichmentAttempts ?? 0,
        paragraphEnrichmentPending: previous?.paragraphEnrichmentPending ?? false,
        source: previous?.source ?? 'unknown',
        draft: previous?.draft ?? '',
        readAt: previous?.readAt ?? null,
        changedAt: previous?.changedAt ?? null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
