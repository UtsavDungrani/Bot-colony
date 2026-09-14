/**
 * Harness adapter: OpenCode (opencode.ai) — open source AI coding agent.
 *
 * OpenCode stores session state and transcripts in:
 *   - Windows: `%LOCALAPPDATA%/opencode` or `%APPDATA%/opencode` or `~/.opencode`
 *   - macOS/Linux: `~/.local/share/opencode` or `~/.config/opencode` or `~/.opencode`
 * Inside `sessions/*.json` or session JSONL files.
 *
 * Read-only, without exception. Never writes to OpenCode files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 32 * 1024

function candidateDirs() {
  if (process.env.BOT_CROSSING_OPENCODE_DIR) {
    return [process.env.BOT_CROSSING_OPENCODE_DIR]
  }
  const dirs = []
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'opencode'))
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'opencode'))
  } else {
    dirs.push(path.join(HOME, '.local', 'share', 'opencode'))
    dirs.push(path.join(HOME, '.config', 'opencode'))
  }
  dirs.push(path.join(HOME, '.opencode'))
  return dirs
}

async function findOpenCodeDir() {
  for (const dir of candidateDirs()) {
    if (await exists(dir)) return dir
  }
  return ''
}

const ID = (raw) => `opencode:${raw}`

function extractText(msg) {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  if (typeof msg.content === 'string') return msg.content
  if (typeof msg.text === 'string') return msg.text
  if (Array.isArray(msg.content)) {
    return msg.content.map(extractText).join('\n')
  }
  return ''
}

function parseSessionData(raw) {
  if (!raw) return null
  let obj = null
  try {
    obj = JSON.parse(raw)
  } catch {
    // If not single JSON object, try jsonLines
    const lines = jsonLines(raw)
    if (lines.length) {
      obj = { messages: lines }
    }
  }
  return obj
}

async function scanThreads() {
  const root = await findOpenCodeDir()
  if (!root) return []

  const sessionDirs = [path.join(root, 'sessions'), root]
  const files = []
  for (const sDir of sessionDirs) {
    if (await exists(sDir)) {
      const found = await listFiles(sDir, (n) => n.endsWith('.json') || n.endsWith('.jsonl'))
      files.push(...found)
    }
  }

  // Deduplicate files
  const uniqueFiles = [...new Set(files)]
  const threads = []
  const now = Date.now()

  for (const file of uniqueFiles) {
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      continue
    }

    const sessionId = path.basename(file, path.extname(file))
    const headText = await readHead(file, HEAD_BYTES).catch(() => '')
    const tailText = await readTail(file, TAIL_BYTES).catch(() => '')

    let prompt = ''
    let cwd = ''
    let running = false
    let unread = false
    let hasError = false
    let model = 'OpenCode'

    // Try parsing head as JSON object or JSON lines
    const parsedHead = parseSessionData(headText)
    if (parsedHead) {
      cwd = parsedHead.cwd || parsedHead.projectPath || parsedHead.working_directory || parsedHead.directory || ''
      if (parsedHead.model) model = parsedHead.model

      const msgs = parsedHead.messages || parsedHead.history || (Array.isArray(parsedHead) ? parsedHead : [])
      for (const m of msgs) {
        const role = m.role || m.type
        if (role === 'user') {
          prompt = extractText(m)
          break
        }
      }
    }

    // Try parsing tail for status: from jsonLines if JSONL, or from msgs if single JSON
    let tailRecords = jsonLines(tailText)
    if (!tailRecords.length && parsedHead) {
      tailRecords = parsedHead.messages || parsedHead.history || (Array.isArray(parsedHead) ? parsedHead : [])
    }
    if (tailRecords.length) {
      const last = tailRecords[tailRecords.length - 1]
      const lastRole = last.role || last.type
      const isFresh = now - stat.mtimeMs < ACTIVE_WINDOW_MS

      hasError = tailRecords.some(
        (r) => r.status === 'error' || r.type === 'error' || r.error != null
      )

      if (lastRole === 'user' || last.status === 'running' || last.status === 'in_progress') {
        running = isFresh
        unread = false
      } else if (lastRole === 'assistant' || last.status === 'completed' || last.status === 'done' || !last.status) {
        running = false
        unread = true
      }
    }

    const project = cwd ? path.basename(cwd) : 'OpenCode'
    const cleanTitle = (prompt || 'Untitled session').replace(/\s+/g, ' ').trim()

    threads.push({
      id: ID(sessionId),
      title: cleanTitle.slice(0, 120),
      preview: cleanTitle.slice(0, 240),
      project: project || 'unknown',
      projectPath: cwd || '',
      worktree: '',
      cwd: cwd || '',
      gitBranch: '',
      model,
      effort: '',
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      lastActivityAt: stat.mtimeMs,
      lastFocusedAt: 0,
      unread,
      running,
      hasError,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: stat.size,
      source: 'cli',
      canOpen: false,
      ref: { sessionId, cwd },
    })
  }

  return threads
}

function openThread(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, error: 'Invalid thread reference' }
  }
  return {
    ok: false,
    error: 'OpenCode has no direct link to a single session — resume in your terminal with `opencode`.',
  }
}

function newSession() {
  return {
    ok: false,
    error: 'Start a new session with `opencode` in your terminal.',
  }
}

const detect = async () => (await findOpenCodeDir()) !== ''

export default {
  id: 'opencode',
  name: 'OpenCode',
  detect,
  scanThreads,
  openThread,
  newSession,
}
