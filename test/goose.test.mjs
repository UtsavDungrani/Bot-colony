import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import goose from '../server/harnesses/goose.mjs'

const SESSION_ID = '20260914_100000'

async function fakeGoose(records) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'goose-fixture-'))
  await fsp.writeFile(
    path.join(root, `${SESSION_ID}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_GOOSE_SESSIONS = home
  const mod = await import(`../server/harnesses/goose.mjs?${home}`)
  return mod.default
}

test('goose refuses malformed thread references', () => {
  assert.equal(goose.openThread(null).ok, false)
  assert.equal(goose.openThread({}).ok, false)
})

test('a Goose transcript yields a thread with prompt, cwd and status', async () => {
  const home = await fakeGoose([
    { role: 'user', content: 'Build a new widget', working_dir: '/projects/my-widget' },
    { role: 'assistant', content: 'Here is your widget code.', status: 'completed' },
  ])

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `goose:${SESSION_ID}`)
  assert.equal(t.title, 'Build a new widget')
  assert.equal(t.preview, 'Build a new widget')
  assert.equal(t.project, 'my-widget')
  assert.equal(t.projectPath, '/projects/my-widget')
  assert.equal(t.running, false)
  assert.equal(t.unread, true)
  assert.equal(t.hasError, false)

  await fsp.rm(home, { recursive: true, force: true })
})

test('an active Goose turn is marked running', async () => {
  const home = await fakeGoose([
    { role: 'user', content: 'Do something', status: 'running' },
  ])

  const h = await harnessWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, true)
  assert.equal(t.unread, false)

  await fsp.rm(home, { recursive: true, force: true })
})
