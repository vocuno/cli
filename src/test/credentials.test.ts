import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { CredentialsStore } from '../credentials.js'

function tempStore(): CredentialsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocuno-cli-test-'))
  return new CredentialsStore(path.join(dir, 'nested', 'credentials.json'))
}

test('round-trips credentials', () => {
  const store = tempStore()
  assert.equal(store.load(), null)
  store.save({ clientId: 'vmc_x', refreshToken: 'vmrt_1', accessToken: 'vmat_1', expiresAt: 123 })
  assert.deepEqual(store.load(), {
    clientId: 'vmc_x',
    refreshToken: 'vmrt_1',
    accessToken: 'vmat_1',
    expiresAt: 123,
  })
})

test('file is written with mode 0600', { skip: process.platform === 'win32' }, () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_x' })
  const mode = fs.statSync(store.filePath).mode & 0o777
  assert.equal(mode, 0o600)
})

test('update merges and persists', () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_x', refreshToken: 'old' })
  store.update({ refreshToken: 'new', accessToken: 'vmat_2' })
  const creds = store.load()
  assert.equal(creds?.clientId, 'vmc_x')
  assert.equal(creds?.refreshToken, 'new')
  assert.equal(creds?.accessToken, 'vmat_2')
})

test('clearTokens keeps the registered client, drops the session', () => {
  const store = tempStore()
  store.save({
    clientId: 'vmc_x',
    redirectUris: ['http://127.0.0.1:23456/callback'],
    accessToken: 'vmat_1',
    refreshToken: 'vmrt_1',
    expiresAt: 99,
    email: 'a@b.c',
    uid: 'u1',
    scope: 'mcp',
  })
  store.clearTokens()
  const creds = store.load()
  assert.equal(creds?.clientId, 'vmc_x')
  assert.deepEqual(creds?.redirectUris, ['http://127.0.0.1:23456/callback'])
  assert.equal(creds?.accessToken, undefined)
  assert.equal(creds?.refreshToken, undefined)
  assert.equal(creds?.email, undefined)
})

test('corrupt file loads as null', () => {
  const store = tempStore()
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true })
  fs.writeFileSync(store.filePath, 'not json')
  assert.equal(store.load(), null)
})
