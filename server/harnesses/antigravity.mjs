/**
 * Harness adapter: Antigravity (Google) — IDE and desktop agent sessions.
 *
 * Antigravity writes conversation logs and transcripts to:
 *   `~/.gemini/antigravity-ide/brain/<uuid>/.system_generated/logs/transcript.jsonl`
 * and metadata/workspace links to:
 *   `~/.gemini/antigravity-ide/conversations/<uuid>.db`
 *
 * Each line in `transcript.jsonl` represents a step (USER_INPUT, PLANNER_RESPONSE, tool calls).
 * Metadata about the project/workspace is preserved in `trajectory_metadata_blob` within the
 * SQLite database.
 *
 * Read-only, without exception. Never writes to Antigravity session files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const DATA_DIR = process.env.BOT_CROSSING_ANTIGRAVITY_DIR || path.join(HOME, '.gemini', 'antigravity-ide')
const CLI_DIR = process.env.BOT_CROSSING_ANTIGRAVITY_CLI_DIR || path.join(HOME, '.gemini', 'antigravity-cli')

const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 32 * 1024
/** A turn unclosed for longer than this is considered abandoned rather than still running. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `antigravity:${raw}`

let sqlitePromise
const sqliteApi = () => (sqlitePromise ??= import('node:sqlite').catch(() => null))

/**
 * Extract clean user text from a prompt string that may contain Antigravity XML tags
 * like <USER_REQUEST>, <ADDITIONAL_METADATA>, etc.
 */
function extractUserPrompt(content) {
  if (typeof content !== 'string') return ''
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)
  if (m) return m[1].trim()
  return content.trim()
}

/**
 * Read workspace URI and git branch from the conversation SQLite database, if present.
 */
