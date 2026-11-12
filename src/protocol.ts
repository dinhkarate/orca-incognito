// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export type ProjectRow = { id: string; name: string; path: string; groupId?: string; group?: string }

export type GroupRow = { id: string; name: string }

export type IncognitoRow = { path: string; name: string; group?: string; error?: string }

export type IncognitoState = {
  /** False when the OS has no key store for the plugin's secrets (Linux basic_text). */
  available: boolean
  hasPasscode: boolean
  unlocked: boolean
  /** How many projects are incognito; the only thing shown about them while locked. */
  incognitoCount: number
  /** Local projects in Orca that are not incognito. */
  projects: ProjectRow[]
  /** Orca's project groups, in sidebar order. */
  groups: GroupRow[]
  /** Incognito projects; empty while locked. */
  incognito: IncognitoRow[]
  /** Set after too many wrong passcodes. */
  retryAt?: number
  /** Why the last action failed, if it did. */
  error?: string
}

declare module 'orca' {
  interface PluginRequests {
    'state.get': { output: IncognitoState }
    'passcode.set': { input: { passcode: string; current?: string }; output: IncognitoState }
    unlock: { input: { passcode: string }; output: IncognitoState }
    lock: { output: IncognitoState }
    /** Makes a project incognito; while locked it leaves Orca at once. */
    'project.hide': { input: { id: string }; output: IncognitoState }
    /** Makes every project of a group incognito; a group left empty leaves Orca too. */
    'group.hide': { input: { groupId: string }; output: IncognitoState }
    /** Stops treating a project as incognito; only while unlocked. */
    'project.forget': { input: { path: string }; output: IncognitoState }
  }
  interface PluginPanelEvents {
    'state.changed': IncognitoState
  }
}
