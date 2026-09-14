import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import amazonQ from '../server/harnesses/amazon-q.mjs'

const SESSION_ID = 'chat-history-2026-09-14'

async function fakeAmazonQ(data) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'amazon-q-fixture-'))
  await fsp.writeFile(
    path.join(root, `${SESSION_ID}.json`),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  )
  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_AMAZON_Q_DIR = home
  const mod = await import(`../server/harnesses/amazon-q.mjs?${home}`)
  return mod.default
}

test('amazon-q refuses malformed thread references', () => {
  assert.equal(amazonQ.openThread(null).ok, false)
  assert.equal(amazonQ.openThread({}).ok, false)
})

test('an Amazon Q session yields a thread with prompt, cwd and status', async () => {
  const home = await fakeAmazonQ({
    id: SESSION_ID,
    cwd: '/projects/cloud-infra',
    messages: [
      { role: 'user', content: 'Generate Terraform scripts' },
      { role: 'assistant', content: 'Here is your Terraform configuration.', status: 'completed' },
    ],
  })

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `amazon-q:${SESSION_ID}`)
  assert.equal(t.title, 'Generate Terraform scripts')
  assert.equal(t.preview, 'Generate Terraform scripts')
  assert.equal(t.project, 'cloud-infra')
  assert.equal(t.projectPath, '/projects/cloud-infra')
  assert.equal(t.running, false)
  assert.equal(t.unread, true)

  await fsp.rm(home, { recursive: true, force: true })
})
