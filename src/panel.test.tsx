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
