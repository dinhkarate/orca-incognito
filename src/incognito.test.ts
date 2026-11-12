// Drives the incognito logic against an in-memory stand-in for Orca's runtime.
import { assert, test } from 'orca/testing'
import { createIncognito } from './incognito'

type FakeRepo = Record<string, unknown> & { id: string; path: string }

function fakeOrca(repos: FakeRepo[], worktrees: Record<string, Record<string, unknown>[]> = {}) {
  let nextId = 1
  let runtimeId = 'runtime-1'
  const calls: { method: string; params: any }[] = []
  const byId = (selector: string) => repos.find((r) => `id:${r.id}` === selector)
  const rpc = {
    runtimeId: async () => runtimeId,
    call: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params })
      switch (method) {
        case 'repo.list':
          return { repos: repos.map((r) => ({ ...r })) }
        case 'worktree.list':
          return { worktrees: worktrees[byId(params.repo)!.path] ?? [] }
        case 'repo.rm':
          repos = repos.filter((r) => r !== byId(params.repo))
          return { removed: true }
        case 'repo.add': {
          const repo = { id: `new-${nextId++}`, path: params.path, kind: params.kind, displayName: params.displayName }
          repos.push(repo)
          return { repo }
        }
        case 'repo.update':
          Object.assign(byId(params.repo)!, params.updates)
          return { repo: byId(params.repo) }
        case 'worktree.set':
          return { ok: true }
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const store = new Map<string, string>()
  const secrets = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => void store.set(key, value)
  }
  return {
    rpc,
    secrets,
    store,
    calls,
    repos: () => repos,
    restart: () => void (runtimeId = 'runtime-2')
  }
}

function setup(orca: ReturnType<typeof fakeOrca>, now = () => 1_000) {
  return createIncognito({
    rpc: orca.rpc,
    secrets: orca.secrets,
    secretsAvailable: async () => true,
    log: () => {},
    now
  })
}

const SECRET = { id: 'r1', path: '/work/secret', displayName: 'Client X', badgeColor: '#f00', kind: 'git' }
const OTHER = { id: 'r2', path: '/work/other', kind: 'git' }

test('needs a passcode before hiding', async () => {
  const orca = fakeOrca([{ ...SECRET }])
  const incognito = setup(orca)
  const state = await incognito.hideProject('r1')
  assert.equal(state.error, 'Set a passcode first.')
  assert.equal(orca.repos().length, 1)
})

test('hiding removes the project and keeps nothing readable outside secrets', async () => {
  const orca = fakeOrca([{ ...SECRET }, { ...OTHER }])
  const incognito = setup(orca)
  await incognito.setPasscode('1234')
  const state = await incognito.hideProject('r1')
  assert.deepEqual(
    orca.repos().map((r) => r.id),
    ['r2']
  )
  assert.equal(state.unlocked, false)
  assert.equal(state.incognitoCount, 1)
  assert.deepEqual(state.incognito, [])
  assert.deepEqual(
    state.projects.map((p) => p.name),
    ['other']
  )
  assert.ok(!orca.store.get('passcode')!.includes('1234'))
})

test('unlock restores settings and workspaces, lock hides them again', async () => {
  const orca = fakeOrca([{ ...SECRET }], {
    '/work/secret': [
      { path: '/work/secret', isMainWorktree: true },
      { path: '/wt/feature', displayName: 'Feature', displayNameMode: 'fixed', comment: 'wip', workspaceStatus: 'todo' },
      { path: '/wt/auto', displayName: 'auto', displayNameMode: 'automatic' }
    ]
  })
  const incognito = setup(orca)
  await incognito.setPasscode('1234')
  await incognito.hideProject('r1')

  const unlocked = await incognito.unlock('1234')
  assert.equal(unlocked.unlocked, true)
  assert.deepEqual(unlocked.incognito, [{ path: '/work/secret', name: 'Client X' }])
  const restored = orca.repos()[0]
  assert.equal(restored.path, '/work/secret')
  assert.equal(restored.badgeColor, '#f00')
  assert.deepEqual(restored.importedExternalWorktreePaths, ['/wt/feature', '/wt/auto'])
  const sets = orca.calls.filter((c) => c.method === 'worktree.set').map((c) => c.params)
  // An automatic name is left to Orca, so /wt/auto needs no update.
  assert.deepEqual(sets, [
    { worktree: 'path:/wt/feature', displayName: 'Feature', comment: 'wip', workspaceStatus: 'todo' }
  ])

  const locked = await incognito.lock()
  assert.equal(locked.unlocked, false)
  assert.equal(orca.repos().length, 0)
})

test('wrong passcodes back off', async () => {
  let clock = 1_000
  const orca = fakeOrca([{ ...SECRET }])
  const incognito = setup(orca, () => clock)
  await incognito.setPasscode('1234')
  await incognito.hideProject('r1')
  for (let i = 0; i < 4; i++) {
    assert.equal((await incognito.unlock('0000')).error, 'Wrong passcode.')
  }
  const fifth = await incognito.unlock('0000')
  assert.ok(fifth.retryAt)
  assert.match((await incognito.unlock('1234')).error!, /Too many attempts/)
  clock += 31_000
  assert.equal((await incognito.unlock('1234')).unlocked, true)
})

test('a project marked while unlocked hides at the next lock', async () => {
  const orca = fakeOrca([{ ...SECRET }, { ...OTHER }])
  const incognito = setup(orca)
  await incognito.setPasscode('1234')
  await incognito.unlock('1234')
  const marked = await incognito.hideProject('r2')
  assert.equal(orca.repos().length, 2)
  assert.deepEqual(
    marked.incognito.map((p) => p.path),
    ['/work/other']
  )
  await incognito.lock()
  assert.deepEqual(
    orca.repos().map((r) => r.id),
    ['r1']
  )
})

test('locks again after Orca restarts while unlocked', async () => {
  const orca = fakeOrca([{ ...SECRET }])
  const incognito = setup(orca)
  await incognito.setPasscode('1234')
  await incognito.hideProject('r1')
  await incognito.unlock('1234')
  assert.equal(await incognito.relockAfterRestart(), false)
  orca.restart()
  assert.equal(await incognito.relockAfterRestart(), true)
  assert.equal(orca.repos().length, 0)
  assert.equal((await incognito.state()).unlocked, false)
})

test('stop hiding keeps the project in Orca', async () => {
  const orca = fakeOrca([{ ...SECRET }])
  const incognito = setup(orca)
  await incognito.setPasscode('1234')
  await incognito.hideProject('r1')
  await incognito.unlock('1234')
  const state = await incognito.forgetProject('/work/secret')
  assert.equal(state.incognitoCount, 0)
  await incognito.lock()
  assert.equal(orca.repos().length, 1)
})

test('changing the passcode needs the current one', async () => {
  const orca = fakeOrca([])
  const incognito = setup(orca)
  await incognito.setPasscode('1234')
  assert.equal((await incognito.setPasscode('5678', '0000')).error, 'The current passcode is wrong.')
  assert.equal((await incognito.setPasscode('5678', '1234')).error, undefined)
})
