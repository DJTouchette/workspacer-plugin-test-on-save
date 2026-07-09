# Test on Save

Run the test suite when an agent edits code; feed results back.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

Watches the agent's working tree (`fs.watch` → `fs.changed`), debounces, runs your test command, and `agents.sendMessage`s failures back to the agent so it self-corrects.

## Bus wiring

- **Subscribes to:** `fs.changed`
- **Calls capabilities:** `fs.watch`, `search.project`, `agents.sendMessage`, `notifications.post`
- **Emits:** —
- **Settings:**
- `testCommand` (string) — Command run on change.
- `debounceMs` (number) — Wait this long after the last change before running.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/test-on-save/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-test-on-save`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Test on Save** pane from the command palette.

## Implement

Edit `server.js` → `onEvent(event)`. Subscribed topics arrive there; use `call('method', params)` for capabilities and `publish('command.x', data)` for commands. `settings` holds the host-injected config above.

## Layout

```
test-on-save/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
