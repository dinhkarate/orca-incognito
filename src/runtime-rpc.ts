// Talks to the Orca runtime the way the `orca` CLI does: one JSON line per request over the
// local socket (a named pipe on Windows), authenticated with the token Orca writes to
// orca-runtime.json. The plugin host API has no way to remove or add projects, so this is the
// only route; it is internal to Orca and may change between releases.
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type RuntimeRpc = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  runtimeId(): Promise<string>
}

type RuntimeMetadata = {
  runtimeId: string
  authToken: string
  transports: { kind: string; endpoint: string }[]
}

const TIMEOUT_MS = 60_000

/** Same lookup as the CLI's getDefaultUserDataPath. */
export function userDataPath(): string {
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'orca')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'orca')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca')
}

async function readMetadata(): Promise<RuntimeMetadata> {
  const raw = await readFile(join(userDataPath(), 'orca-runtime.json'), 'utf8')
  const metadata = JSON.parse(raw) as RuntimeMetadata
  if (!metadata.authToken || !Array.isArray(metadata.transports)) {
    throw new Error('Orca runtime metadata is incomplete.')
  }
  return metadata
}

function send<T>(metadata: RuntimeMetadata, method: string, params: unknown): Promise<T> {
  const transport = metadata.transports.find((t) => t.kind === 'unix' || t.kind === 'named-pipe')
  if (!transport) {
    return Promise.reject(new Error('Orca runtime has no local socket.'))
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(transport.endpoint)
    let buffer = ''
    let settled = false
    const finish = (error: Error | null, value?: T): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(value as T)
      }
    }
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('Orca closed the connection before responding.')))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) {
          continue
        }
        let frame: { _keepalive?: unknown; id?: string; ok?: boolean; result?: T; error?: { message?: string } }
        try {
          frame = JSON.parse(line)
        } catch {
          finish(new Error('Orca returned an invalid response.'))
          return
        }
        if (frame._keepalive) {
          timer.refresh()
          continue
        }
        if (frame.id !== id) {
          continue
        }
        if (frame.ok) {
          finish(null, frame.result)
        } else {
          finish(new Error(frame.error?.message ?? `${method} failed`))
        }
      }
    })
  })
}

export function createRuntimeRpc(): RuntimeRpc {
  return {
    // Read the metadata on every call: Orca rewrites it (new socket, new token) on restart.
    call: async (method, params) => send(await readMetadata(), method, params),
    runtimeId: async () => (await readMetadata()).runtimeId
  }
}
