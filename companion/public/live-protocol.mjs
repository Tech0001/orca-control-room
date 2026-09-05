// VT replies share xterm's onData event with keystrokes, but must not claim focus or resize.
export function isQueryReply(data) {
  return /^(?:\x1b\[\??[0-9;]*[Rn]|\x1b\[[?>=]?[0-9;]*c|\x1b\[[468];[0-9]+;[0-9]+t|\x1b\[\??[0-9;]*\$y|\x1b\[\?[0-9]+u|\x1b\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP(?:[01]\$r[^\x1b]*|>\|[^\x1b]*)\x1b\\)+$/.test(data)
}

export function inputChunks(data, size = 16000) {
  const parts = []
  while (data.length) {
    let end = Math.min(data.length, size)
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--
    parts.push(data.slice(0, end))
    data = data.slice(end)
  }
  return parts
}