async function readConversationMeta(dbPath) {
  if (!(await exists(dbPath))) return { projectPath: '', gitBranch: '', model: '' }
  const sqlite = await sqliteApi()
  if (!sqlite?.DatabaseSync) return { projectPath: '', gitBranch: '', model: '' }

  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get()
      if (!row || !row.data) return { projectPath: '', gitBranch: '', model: '' }

      const raw = Buffer.from(row.data).toString('utf8')
      let projectPath = ''
      const uriMatch = raw.match(/file:\/\/\/([^\s\x00-\x1f\x7f-\xff"]+)/)
      if (uriMatch) {
        let uri = decodeURIComponent(uriMatch[1])
        // Windows drive letter normalization (e.g. 'd:/Projects' or 'D:/Projects')
        if (/^[A-Za-z]:/.test(uri)) {
          projectPath = uri
        } else if (/^[A-Za-z]\//.test(uri)) {
          projectPath = uri[0] + ':' + uri.slice(1)
        } else {
          projectPath = uri
        }
      }

      let gitBranch = ''
      const branchMatch = raw.match(/\b(main|master|dev|feature\/[a-zA-Z0-9_-]+)\b/)
      if (branchMatch) gitBranch = branchMatch[1]

      return { projectPath, gitBranch, model: '' }
    } finally {
      db.close()
    }
  } catch {
    return { projectPath: '', gitBranch: '', model: '' }
  }
}

/**
 * Inspect head and tail of transcript.jsonl to determine prompt preview, timestamps,
 * and current turn status.
 */
async function inspectTranscript(transcriptPath, stat) {
  let prompt = ''
  let createdAt = stat.mtimeMs
  let lastActivityAt = stat.mtimeMs
  let running = false
  let unread = false
  let hasError = false
  let model = ''

  try {
    const headText = await readHead(transcriptPath, HEAD_BYTES)
    const headRecords = jsonLines(headText)
    for (const r of headRecords) {
      if (r.type === 'USER_INPUT' && r.content) {
        prompt = extractUserPrompt(r.content)
        if (r.created_at) {
          const t = Date.parse(r.created_at)
          if (!Number.isNaN(t)) createdAt = t
        }
        break
      }
    }
  } catch {}

  try {
    const tailText = await readTail(transcriptPath, TAIL_BYTES)
    const tailRecords = jsonLines(tailText)
    if (tailRecords.length) {
      const last = tailRecords[tailRecords.length - 1]
      if (last.created_at) {
        const t = Date.parse(last.created_at)
        if (!Number.isNaN(t)) lastActivityAt = t
      }

      // Check if any recent step errored
      hasError = tailRecords.some((r) => r.status === 'ERROR' || r.status === 'FAILED')

      const now = Date.now()
      const isFresh = now - stat.mtimeMs < ACTIVE_WINDOW_MS

      if (last.type === 'USER_INPUT' || last.status === 'RUNNING' || last.status === 'IN_PROGRESS') {
        running = isFresh
        unread = false
      } else if (last.type === 'PLANNER_RESPONSE' && last.status === 'DONE') {
        running = false
        unread = true // Waiting for the user's next request
      }
    }
  } catch {}

  return { prompt, createdAt, lastActivityAt, running, unread, hasError, model }
}

async function scanStore(storeDir, source) {
  const brainDir = path.join(storeDir, 'brain')
  const convDir = path.join(storeDir, 'conversations')
  if (!(await exists(brainDir))) return []

  const dirs = await listDirs(brainDir)
  const threads = []

  for (const dir of dirs) {
    const sessionUuid = path.basename(dir)
    if (!UUID.test(sessionUuid)) continue

    const transcriptPath = path.join(dir, '.system_generated', 'logs', 'transcript.jsonl')
    let stat
    try {
      stat = await fsp.stat(transcriptPath)
    } catch {
      continue // No transcript found
    }

    const dbPath = path.join(convDir, `${sessionUuid}.db`)
    const [meta, info] = await Promise.all([
      readConversationMeta(dbPath),
      inspectTranscript(transcriptPath, stat),
    ])

    const projectPath = meta.projectPath
    const project = projectPath ? path.basename(projectPath) : 'Antigravity'

    const cleanPrompt = (info.prompt || 'Untitled thread').replace(/\s+/g, ' ').trim()
    threads.push({
      id: ID(sessionUuid),
      title: cleanPrompt.slice(0, 120),
      preview: cleanPrompt.slice(0, 240),
      project: project || 'unknown',
      projectPath: projectPath || '',
      worktree: '',
      cwd: projectPath || '',
      gitBranch: meta.gitBranch || '',
      model: info.model || meta.model || 'Gemini',
      effort: '',
      createdAt: info.createdAt || stat.mtimeMs,
      lastActivityAt: info.lastActivityAt || stat.mtimeMs,
      lastFocusedAt: 0,
      unread: info.unread,
      running: info.running,
      hasError: info.hasError,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: stat.size,
      source,
      canOpen: false,
      ref: { conversationId: sessionUuid, projectPath },
    })
  }

  return threads
}

async function scanThreads() {
  const [ideThreads, cliThreads] = await Promise.all([
    scanStore(DATA_DIR, 'ide'),
    scanStore(CLI_DIR, 'cli'),
  ])

  // Deduplicate by id if a thread happens to exist in both
  const seen = new Set()
  const out = []
  for (const t of [...ideThreads, ...cliThreads]) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}

function openThread(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, error: 'Invalid thread reference' }
  }
  if (!UUID.test(ref.conversationId)) {
    return { ok: false, error: 'Invalid conversation id' }
  }
  return {
    ok: false,
    error: 'Antigravity has no direct link to a single thread — open the workspace folder in Antigravity to view the session.',
  }
}

function newSession() {
  return {
    ok: false,
    error: 'Start a new session directly from Antigravity.',
  }
}

const detect = async () => (await exists(DATA_DIR)) || (await exists(CLI_DIR))

export default {
  id: 'antigravity',
  name: 'Antigravity',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { DATA_DIR, CLI_DIR },
}
