/**
 * Harness adapter: Qwen Code (Alibaba) — open-source terminal coding agent.
 *
 * Qwen Code stores session transcripts and history in:
 *   `~/.qwen/sessions/*.json`, `~/.qwen/*.json`, or `.jsonl` files.
 *
 * Read-only, without exception. Never writes to Qwen Code files.
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
  if (process.env.BOT_CROSSING_QWEN_DIR) {
    return [process.env.BOT_CROSSING_QWEN_DIR]
  }
  const base = path.join(HOME, '.qwen')
  return [path.join(base, 'sessions'), base]
}

async function findQwenDir() {
  for (const dir of candidateDirs()) {
    if (await exists(dir)) return dir
  }
  return ''
}

const ID = (raw) => `qwen-code:${raw}`

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

function parseSession(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const lines = jsonLines(raw)
    if (lines.length) return { messages: lines }
  }
  return null
}

async function scanThreads() {
  const dir = await findQwenDir()
  if (!dir) return []

  const sessionDirs = [path.join(dir, 'sessions'), dir]
  const files = []
  for (const sDir of sessionDirs) {
    if (await exists(sDir)) {
      const found = await listFiles(sDir, (n) => n.endsWith('.json') || n.endsWith('.jsonl'))
      files.push(...found)
    }
  }
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
    let model = 'Qwen'

    const parsed = parseSession(headText)
    if (parsed) {
      cwd = parsed.cwd || parsed.workspace || parsed.projectPath || parsed.directory || ''
      if (parsed.model) model = parsed.model
      const msgs = parsed.messages || parsed.history || (Array.isArray(parsed) ? parsed : [])
      for (const m of msgs) {
        const role = m.role || m.type
        if (role === 'user') {
          prompt = extractText(m)
          break
        }
      }
    }

    let tailRecords = jsonLines(tailText)
    if (!tailRecords.length && parsed) {
      tailRecords = parsed.messages || parsed.history || (Array.isArray(parsed) ? parsed : [])
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

    const project = cwd ? path.basename(cwd) : 'Qwen Code'
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
    error: 'Qwen Code sessions can be resumed in terminal with `qwen-code --resume`.',
  }
}

function newSession() {
  return {
    ok: false,
    error: 'Start a new session with `qwen-code` in your terminal.',
  }
}

const detect = async () => (await findQwenDir()) !== ''

export default {
  id: 'qwen-code',
  name: 'Qwen Code',
  detect,
  scanThreads,
  openThread,
  newSession,
}
