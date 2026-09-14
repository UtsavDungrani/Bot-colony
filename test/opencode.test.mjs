import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import opencode from '../server/harnesses/opencode.mjs'

const SESSION_ID = 'session-opencode-123'

async function fakeOpenCode(data) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-fixture-'))
  const sessionsDir = path.join(root, 'sessions')
  await fsp.mkdir(sessionsDir, { recursive: true })
  await fsp.writeFile(
    path.join(sessionsDir, `${SESSION_ID}.json`),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  )
  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_OPENCODE_DIR = home
  const mod = await import(`../server/harnesses/opencode.mjs?${home}`)
  return mod.default
}

test('opencode refuses malformed thread references', () => {
  assert.equal(opencode.openThread(null).ok, false)
  assert.equal(opencode.openThread({}).ok, false)
})

test('an OpenCode session yields a thread with prompt, cwd and status', async () => {
  const home = await fakeOpenCode({
    id: SESSION_ID,
    cwd: '/projects/open-app',
    messages: [
      { role: 'user', content: 'Refactor the backend router' },
      { role: 'assistant', content: 'All routes refactored.', status: 'completed' },
    ],
  })

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `opencode:${SESSION_ID}`)
  assert.equal(t.title, 'Refactor the backend router')
  assert.equal(t.preview, 'Refactor the backend router')
  assert.equal(t.project, 'open-app')
  assert.equal(t.projectPath, '/projects/open-app')
  assert.equal(t.running, false)
  assert.equal(t.unread, true)

  await fsp.rm(home, { recursive: true, force: true })
})
