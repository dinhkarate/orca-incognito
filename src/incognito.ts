// The incognito logic, apart from the worker wiring so tests can drive it with a fake runtime.
// Orca has no "hidden project" state a plugin can set, so hiding a project removes it from
// Orca (its files and Git worktrees stay on disk) after saving everything needed to add it back:
// the project's settings and its workspaces' names, comments and board status.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import type { RuntimeRpc } from './runtime-rpc'
import type { IncognitoState, ProjectRow } from './protocol'

export type Secrets = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

type Repo = {
  id: string
  path: string
  displayName?: string
  kind?: 'git' | 'folder'
  executionHostId?: string
  connectionId?: string
  [key: string]: unknown
}

type Worktree = {
  path: string
  isMainWorktree?: boolean
  displayName?: string
  displayNameMode?: string
  comment?: string
  workspaceStatus?: string
  isPinned?: boolean
}

type WorktreeMeta = {
  path: string
  displayName?: string
  comment?: string
  workspaceStatus?: string
  isPinned?: boolean
}

type VaultEntry = {
  path: string
  kind: 'git' | 'folder'
  name: string
  /** True while the project is back in Orca (unlocked, or marked while unlocked). */
  visible: boolean
  settings: Record<string, unknown>
  worktrees: WorktreeMeta[]
  error?: string
}

type Vault = {
  unlocked: boolean
  /** The Orca runtime that was running when unlocked; a different one means Orca restarted. */
  runtimeId?: string
  projects: VaultEntry[]
}

type PasscodeRecord = { salt: string; hash: string }

// The fields `repo.update` accepts that describe how the person set the project up.
const REPO_SETTINGS = [
  'displayName',
  'badgeColor',
  'repoIcon',
  'upstream',
  'hookSettings',
  'editorFormatter',
  'worktreeBaseRef',
  'worktreeBasePath',
  'symlinkPaths',
  'dictationTerms',
  'issueSourcePreference',
  'defaultJiraProject',
  'ghAccount',
  'forkSyncMode',
  'agentWorkspaceTrust',
  'externalWorktreeVisibility',
  'externalWorktreeVisibilityPromptDismissedAt',
  'externalWorktreeInboxBaselinePaths',
  'importedExternalWorktreePaths',
  'agentWorktreeVisibility',
  'customWorktreeVisibilitySources',
  'worktreeVisibilitySourcePreferences',
  'externalWorktreeDiscoverySuppressedAt',
  'projectGroupId',
  'projectGroupOrder',
  'sourceControlAi'
] as const

// Fallback when a newer or older Orca refuses one of the fields above.
const ESSENTIAL_SETTINGS = ['displayName', 'badgeColor', 'repoIcon', 'projectGroupId', 'projectGroupOrder']

const VAULT_KEY = 'vault'
const PASSCODE_KEY = 'passcode'
const MIN_PASSCODE_LENGTH = 4
const MAX_FAILURES = 5
const BACKOFF_MS = 30_000

function scryptHash(passcode: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode, salt, 32, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key]
    }
  }
  return out
}

function isLocal(repo: Repo): boolean {
  return (!repo.executionHostId || repo.executionHostId === 'local') && !repo.connectionId
}

