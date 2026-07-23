# Test on Save

Run the test suite when an agent edits code; feed results back.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). Implemented and exercised end-to-end against a headless workspacer hub.

## What it does

Watches each live agent's working tree (a local recursive `fs.watch`), debounces
per-cwd, runs your test command in that cwd, and — when it exits non-zero —
`agents.sendMessage`s the failing output tail back to the agent that owns the
tree (plus an OS notification) so the agent can self-correct.

Concretely:

1. **Discover cwds.** The plugin learns which agent owns which directory from
   `agent.state_changed` (and `agent.snapshot`), which carry `{ sessionId, cwd }`.
   This required **adding `agent.state_changed` + `agent.snapshot` to the manifest
   `consumes`** (a plugin can only subscribe to what it declares).
2. **Watch the tree.** On learning a cwd it starts one recursive node
   `fs.watch` on the root. Watching is local because the sidecar runs on the
   same host as the workspace — and the hub's `fs.watch` capability is
   pane-scoped: its `${agentCwd}` grant only resolves for webview pane tokens,
   so a sidecar calling it is denied ("filesystem-scoped capability granted
   with no roots"). Changes under ignored dirs (`node_modules`/`.git`/`dist`/
   `target`/`build`/…) or to non-source extensions are dropped. Bus
   `fs.changed` events are still honoured as an extra trigger source.
3. **Debounce + run.** On a source-path change it debounces per-cwd for
   `debounceMs`, then runs `testCommand` via `child_process.exec` in that cwd.
   Overlapping runs are coalesced (a change during a run re-runs afterwards).
4. **Report failures.** Non-zero exit → `agents.sendMessage({ sessionId, text })`
   with the last ~4 KB of output to the owning agent, plus a `notify.post` event
   (see below). The mapping + watcher are dropped on `SessionEnd` so stale cwds
   aren't messaged.

## Notifications (v1.1)

The plugin feeds the in-app notification center via the lightweight
**`notify.post` event** (fire-and-forget; toast + bell in-app, escalating to an
OS notification only when the workspacer window is unfocused — deliberately the
low-noise path, since this plugin can fire on every save):

- **Suite fails** → a `level: 'error'` entry with the fail count and the first
  failing line from the output, tagged with the owning agent's `sessionId`
  (clicking it focuses that agent) and `key: test-on-save:<cwd>` — a repeated
  failure in the same project **replaces** the previous entry (one slot per
  project, never a stack).
- **Suite passes after having failed** → a `level: 'success'` entry with the
  **same key**, replacing the red entry. Passing runs with no prior failure post
  nothing.

Turn it off with the **`notify`** setting (boolean, default `true`).

## Bus wiring

- **Subscribes to:** `fs.changed`, `agent.state_changed`, `agent.snapshot`
  (the last two were **added to the manifest** to discover live agents' cwds →
  sessionIds; without them there is no way to map a file change back to an agent).
- **Calls capabilities:** `agents.sendMessage` (`{ sessionId, text }`).
- **Emits:** `notify.post` (fail/recover updates for the in-app notification
  center).
- **Settings:**
- `testCommand` (string, default `npm test`) — Command run on change, in the cwd.
- `debounceMs` (number, default `1500`) — Wait this long after the last change
  before running.
- `notify` (boolean, default `true`) — Post fail/recover updates to the
  notification center.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/test-on-save/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-test-on-save`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Test on Save** pane from the command palette.

## Implement

The behavior above lives in `server.js` → `onEvent(event)` and its helpers:
`learnAgent`/`unwatchRoot`/`ownerCwd` (cwd↔session mapping + local recursive
watching), `scheduleRun` (per-cwd debounce), and `runTests`/`reportFailure`
(exec + feedback). Subscribed topics arrive in `onEvent`; capability calls go
through `call('method', params)`. `settings` holds the host-injected
`testCommand` / `debounceMs` (delivered as `WKS_SETTINGS`; the hub restarts the
sidecar when they change).

## Layout

```
test-on-save/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
