# Incognito Projects

Keep private projects out of Orca's sidebar until you need them: a client you can't name, a side
project, something you don't want on screen during a demo.

Open the **Incognito** panel in the right sidebar:

1. **Set a passcode** (at least 4 characters).
2. Press **Hide** next to a project, or **Hide group** to hide every project in one of Orca's
   project groups. They leave Orca at once. A group that hiding leaves empty is removed too, so
   its name doesn't show either.
3. To work on it again, enter the passcode and press **Show incognito projects**. Every incognito
   project comes back with its name, color, icon, group, hooks and other settings, and its
   workspaces with their names, comments and board status. Removed groups are created again with
   their name, color, collapsed state and order.
4. Press **Lock and hide them** when you are done. If Orca restarts while they are showing, they
   are hidden again shortly after it starts.

While locked, the panel shows only how many projects are incognito, never their names.

## How it works, and what that costs

Orca's plugin API has no way to hide a project, so this plugin **removes** the project from Orca
and **adds it back** when you unlock:

- **Files are never touched.** The project folder and its Git worktrees stay on disk. Only Orca's
  list of projects changes.
- **Hiding stops the project's terminals and agents**, as removing a project in Orca does. Finish
  or save agent work before you lock.
- Orca's own record of the project (workspace sessions, open tabs, agent chat history) is gone
  after a lock. The plugin restores the settings and workspace details listed above, not those.
- What the plugin remembers about incognito projects (their paths and settings) and the passcode
  hash live in the plugin's encrypted secrets, protected by the OS key store. On Linux without a
  key store the plugin refuses to run instead of storing them in plain text.
- The passcode is stored only as a salted scrypt hash. Five wrong tries in a row lock unlocking
  for 30 seconds.
- To add and remove projects, the worker talks to Orca's local runtime socket the same way the
  `orca` CLI does, using the token Orca writes to `orca-runtime.json` in its user-data folder. That
  protocol is internal to Orca, so an Orca update can break the plugin until it is updated.
- Only projects on this computer can be incognito, not SSH or paired-host projects.
- Hiding is not encryption: anyone with access to your account can still open the folders.
- After Orca restarts while unlocked, the projects can show for a moment before the worker locks
  them again.

## Develop

```sh
orca plugin validate .
orca plugin test .          # unit tests for the logic and the panel, no Orca needed
orca plugin dev watch .     # loads this folder into Orca; Ctrl-C unloads it
```

`src/incognito.ts` holds the logic, `src/runtime-rpc.ts` the runtime client, `src/worker.ts`
wires them to Orca and `src/panel.tsx` is the panel.

## License

MIT
