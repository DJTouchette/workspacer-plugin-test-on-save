# Test on Save

Run the test suite when an agent edits code; feed results back.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

Watches each live agent's working tree (`fs.watch` → `fs.changed`), debounces
per-cwd, runs your test command in that cwd, and — when it exits non-zero —
`agents.sendMessage`s the failing output tail back to the agent that owns the
tree (plus an OS notification) so the agent can self-correct.

Concretely:

1. **Discover cwds.** `fs.changed` carries only `{ path, eventType }` — no
   session — so the plugin learns which agent owns which directory from
   `agent.state_changed` (and `agent.snapshot`), which carry `{ sessionId, cwd }`.
   This required **adding `agent.state_changed` + `agent.snapshot` to the manifest
   `consumes`** (a plugin can only subscribe to what it declares).
2. **Watch the tree.** On learning a cwd it enumerates the directory tree
   (skipping `node_modules`/`.git`/`dist`/`target`/`build`/… , bounded depth/count)
   and calls `fs.watch({ path })` on each directory — the host watcher is
   non-recursive, so one watch per directory is how nested source files get
   covered. The sidecar runs on the workspace host, so it reads the tree directly.
3. **Debounce + run.** On a `fs.changed` for a source path (ignored build/dep
   dirs are dropped) it debounces per-cwd for `debounceMs`, then runs
   `testCommand` via `child_process.exec` in that cwd. Overlapping runs are
   coalesced (a change during a run re-runs afterwards).
4. **Report failures.** Non-zero exit → `agents.sendMessage({ sessionId, text })`
   with the last ~4 KB of output to the owning agent, and `notifications.post`.
   The session mapping is dropped on `SessionEnd` so stale cwds aren't messaged.

## Bus wiring

- **Subscribes to:** `fs.changed`, `agent.state_changed`, `agent.snapshot`
  (the last two were **added to the manifest** to discover live agents' cwds →
  sessionIds; without them there is no way to map a file change back to an agent).
- **Calls capabilities:** `fs.watch` (`{ path }`), `agents.sendMessage`
  (`{ sessionId, text }`), `notifications.post` (`{ title, body }`), and
  `search.project` (declared/scoped to `${agentCwd}`; reserved for future
  "does this tree even have tests?" pre-flight — not currently invoked).
- **Emits:** —
- **Settings:**
- `testCommand` (string, default `npm test`) — Command run on change, in the cwd.
- `debounceMs` (number, default `1500`) — Wait this long after the last change
  before running.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/test-on-save/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-test-on-save`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Test on Save** pane from the command palette.

## Implement

The behavior above lives in `server.js` → `onEvent(event)` and its helpers:
`learnAgent`/`ownerCwd` (cwd↔session mapping + tree watching), `scheduleRun`
(per-cwd debounce), and `runTests`/`reportFailure` (exec + feedback). Subscribed
topics arrive in `onEvent`; capability calls go through `call('method', params)`.
`settings` holds the host-injected `testCommand` / `debounceMs`.

## Layout

```
test-on-save/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
