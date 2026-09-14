import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import copilot from '../server/harnesses/copilot.mjs'

const SESSION_ID = 'copilot-chat-12345'

async function fakeCopilot(records, folderPath) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'copilot-fixture-'))
  const wsDir = path.join(root, 'workspace-hash-1')
  const chatDir = path.join(wsDir, 'chatSessions')
  await fsp.mkdir(chatDir, { recursive: true })

  if (folderPath) {
    await fsp.writeFile(
      path.join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: `file:///${folderPath.replace(/\\/g, '/')}` })
    )
  }

  await fsp.writeFile(
    path.join(chatDir, `${SESSION_ID}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )

  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_COPILOT_STORAGE = home
  const mod = await import(`../server/harnesses/copilot.mjs?${home}`)
  return mod.default
}

test('copilot refuses malformed thread references', () => {
  assert.equal(copilot.openThread(null).ok, false)
  assert.equal(copilot.openThread({}).ok, false)
})

test('a GitHub Copilot session yields a thread with title and project', async () => {
  const home = await fakeCopilot([
    { kind: 0, v: { creationDate: 1788753733175, sessionId: SESSION_ID } },
    { kind: 1, k: ['customTitle'], v: 'Fix authentication bug' },
    { kind: 1, k: ['responderUsername'], v: 'GitHub Copilot' },
    { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { resolvedModel: 'gpt-4o', agentId: 'github.copilot.chat' } } },
  ], 'C:/projects/auth-service')

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `copilot:${SESSION_ID}`)
  assert.equal(t.title, 'Fix authentication bug')
  assert.equal(t.preview, 'Fix authentication bug')
  assert.equal(t.project, 'auth-service')
  assert.equal(t.model, 'gpt-4o')
  assert.equal(t.canOpen, true)

  const opened = h.openThread({ projectPath: t.projectPath })
  assert.equal(opened.ok, true)
  assert.match(opened.url, /^vscode:\/\/file\//)

  await fsp.rm(home, { recursive: true, force: true })
})
