/**
 * Harness adapter: GitHub Copilot (Microsoft / GitHub) — VS Code Copilot Chat.
 *
 * Copilot Chat stores session logs and transcripts per-workspace in:
 *   - Windows: `%APPDATA%/Code/User/workspaceStorage/<workspaceHash>/chatSessions/*.jsonl`
 *   - macOS: `~/Library/Application Support/Code/User/workspaceStorage/<workspaceHash>/chatSessions/*.jsonl`
 *   - Linux: `~/.config/Code/User/workspaceStorage/<workspaceHash>/chatSessions/*.jsonl`
 *
 * Each workspace folder contains a `workspace.json` file identifying the repository/project.
 *
 * Read-only, without exception. Never writes to VS Code or Copilot files.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, listFiles, readHead, readTail } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024

function candidateRoots() {
  if (process.env.BOT_CROSSING_COPILOT_STORAGE) {
    return [process.env.BOT_CROSSING_COPILOT_STORAGE]
  }
  const roots = []
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
    roots.push(path.join(roaming, 'Code', 'User', 'workspaceStorage'))
    roots.push(path.join(roaming, 'Code - Insiders', 'User', 'workspaceStorage'))
  } else if (process.platform === 'darwin') {
    roots.push(path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'))
    roots.push(path.join(HOME, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'))
  } else {
    roots.push(path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage'))
    roots.push(path.join(HOME, '.config', 'Code - Insiders', 'User', 'workspaceStorage'))
  }
  return roots
}

const ID = (raw) => `copilot:${raw}`

function decodeUriPath(uri) {
  if (!uri || typeof uri !== 'string') return ''
  let cleaned = uri.replace(/^file:\/\/\/?/i, '')
  cleaned = decodeURIComponent(cleaned)
  // Normalize Windows drive letters (e.g. c:/Users -> C:/Users)
  if (/^[a-zA-Z]:/.test(cleaned)) {
    return cleaned[0].toUpperCase() + cleaned.slice(1)
  }
  return cleaned.startsWith('/') ? cleaned : '/' + cleaned
}

async function readWorkspaceFolder(wsDir) {
  const wsFile = path.join(wsDir, 'workspace.json')
  try {
    const text = await fsp.readFile(wsFile, 'utf8')
    const obj = JSON.parse(text)
    if (obj.folder) return decodeUriPath(obj.folder)
    if (obj.workspace) return decodeUriPath(obj.workspace)
  } catch {}
  return ''
}

function parseSessionRecords(records) {
  let title = ''
  let creationDate = 0
  let isCopilot = false
  let model = 'GitHub Copilot'
  let hasPending = false
  let lastTimestamp = 0
  let hasError = false

  for (const r of records) {
    // Check for Copilot indicators
    if (
      (r.k && r.k.includes('responderUsername') && typeof r.v === 'string' && r.v.toLowerCase().includes('copilot')) ||
      (r.v && typeof r.v === 'object' && r.v.responderUsername && r.v.responderUsername.toLowerCase().includes('copilot'))
    ) {
      isCopilot = true
    }

    if (r.kind === 0 && r.v) {
      if (r.v.creationDate) creationDate = r.v.creationDate
      if (r.v.hasPendingEdits || (r.v.pendingRequests && r.v.pendingRequests.length > 0)) {
        hasPending = true
      }
    }

    if (r.k && r.k.includes('customTitle') && typeof r.v === 'string') {
      title = r.v
    }

    if (r.v && r.v.metadata) {
      if (r.v.metadata.agentId && r.v.metadata.agentId.toLowerCase().includes('copilot')) {
        isCopilot = true
      }
      if (r.v.metadata.resolvedModel) {
        model = r.v.metadata.resolvedModel
      }
    }

    if (r.v && r.v.error) {
      hasError = true
    }
  }

  return { title, creationDate, isCopilot, model, hasPending, hasError, lastTimestamp }
}

async function scanThreads() {
  const roots = candidateRoots()
  const threads = []
  const now = Date.now()

  for (const root of roots) {
    if (!(await exists(root))) continue

    const wsDirs = await listDirs(root)
    for (const wsDir of wsDirs) {
      const chatDir = path.join(wsDir, 'chatSessions')
      if (!(await exists(chatDir))) continue

      const files = await listFiles(chatDir, (n) => n.endsWith('.jsonl'))
      if (!files.length) continue

      const projectPath = await readWorkspaceFolder(wsDir)
      const project = projectPath ? path.basename(projectPath) : 'Copilot'

      for (const file of files) {
        let stat
        try {
          stat = await fsp.stat(file)
        } catch {
          continue
        }

        const sessionId = path.basename(file, '.jsonl')
        const headText = await readHead(file, HEAD_BYTES).catch(() => '')
        const tailText = await readTail(file, TAIL_BYTES).catch(() => '')

        // Only include if GitHub Copilot is referenced
        if (
          !headText.includes('copilot') &&
          !headText.includes('Copilot') &&
          !tailText.includes('copilot') &&
          !tailText.includes('Copilot')
        ) {
          continue
        }

        const headRecords = jsonLines(headText)
        const tailRecords = jsonLines(tailText)
        const headInfo = parseSessionRecords(headRecords)
        const tailInfo = parseSessionRecords(tailRecords)

        const title = headInfo.title || tailInfo.title || 'Untitled Copilot chat'
        const cleanTitle = title.replace(/\s+/g, ' ').trim()
        const model = tailInfo.model || headInfo.model || 'GitHub Copilot'
        const createdAt = headInfo.creationDate || stat.birthtimeMs || stat.mtimeMs

        const isFresh = now - stat.mtimeMs < ACTIVE_WINDOW_MS
        const running = isFresh && (tailInfo.hasPending || headInfo.hasPending)
        const unread = !running && isFresh
        const hasError = headInfo.hasError || tailInfo.hasError

        threads.push({
          id: ID(sessionId),
          title: cleanTitle.slice(0, 120),
          preview: cleanTitle.slice(0, 240),
          project: project || 'unknown',
          projectPath: projectPath || '',
          worktree: '',
          cwd: projectPath || '',
          gitBranch: '',
          model,
          effort: '',
          createdAt,
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
          source: 'vscode',
          canOpen: Boolean(projectPath),
          ref: { sessionId, projectPath },
        })
      }
    }
  }

  return threads
}

function openThread(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    return { ok: false, error: 'Invalid thread reference' }
  }
  if (ref.projectPath) {
    const abs = String(ref.projectPath).replace(/\\/g, '/')
    return { ok: true, url: `vscode://file/${encodeURI(abs.startsWith('/') ? abs.slice(1) : abs)}` }
  }
  return {
    ok: false,
    error: 'Open the workspace in VS Code to view this Copilot session.',
  }
}

function newSession(dir) {
  if (!dir) return { ok: false, error: 'No directory provided' }
  const abs = String(dir).replace(/\\/g, '/')
  return { ok: true, url: `vscode://file/${encodeURI(abs.startsWith('/') ? abs.slice(1) : abs)}` }
}

async function detect() {
  for (const root of candidateRoots()) {
    if (await exists(root)) return true
  }
  return false
}

export default {
  id: 'copilot',
  name: 'GitHub Copilot',
  detect,
  scanThreads,
  openThread,
  newSession,
}
