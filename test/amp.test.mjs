import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import amp from '../server/harnesses/amp.mjs'

const SESSION_ID = 'amp-thread-456'

async function fakeAmp(data) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'amp-fixture-'))
  const threadsDir = path.join(root, 'threads')
  await fsp.mkdir(threadsDir, { recursive: true })
  await fsp.writeFile(
    path.join(threadsDir, `${SESSION_ID}.json`),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  )
  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_AMP_DIR = home
  const mod = await import(`../server/harnesses/amp.mjs?${home}`)
  return mod.default
}

test('amp refuses malformed thread references', () => {
  assert.equal(amp.openThread(null).ok, false)
  assert.equal(amp.openThread({}).ok, false)
})

test('an Amp thread yields a thread with prompt, cwd and status', async () => {
  const home = await fakeAmp({
    id: SESSION_ID,
    cwd: '/projects/analytics-api',
    messages: [
      { role: 'user', content: 'Optimize BigQuery queries' },
      { role: 'assistant', content: 'Queries partitioned and optimized.', status: 'completed' },
    ],
  })

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `amp:${SESSION_ID}`)
  assert.equal(t.title, 'Optimize BigQuery queries')
  assert.equal(t.preview, 'Optimize BigQuery queries')
  assert.equal(t.project, 'analytics-api')
  assert.equal(t.projectPath, '/projects/analytics-api')
  assert.equal(t.running, false)
  assert.equal(t.unread, true)

  await fsp.rm(home, { recursive: true, force: true })
})
