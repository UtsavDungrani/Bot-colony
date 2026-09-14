/**
 * Harness adapter: Goose (Block) — extensible AI developer agent.
 *
 * Goose stores session transcripts as timestamped `.jsonl` or `.json` files in:
 *   - Windows: `%LOCALAPPDATA%/block/goose/sessions` or `%APPDATA%/Block/goose/sessions`
 *   - macOS/Linux: `~/.local/share/goose/sessions` or `~/.config/goose/sessions`
 *
 * Read-only, without exception. Never writes to Goose files.
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
  if (process.env.BOT_CROSSING_GOOSE_SESSIONS) {
    return [process.env.BOT_CROSSING_GOOSE_SESSIONS]
  }
  const dirs = []
  if (process.env.GOOSE_PATH_ROOT) {
    dirs.push(path.join(process.env.GOOSE_PATH_ROOT, 'sessions'))
  }
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'block', 'goose', 'sessions'))
    }
    if (process.env.APPDATA) {
      dirs.push(path.join(process.env.APPDATA, 'Block', 'goose', 'sessions'))
    }
  } else {
    dirs.push(path.join(HOME, '.local', 'share', 'goose', 'sessions'))
    dirs.push(path.join(HOME, '.config', 'goose', 'sessions'))
  }
  return dirs
}

async function findSessionDir() {
  for (const dir of candidateDirs()) {
    if (await exists(dir)) return dir
  }
  return ''
}

const ID = (raw) => `goose:${raw}`

function extractText(msg) {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  if (typeof msg.text === 'string') return msg.text
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content.map(extractText).join('\n')
  }
  if (msg.message) return extractText(msg.message)
  return ''
}

function parsePrompt(records) {
  for (const r of records) {
    const role = r.role || r.type || (r.message && r.message.role)
    if (role === 'user') {
      const text = extractText(r)
      if (text.trim()) return text.trim()
    }
  }
  return ''
}

function parseProjectInfo(records) {
  let cwd = ''
  for (const r of records) {
    if (r.working_dir) cwd = r.working_dir
    else if (r.cwd) cwd = r.cwd
    else if (r.metadata && (r.metadata.working_dir || r.metadata.cwd)) {
      cwd = r.metadata.working_dir || r.metadata.cwd
    }
    if (cwd) break
  }
  return cwd
}

async function scanThreads() {
  const dir = await findSessionDir()
  if (!dir) return []

  const files = await listFiles(dir, (n) => n.endsWith('.jsonl') || n.endsWith('.json'))
  const threads = []
  const now = Date.now()

  for (const file of files) {
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      continue
    }

    const sessionId = path.basename(file, path.extname(file))
    const headText = await readHead(file, HEAD_BYTES).catch(() => '')
    const tailText = await readTail(file, TAIL_BYTES).catch(() => '')

    const headRecords = jsonLines(headText)
    const tailRecords = jsonLines(tailText)

    const prompt = parsePrompt(headRecords)
    const cwd = parseProjectInfo(headRecords) || parseProjectInfo(tailRecords)
    const project = cwd ? path.basename(cwd) : 'Goose'

    let running = false
    let unread = false
    let hasError = false

    if (tailRecords.length) {
      const last = tailRecords[tailRecords.length - 1]
      const lastRole = last.role || last.type || (last.message && last.message.role)
      const isFresh = now - stat.mtimeMs < ACTIVE_WINDOW_MS

      hasError = tailRecords.some(
        (r) => r.status === 'error' || r.type === 'error' || r.error != null
      )

      if (lastRole === 'user' || last.status === 'running' || last.status === 'in_progress') {
        running = isFresh
        unread = false
      } else if (lastRole === 'assistant' || last.status === 'completed' || last.status === 'done') {
        running = false
        unread = true
      }
    }

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
      model: 'Goose',
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
    error: 'Goose has no direct link to a single session — resume with `goose session resume` in your terminal.',
  }
}

function newSession() {
  return {
    ok: false,
    error: 'Start a new session with `goose run` in your terminal.',
  }
}

const detect = async () => (await findSessionDir()) !== ''

export default {
  id: 'goose',
  name: 'Goose',
  detect,
  scanThreads,
  openThread,
  newSession,
}
