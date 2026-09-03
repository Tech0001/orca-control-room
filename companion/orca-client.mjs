import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER_BYTES = 32 * 1024 * 1024

export function defaultOrcaCli(platform = process.platform) {
  if (process.env.ORCA_CONTROL_ROOM_CLI) return process.env.ORCA_CONTROL_ROOM_CLI
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

function parseJsonOutput(stdout) {
  const text = String(stdout).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Orca CLI returned no JSON object')
  return JSON.parse(text.slice(start, end + 1))
}

export class OrcaClient {
  constructor(command = defaultOrcaCli()) {
    this.command = command
  }

  async run(args, timeout = 20_000) {
    let stdout
    try {
      ;({ stdout } = await execFileAsync(this.command, [...args, '--json'], {
        timeout,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true
      }))
    } catch (error) {
      const failedStdout =
        error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : ''
      if (!failedStdout.trim()) throw error

      let failedResponse
      try {
        failedResponse = parseJsonOutput(failedStdout)
      } catch {
        throw error
      }
      if (!failedResponse.ok) {
        throw new Error(failedResponse.error?.message || 'Orca CLI request failed')
      }
      return failedResponse.result
    }
    const response = parseJsonOutput(stdout)
    if (!response.ok) throw new Error(response.error?.message || 'Orca CLI request failed')
    return response.result
  }

  async snapshot() {
    const [terminalResult, worktreeResult] = await Promise.all([
      this.run(['terminal', 'list']),
      this.run(['worktree', 'ps'])
    ])
    return {
      terminals: terminalResult.terminals ?? [],
      worktrees: worktreeResult.worktrees ?? []
    }
  }

  async readScreen(handle) {
    const result = await this.run(['terminal', 'read', '--terminal', handle, '--screen'])
    return result.terminal
  }

  async readLive(handle, limit = 240) {
    const result = await this.run([
      'terminal',
      'read',
      '--terminal',
      handle,
      '--limit',
      String(limit)
    ])
    return result.terminal
  }

  async readTranscript(handle, limit = 2_000) {
    const result = await this.run([
      'terminal',
      'read',
      '--terminal',
      handle,
      '--limit',
      String(limit)
    ])
    return result.terminal
  }

  async send(handle, text) {
    const result = await this.run([
      'terminal',
      'send',
      '--terminal',
      handle,
      '--text',
      text,
      '--enter'
    ])
    if (result.send?.accepted !== true) {
      const reason = result.send?.refusedReason
        ? ' (' + result.send.refusedReason + ')'
        : result.send?.agentSessionRefusal
          ? ' (agent session is owned by another client)'
          : ''
      throw new Error('Orca refused the terminal message' + reason)
    }
    return result.send
  }

  async switchTo(handle) {
    return await this.run(['terminal', 'switch', '--terminal', handle])
  }
}