function repoName(repo: Repo): string {
  return repo.displayName || basename(repo.path)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type Incognito = ReturnType<typeof createIncognito>

export function createIncognito(deps: {
  rpc: RuntimeRpc
  secrets: Secrets
  secretsAvailable: () => Promise<boolean>
  log: (message: string) => void
  now?: () => number
}) {
  const { rpc, secrets, log } = deps
  const now = deps.now ?? Date.now
  let failures = 0
  let retryAt: number | undefined
  // Every action reads and writes the vault; run them one at a time.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  async function loadVault(): Promise<Vault> {
    const raw = await secrets.get(VAULT_KEY)
    return raw ? (JSON.parse(raw) as Vault) : { unlocked: false, projects: [] }
  }

  async function saveVault(vault: Vault): Promise<void> {
    await secrets.set(VAULT_KEY, JSON.stringify(vault))
  }

  async function listRepos(): Promise<Repo[]> {
    const result = await rpc.call<{ repos: Repo[] }>('repo.list', {})
    return result.repos
  }

  async function snapshot(repo: Repo): Promise<Omit<VaultEntry, 'visible'>> {
    let worktrees: Worktree[] = []
    try {
      const result = await rpc.call<{ worktrees: Worktree[] }>('worktree.list', { repo: `id:${repo.id}` })
      worktrees = result.worktrees
    } catch (error) {
      log(`could not list workspaces of a project: ${message(error)}`)
    }
    return {
      path: repo.path,
      kind: repo.kind === 'folder' ? 'folder' : 'git',
      name: repoName(repo),
      settings: pick(repo, REPO_SETTINGS),
      worktrees: worktrees
        .filter((w) => !w.isMainWorktree)
        .map((w) => ({
          path: w.path,
          displayName: w.displayNameMode === 'fixed' ? w.displayName : undefined,
          comment: w.comment || undefined,
          workspaceStatus: w.workspaceStatus,
          isPinned: w.isPinned || undefined
        }))
    }
  }

  /** Saves the project to the vault first, then removes it, so a failure never loses it. */
  async function hide(vault: Vault, repo: Repo): Promise<void> {
    const entry: VaultEntry = { ...(await snapshot(repo)), visible: false }
    vault.projects = [...vault.projects.filter((p) => p.path !== repo.path), entry]
    await saveVault(vault)
    try {
      await rpc.call('repo.rm', { repo: `id:${repo.id}` })
    } catch (error) {
      entry.visible = true
      entry.error = `Could not hide: ${message(error)}`
      await saveVault(vault)
    }
  }

  async function restore(entry: VaultEntry, repos: Repo[]): Promise<void> {
    let id = repos.find((r) => r.path === entry.path)?.id
    try {
      if (!id) {
        const added = await rpc.call<{ repo: Repo }>('repo.add', {
          path: entry.path,
          kind: entry.kind,
          displayName: entry.settings.displayName
        })
        id = added.repo.id
      }
    } catch (error) {
      entry.error = `Could not show: ${message(error)}`
      return
    }
    // Orca forgets which worktrees it made when a project is removed and would hide them as
    // external ones; importing their paths brings them back.
    const imported = new Set([
      ...((entry.settings.importedExternalWorktreePaths as string[] | undefined) ?? []),
      ...entry.worktrees.map((w) => w.path)
    ])
    const updates = { ...entry.settings, importedExternalWorktreePaths: [...imported] }
    try {
      await rpc.call('repo.update', { repo: `id:${id}`, updates })
    } catch (error) {
      log(`full settings restore refused (${message(error)}); restoring the essentials`)
      await rpc
        .call('repo.update', {
          repo: `id:${id}`,
          updates: { ...pick(entry.settings, ESSENTIAL_SETTINGS), importedExternalWorktreePaths: [...imported] }
        })
        .catch((e: unknown) => log(`settings restore failed: ${message(e)}`))
    }
    for (const { path, ...meta } of entry.worktrees) {
      const fields = pick(meta, ['displayName', 'comment', 'workspaceStatus', 'isPinned'])
      if (Object.keys(fields).length === 0) {
        continue
      }
      await rpc
        .call('worktree.set', { worktree: `path:${path}`, ...fields })
        .catch((e: unknown) => log(`workspace restore failed: ${message(e)}`))
    }
    entry.visible = true
    delete entry.error
  }

  async function lockVault(vault: Vault): Promise<void> {
    const repos = await listRepos()
    for (const entry of vault.projects) {
      if (!entry.visible) {
        continue
      }
      const repo = repos.find((r) => r.path === entry.path)
      if (repo) {
        // Snapshot again so changes made while it was showing are kept.
        await hide(vault, repo)
      } else {
        entry.visible = false
      }
    }
    vault.unlocked = false
    delete vault.runtimeId
    await saveVault(vault)
  }

  async function verify(passcode: string): Promise<boolean> {
    const raw = await secrets.get(PASSCODE_KEY)
    if (!raw) {
      return false
    }
    const record = JSON.parse(raw) as PasscodeRecord
    const expected = Buffer.from(record.hash, 'base64')
    const actual = await scryptHash(passcode, Buffer.from(record.salt, 'base64'))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async function state(error?: string): Promise<IncognitoState> {
    const available = await deps.secretsAvailable()
    const vault = available ? await loadVault() : { unlocked: false, projects: [] as VaultEntry[] }
    const incognitoPaths = new Set(vault.projects.map((p) => p.path))
    let projects: ProjectRow[] = []
    try {
      projects = (await listRepos())
        .filter((r) => isLocal(r) && !incognitoPaths.has(r.path))
        .map((r) => ({ id: r.id, name: repoName(r), path: r.path }))
    } catch (e) {
      error ??= `Cannot reach Orca: ${message(e)}`
    }
    return {
      available,
      hasPasscode: available && (await secrets.get(PASSCODE_KEY)) !== null,
      unlocked: vault.unlocked,
      incognitoCount: vault.projects.length,
      projects,
      incognito: vault.unlocked
        ? vault.projects.map((p) => ({ path: p.path, name: p.name, ...(p.error ? { error: p.error } : {}) }))
        : [],
      ...(retryAt && retryAt > now() ? { retryAt } : {}),
      ...(error ? { error } : {})
    }
  }

  /** Runs an action and answers the new state, with the action's error instead of throwing. */
  const act = (task: () => Promise<string | void>): Promise<IncognitoState> =>
    serial(async () => {
      try {
        return await state((await task()) || undefined)
      } catch (error) {
        log(message(error))
        return await state(message(error))
      }
    })

  return {
    state: () => serial(() => state()),

    setPasscode: (passcode: string, current?: string) =>
      act(async () => {
        if (passcode.length < MIN_PASSCODE_LENGTH) {
          return `Use at least ${MIN_PASSCODE_LENGTH} characters.`
        }
        if ((await secrets.get(PASSCODE_KEY)) !== null && !(await verify(current ?? ''))) {
          return 'The current passcode is wrong.'
        }
        const salt = randomBytes(16)
        const hash = await scryptHash(passcode, salt)
        const record: PasscodeRecord = { salt: salt.toString('base64'), hash: hash.toString('base64') }
        await secrets.set(PASSCODE_KEY, JSON.stringify(record))
      }),

    unlock: (passcode: string) =>
      act(async () => {
        if (retryAt && retryAt > now()) {
          return 'Too many attempts. Wait and try again.'
        }
        if (!(await verify(passcode))) {
          failures += 1
          if (failures >= MAX_FAILURES) {
            failures = 0
            retryAt = now() + BACKOFF_MS
          }
          return 'Wrong passcode.'
        }
        failures = 0
        retryAt = undefined
        const vault = await loadVault()
        const repos = await listRepos()
        for (const entry of vault.projects) {
          if (!entry.visible) {
            await restore(entry, repos)
          }
        }
        vault.unlocked = true
        vault.runtimeId = await rpc.runtimeId()
        await saveVault(vault)
      }),

    lock: () => act(async () => lockVault(await loadVault())),

    hideProject: (id: string) =>
      act(async () => {
        if ((await secrets.get(PASSCODE_KEY)) === null) {
          return 'Set a passcode first.'
        }
        const repo = (await listRepos()).find((r) => r.id === id)
        if (!repo) {
          return 'That project is no longer in Orca.'
        }
        if (!isLocal(repo)) {
          return 'Only projects on this computer can be incognito.'
        }
        const vault = await loadVault()
        if (vault.unlocked) {
          // Like the other incognito projects, it stays until the next lock.
          const entry: VaultEntry = { ...(await snapshot(repo)), visible: true }
          vault.projects = [...vault.projects.filter((p) => p.path !== repo.path), entry]
          await saveVault(vault)
        } else {
          await hide(vault, repo)
        }
      }),

    forgetProject: (path: string) =>
      act(async () => {
        const vault = await loadVault()
        if (!vault.unlocked) {
          return 'Unlock first.'
        }
        const entry = vault.projects.find((p) => p.path === path)
        if (entry && !entry.visible) {
          await restore(entry, await listRepos())
        }
        vault.projects = vault.projects.filter((p) => p.path !== path)
        await saveVault(vault)
      }),

    /** Locks again when Orca restarted while unlocked. */
    relockAfterRestart: () =>
      serial(async () => {
        if (!(await deps.secretsAvailable())) {
          return false
        }
        const vault = await loadVault()
        if (!vault.unlocked || vault.runtimeId === (await rpc.runtimeId())) {
          return false
        }
        await lockVault(vault)
        return true
      })
  }
}
