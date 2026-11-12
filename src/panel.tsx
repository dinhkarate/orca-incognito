// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Heading,
  Input,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { IncognitoState, ProjectRow } from './protocol'

const state = atom<IncognitoState | null>(null)
const busy = atom(false)
const passcode = atom('')
const confirmPasscode = atom('')
const filter = atom('')
/** The project waiting for "Hide" to be confirmed. */
const confirming = atom<ProjectRow | null>(null)

async function run(task: () => Promise<IncognitoState>): Promise<void> {
  set(busy, true)
  try {
    set(state, await task())
  } finally {
    set(busy, false)
    set(passcode, '')
    set(confirmPasscode, '')
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', (next) => set(state, next)))
  void plugin.request('state.get').then((next) => set(state, next))
}

function SetPasscode() {
  const isBusy = read(busy)
  const value = read(passcode)
  const again = read(confirmPasscode)
  const mismatch = again.length > 0 && value !== again
  return (
    <Stack gap="sm">
      <Text muted size="sm">
        Choose a passcode. You will need it to show incognito projects again.
      </Text>
      <Input label="Passcode" type="password" value={value} onChange={(v) => set(passcode, v)} />
      <Input
        label="Repeat passcode"
        type="password"
        value={again}
        invalid={mismatch}
        onChange={(v) => set(confirmPasscode, v)}
      />
      <Button
        disabled={isBusy || value.length < 4 || value !== again}
        onPress={() => run(() => plugin.request('passcode.set', { passcode: value }))}
      >
        Set passcode
      </Button>
    </Stack>
  )
}

function Unlock({ current }: { current: IncognitoState }) {
  const isBusy = read(busy)
  const value = read(passcode)
  const waiting = current.retryAt !== undefined
  const submit = (v: string) => {
    if (v && !isBusy) {
      void run(() => plugin.request('unlock', { passcode: v }))
    }
  }
  return (
    <Stack gap="sm">
      <Input
        label="Passcode"
        type="password"
        value={value}
        disabled={isBusy || waiting}
        onChange={(v) => set(passcode, v)}
        onSubmit={submit}
      />
      <Button disabled={isBusy || waiting || !value} onPress={() => submit(value)}>
        Show incognito projects
      </Button>
    </Stack>
  )
}

function Projects({ current }: { current: IncognitoState }) {
  const isBusy = read(busy)
  const query = read(filter).toLowerCase()
  const pending = read(confirming)
  const rows = current.projects.filter(
    (p) => !query || p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
  )
  return (
    <Stack gap="sm">
      <Heading level={2}>Projects</Heading>
      {pending ? (
        <Callout tone="warning" title={`Make ${pending.name} incognito?`}>
          <Stack gap="sm">
            <Text size="sm">
              {current.unlocked
                ? 'It stays visible until you lock.'
                : 'It leaves Orca now. Its terminals and agents stop; files and Git worktrees stay on disk.'}
            </Text>
            <Row gap="xs">
              <Button
                tone="warning"
                disabled={isBusy}
                onPress={() => {
                  set(confirming, null)
                  void run(() => plugin.request('project.hide', { id: pending.id }))
                }}
              >
                Make incognito
              </Button>
              <Button variant="ghost" onPress={() => set(confirming, null)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {current.projects.length > 8 ? (
        <Input label="Filter projects" labelHidden type="search" placeholder="Filter projects" value={read(filter)} onChange={(v) => set(filter, v)} />
      ) : null}
      {rows.map((p) => (
        <Row key={p.id} justify="between" gap="sm">
          <Text truncate>{p.name}</Text>
          <Button size="sm" variant="ghost" disabled={isBusy} onPress={() => set(confirming, p)}>
            Hide
          </Button>
        </Row>
      ))}
      {rows.length === 0 ? <Text muted size="sm">No projects.</Text> : null}
    </Stack>
  )
}

function Incognito({ current }: { current: IncognitoState }) {
  const isBusy = read(busy)
  return (
    <Stack gap="sm">
      <Heading level={2}>Incognito</Heading>
      {current.incognito.map((p) => (
        <Stack key={p.path} gap="xs">
          <Row justify="between" gap="sm">
            <Text truncate>{p.name}</Text>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onPress={() => run(() => plugin.request('project.forget', { path: p.path }))}
            >
              Stop hiding
            </Button>
          </Row>
          {p.error ? (
            <Text tone="danger" size="xs">
              {p.error}
            </Text>
          ) : null}
        </Stack>
      ))}
      {current.incognito.length === 0 ? <Text muted size="sm">No incognito projects yet.</Text> : null}
      <Button tone="warning" disabled={isBusy} onPress={() => run(() => plugin.request('lock'))}>
        Lock and hide them
      </Button>
      <Text muted size="xs">
        Locking removes them from Orca and stops their terminals and agents.
      </Text>
    </Stack>
  )
}

export default function Panel() {
  const current = read(state)
  if (!current) {
    return <Spinner label="Loading" />
  }
  if (!current.available) {
    return (
      <Callout tone="danger" title="No secure storage">
        Orca cannot encrypt this plugin's data on this computer, so incognito projects are off.
      </Callout>
    )
  }
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Incognito projects</Heading>
        <Badge tone={current.unlocked ? 'warning' : 'success'}>
          {current.unlocked ? 'Unlocked' : `Locked · ${current.incognitoCount}`}
        </Badge>
      </Row>
      {current.error ? <Callout tone="danger">{current.error}</Callout> : null}
      {read(busy) ? <Spinner label="Working" /> : null}
      {!current.hasPasscode ? (
        <SetPasscode />
      ) : current.unlocked ? (
        <Incognito current={current} />
      ) : (
        <Unlock current={current} />
      )}
      {current.hasPasscode ? <Projects current={current} /> : null}
    </Stack>
  )
}
