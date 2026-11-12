// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { IncognitoState } from './protocol'

const base: IncognitoState = {
  available: true,
  hasPasscode: true,
  unlocked: false,
  incognitoCount: 1,
  projects: [{ id: 'r2', name: 'other', path: '/work/other' }],
  groups: [],
  incognito: []
}

test('asks for a passcode first', async () => {
  let set: unknown
  const host = mockHost({
    requests: {
      'state.get': () => ({ ...base, hasPasscode: false, incognitoCount: 0 }),
      'passcode.set': (input) => ((set = input), base)
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Projects' }), null)
  await view.type({ label: 'Passcode' }, '1234')
  await view.type({ label: 'Repeat passcode' }, '1234')
  await view.press({ text: 'Set passcode' })
  assert.deepEqual(set, { passcode: '1234' })
  assert.ok(view.find({ text: 'Show incognito projects' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('locked: shows only a count, and hiding asks first', async () => {
  const hidden: string[] = []
  const host = mockHost({
    requests: {
      'state.get': () => base,
      'project.hide': ({ id }) => (hidden.push(id), { ...base, projects: [], incognitoCount: 2 })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Locked · 1' }))
  await view.press({ text: 'Hide' })
  assert.deepEqual(hidden, [])
  await view.press({ text: 'Make incognito' })
  assert.deepEqual(hidden, ['r2'])
  assert.ok(view.find({ text: 'Locked · 2' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('unlock lists the incognito projects and can lock again', async () => {
  const unlocked = { ...base, unlocked: true, incognito: [{ path: '/work/secret', name: 'Client X' }] }
  const host = mockHost({
    requests: {
      'state.get': () => base,
      unlock: ({ passcode }) => (passcode === '1234' ? unlocked : { ...base, error: 'Wrong passcode.' }),
      lock: () => base
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Passcode' }, '0000', { submit: true })
  assert.ok(view.find({ text: 'Wrong passcode.' }))
  await view.type({ label: 'Passcode' }, '1234', { submit: true })
  assert.ok(view.find({ text: 'Client X' }))
  await view.press({ text: 'Lock and hide them' })
  assert.equal(view.find({ text: 'Client X' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('groups projects and hides a whole group after confirming', async () => {
  const hidden: string[] = []
  const grouped: IncognitoState = {
    ...base,
    projects: [
      { id: 'a', name: 'alpha', path: '/p/a', groupId: 'g7', group: '7N' },
      { id: 'b', name: 'beta', path: '/p/b', groupId: 'g7', group: '7N' },
      { id: 'c', name: 'gamma', path: '/p/c' }
    ],
    groups: [{ id: 'g7', name: '7N' }]
  }
  const host = mockHost({
    requests: {
      'state.get': () => grouped,
      'group.hide': ({ groupId }) => (hidden.push(groupId), { ...base, projects: [], incognitoCount: 3 })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /^7N/ }))
  assert.ok(view.find({ text: /^No group/ }))
  await view.press({ text: 'Hide group' })
  assert.ok(view.find({ label: 'Make the 7N group incognito?' }))
  assert.ok(view.find({ text: /Its 2 projects leave Orca now/ }))
  await view.press({ text: 'Make incognito' })
  assert.deepEqual(hidden, ['g7'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
