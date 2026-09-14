import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import qwenCode from '../server/harnesses/qwen-code.mjs'

const SESSION_ID = 'qwen-session-789'

async function fakeQwen(data) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-fixture-'))
  const sessionsDir = path.join(root, 'sessions')
  await fsp.mkdir(sessionsDir, { recursive: true })
  await fsp.writeFile(
    path.join(sessionsDir, `${SESSION_ID}.json`),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  )
  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_QWEN_DIR = home
  const mod = await import(`../server/harnesses/qwen-code.mjs?${home}`)
  return mod.default
}

test('qwen-code refuses malformed thread references', () => {
  assert.equal(qwenCode.openThread(null).ok, false)
  assert.equal(qwenCode.openThread({}).ok, false)
})

test('a Qwen Code session yields a thread with prompt, cwd and status', async () => {
  const home = await fakeQwen({
    id: SESSION_ID,
    cwd: '/projects/llm-service',
    messages: [
      { role: 'user', content: 'Implement streaming completions' },
      { role: 'assistant', content: 'Streaming completions added.', status: 'completed' },
    ],
  })

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `qwen-code:${SESSION_ID}`)
  assert.equal(t.title, 'Implement streaming completions')
  assert.equal(t.preview, 'Implement streaming completions')
  assert.equal(t.project, 'llm-service')
  assert.equal(t.projectPath, '/projects/llm-service')
  assert.equal(t.running, false)
  assert.equal(t.unread, true)

  await fsp.rm(home, { recursive: true, force: true })
})
