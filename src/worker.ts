// The plugin's worker: answers the panel and locks again when Orca restarted while unlocked.
// `workspace.changed` fires soon after Orca starts, which starts this worker without the panel.
import type { OrcaWorkerApi } from 'orca/worker'
import { createIncognito } from './incognito'
import { createRuntimeRpc } from './runtime-rpc'
import type { IncognitoState } from './protocol'

export default function activate(orca: OrcaWorkerApi): void {
  const incognito = createIncognito({
    rpc: createRuntimeRpc(),
    secrets: orca.secrets,
    secretsAvailable: async () =>
      (await orca.host.call('secrets.protection', {})).status === 'os-keyring',
    log: (message) => orca.log(message)
  })

  const answer = async (pending: Promise<IncognitoState>): Promise<IncognitoState> => {
    const state = await pending
    // Every open panel follows, not just the one that asked.
    orca.panels.post('state.changed', state)
    return state
  }

  orca.panels.handle('state.get', () => incognito.state())
  orca.panels.handle('passcode.set', ({ passcode, current }) =>
    answer(incognito.setPasscode(passcode, current))
  )
  orca.panels.handle('unlock', ({ passcode }) => answer(incognito.unlock(passcode)))
  orca.panels.handle('lock', () => answer(incognito.lock()))
  orca.panels.handle('project.hide', ({ id }) => answer(incognito.hideProject(id)))
  orca.panels.handle('project.forget', ({ path }) => answer(incognito.forgetProject(path)))

  let checked = false
  const relock = async (): Promise<void> => {
    if (checked) {
      return
    }
    checked = true
    try {
      if (await incognito.relockAfterRestart()) {
        orca.log('Orca restarted while unlocked: incognito projects are hidden again')
        orca.panels.post('state.changed', await incognito.state())
      }
    } catch (error) {
      checked = false
      orca.log(`relock failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  orca.events.on('workspace.changed', () => void relock())
  void relock()
}
