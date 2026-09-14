import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import aider from '../server/harnesses/aider.mjs'

async function fakeAider(mdContent) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aider-fixture-'))
  await fsp.writeFile(path.join(root, '.aider.chat.history.md'), mdContent)
  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_AIDER_DIRS = home
  const mod = await import(`../server/harnesses/aider.mjs?${home}`)
  return mod.default
}

test('aider refuses malformed thread references', () => {
  assert.equal(aider.openThread(null).ok, false)
  assert.equal(aider.openThread({}).ok, false)
})

test('an Aider markdown history yields a thread with prompt and project', async () => {
  const home = await fakeAider(`
# aider chat started at 2026-09-14 12:00:00

#### Add user authentication with OAuth

I have updated auth.js with OAuth support.
`)

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.match(t.id, /^aider:/)
  assert.equal(t.title, 'Add user authentication with OAuth')
  assert.equal(t.preview, 'Add user authentication with OAuth')
  assert.equal(t.projectPath, home)

  await fsp.rm(home, { recursive: true, force: true })
})
