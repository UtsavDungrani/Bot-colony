/**
 * Harness adapter: Aider — AI pair programming in your terminal.
 *
 * Aider stores conversation history as markdown in `.aider.chat.history.md`
 * within each repository/project folder, or globally in `~/.aider.chat.history.md`.
 *
 * Read-only, without exception. Never writes to Aider files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, listDirs, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 32 * 1024
const HISTORY_FILENAME = '.aider.chat.history.md'

const ID = (raw) => `aider:${raw}`

function candidateDirs() {
  const dirs = []
  if (process.env.BOT_CROSSING_AIDER_DIRS) {
    dirs.push(...process.env.BOT_CROSSING_AIDER_DIRS.split(path.delimiter).filter(Boolean))
  }
  dirs.push(HOME)
  dirs.push(path.join(HOME, '.aider'))
  return dirs
}

/** Read known project directories from colony.json or env */
async function getProjectDirs() {
  const dirs = new Set(candidateDirs())
  try {
    const dataDir = process.env.BOT_CROSSING_DATA || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data')
    const colonyFile = path.join(dataDir, 'colony.json')
    if (await exists(colonyFile)) {
      const state = JSON.parse(await fsp.readFile(colonyFile, 'utf8'))
      if (state.plots) {
        for (const proj of Object.keys(state.plots)) {
          // If the project key is or resembles a path
          if (proj.includes('/') || proj.includes('\\')) {
            dirs.add(proj)
          }
        }
      }
    }
  } catch {}
  return [...dirs]
}

function parseUserPrompt(headText) {
  // Aider user prompts typically appear as '#### <prompt>'
  const m = /####\s+([^\n]+)/.exec(headText)
  if (m) return m[1].trim()

  // Fallback: look for lines after '# aider chat started'
  const lines = headText.split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('`')) {
      return t
    }
  }
  return ''
}

function parseTimestamps(headText, stat) {
  const m = /# aider chat started at ([\d-]+ [\d:]+)/i.exec(headText)
  if (m) {
    const t = Date.parse(m[1])
    if (!Number.isNaN(t)) return t
  }
  return stat.birthtimeMs || stat.mtimeMs
}

async function scanThreads() {
  const dirs = await getProjectDirs()
  const threads = []
  const now = Date.now()

  for (const dir of dirs) {
    const historyFile = path.join(dir, HISTORY_FILENAME)
    let stat
    try {
      stat = await fsp.stat(historyFile)
    } catch {
      continue
    }

    const headText = await readHead(historyFile, HEAD_BYTES).catch(() => '')
    const tailText = await readTail(historyFile, TAIL_BYTES).catch(() => '')

    const prompt = parseUserPrompt(headText)
    const createdAt = parseTimestamps(headText, stat)
    const project = path.basename(dir) || 'Aider'

    const isFresh = now - stat.mtimeMs < ACTIVE_WINDOW_MS
    // If tail ends with user prompt, running; if assistant finished, unread
    const lastUserIdx = tailText.lastIndexOf('#### ')
    const running = isFresh && lastUserIdx !== -1 && lastUserIdx > tailText.length - 200
    const unread = !running && isFresh

    // Deterministic ID based on directory path
    const sessionId = Buffer.from(dir).toString('base64url').slice(0, 32)
    const cleanTitle = (prompt || 'Untitled session').replace(/\s+/g, ' ').trim()

    threads.push({
      id: ID(sessionId),
      title: cleanTitle.slice(0, 120),
      preview: cleanTitle.slice(0, 240),
      project: project || 'unknown',
      projectPath: dir,
      worktree: '',
      cwd: dir,
      gitBranch: '',
      model: 'Aider',
      effort: '',
      createdAt,
      lastActivityAt: stat.mtimeMs,
      lastFocusedAt: 0,
      unread,
      running,
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: stat.size,
      source: 'cli',
      canOpen: false,
      ref: { dir, historyFile },
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
    error: 'Aider sessions can be resumed in terminal with `aider` inside the project folder.',
  }
}

function newSession() {
  return {
    ok: false,
    error: 'Start a new session with `aider` in your terminal.',
  }
}

async function detect() {
  const dirs = await getProjectDirs()
  for (const dir of dirs) {
    if (await exists(path.join(dir, HISTORY_FILENAME))) return true
  }
  return false
}

export default {
  id: 'aider',
  name: 'Aider',
  detect,
  scanThreads,
  openThread,
  newSession,
}
