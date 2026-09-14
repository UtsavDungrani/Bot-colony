import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import antigravity from '../server/harnesses/antigravity.mjs'

const SESSION_ID = '362b9116-82e6-448e-97a4-2f90a478bf30'

async function fakeAntigravity(records, opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'antigravity-fixture-'))
  const brainDir = path.join(root, 'brain', SESSION_ID, '.system_generated', 'logs')
  await fsp.mkdir(brainDir, { recursive: true })
  await fsp.writeFile(
    path.join(brainDir, 'transcript.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )

  if (opts.meta) {
    const convDir = path.join(root, 'conversations')
    await fsp.mkdir(convDir, { recursive: true })
    const sqlite = await import('node:sqlite').catch(() => null)
    if (sqlite?.DatabaseSync) {
      const db = new sqlite.DatabaseSync(path.join(convDir, `${SESSION_ID}.db`))
      db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)')
      const buf = Buffer.from(opts.meta, 'utf8')
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', buf)
      db.close()
    }
  }

  return root
}

async function harnessWith(home) {
  process.env.BOT_CROSSING_ANTIGRAVITY_DIR = home
  process.env.BOT_CROSSING_ANTIGRAVITY_CLI_DIR = path.join(home, 'nonexistent-cli')
  const mod = await import(`../server/harnesses/antigravity.mjs?${home}`)
  return mod.default
}

test('antigravity refuses malformed thread references', () => {
  assert.equal(antigravity.openThread(null).ok, false)
  assert.equal(antigravity.openThread({}).ok, false)
  assert.equal(antigravity.openThread({ conversationId: 'not-a-uuid' }).ok, false)
  assert.equal(antigravity.openThread({ conversationId: [SESSION_ID] }).ok, false)
})

test('an Antigravity transcript yields a thread with the extracted user request as title', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-14T05:24:30Z',
      content: '<USER_REQUEST>\ncheck this project out\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nrunning\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-14T05:25:00Z',
      content: 'Here is the project overview...',
    },
  ], {
    meta: 'file:///d:/Projects/bot-crossing main',
  })

  const h = await harnessWith(home)
  assert.equal(await h.detect(), true)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)

  const [t] = threads
  assert.equal(t.id, `antigravity:${SESSION_ID}`)
  assert.equal(t.title, 'check this project out')
  assert.equal(t.preview, 'check this project out')
  assert.equal(t.project, 'bot-crossing')
  assert.equal(t.running, false)
  assert.equal(t.unread, true, 'finished response waits for user input')
  assert.equal(t.hasError, false)
  assert.ok(t.sizeBytes > 0)

  await fsp.rm(home, { recursive: true, force: true })
})

test('an Antigravity turn in progress is marked running', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>\nworking on task\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'IN_PROGRESS',
      created_at: new Date().toISOString(),
      content: 'thinking...',
    },
  ])

  const h = await harnessWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, true)
  assert.equal(t.unread, false)

  await fsp.rm(home, { recursive: true, force: true })
})

test('an errored turn sets hasError', async () => {
  const home = await fakeAntigravity([
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-14T05:24:30Z',
      content: '<USER_REQUEST>\ndo something\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'ERROR',
      created_at: '2026-09-14T05:25:00Z',
      content: 'failed',
    },
  ])

  const h = await harnessWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, true)

  await fsp.rm(home, { recursive: true, force: true })
})
