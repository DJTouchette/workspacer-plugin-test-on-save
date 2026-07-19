#!/usr/bin/env node
// Generic workspacer plugin sidecar scaffold — zero dependencies.
// Node >= 22 (global WebSocket) and >= 18 (global fetch). Reads its own
// plugin.json for the bus topics it subscribes to and the capabilities it may
// call, connects to the hub bus, logs events, and serves a tiny status pane.
// Implement your logic in onEvent(). See README for events + capabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// The workspacer plugin SDK (vendored wks.js): connect to the hub bus (scoped
// token, auto-subscribe, reconnect loop) and expose ready/on/call/publish/settings.
const wks = connect({ source: manifest.id });
const settings = wks.settings;

const TOPICS = manifest.consumes || [];
const recent = [];

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// ── test-on-save logic ────────────────────────────────────────────────────────
//
// Flow: learn each live agent's cwd from `agent.state_changed` (and
// `agent.snapshot`), watch that working tree, and when a source file under it
// changes, debounce per-cwd then run `settings.testCommand` in the cwd. On a
// non-zero exit we push the failing tail back to the owning agent with
// `agents.sendMessage` and raise an OS notification via `notifications.post`.
//
// Watching is done LOCALLY with node's recursive fs.watch: the sidecar runs on
// the same host as the workspace, and the hub's `fs.watch` capability is
// pane-scoped (its ${agentCwd} grant only resolves for webview pane tokens), so
// a sidecar calling it gets "filesystem-scoped capability granted with no
// roots". Bus `fs.changed` events are still honoured as an extra trigger source.

const TEST_COMMAND = (settings.testCommand && String(settings.testCommand)) || 'npm test';
const DEBOUNCE_MS = Number.isFinite(Number(settings.debounceMs)) ? Number(settings.debounceMs) : 1500;
const RUN_TIMEOUT_MS = 10 * 60 * 1000; // hard cap so a hung test run can't wedge a cwd
const TAIL_CHARS = 4000; // how much failing output we feed back to the agent

// Directories we never watch or run inside — build artefacts / VCS / deps.
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', 'build', '.next', '.turbo',
  'coverage', 'vendor', '.venv', '__pycache__', '.pytest_cache', 'out',
]);
// Extensions we treat as source. A path with no extension (a directory event,
// which is what a non-recursive dir watch reports) always qualifies.
const SOURCE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'cts', 'mts', 'py', 'go', 'rs', 'rb',
  'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php', 'swift',
  'm', 'mm', 'scala', 'ex', 'exs', 'erl', 'clj', 'cljs', 'vue', 'svelte', 'json',
  'toml', 'yaml', 'yml', 'gradle', 'rake',
]);

const cwdToSession = new Map(); // resolved root cwd → owning sessionId
const rootWatchers = new Map(); // root cwd → fs.FSWatcher (recursive)
const debounceTimers = new Map(); // root cwd → pending run timer
const running = new Set();       // root cwds with a test run in flight
const rerun = new Set();         // root cwds that changed again mid-run
const lastResult = new Map();    // root cwd → short human status (for the pane)

function isIgnoredPath(p) {
  return p.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg));
}
function looksLikeSource(p) {
  const base = path.basename(p);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true; // extensionless (e.g. a directory-level watch event)
  return SOURCE_EXT.has(base.slice(dot + 1).toLowerCase());
}

// Learn (or refresh) an agent's cwd → session mapping and begin watching its
// tree with one recursive local watcher per root.
async function learnAgent(sessionId, cwd) {
  if (!sessionId || !cwd || typeof cwd !== 'string') return;
  const root = path.resolve(cwd);
  cwdToSession.set(root, sessionId);
  if (rootWatchers.has(root)) return;
  try {
    const w = fs.watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const p = path.join(root, String(filename));
      if (isIgnoredPath(p) || !looksLikeSource(p)) return;
      scheduleRun(root);
    });
    w.on('error', (e) => {
      log('watcher error for ' + root + ': ' + e.message);
      try { w.close(); } catch {}
      rootWatchers.delete(root); // a later event re-arms it
    });
    rootWatchers.set(root, w);
    log('watching ' + root + ' (recursive) for session ' + sessionId);
  } catch (e) {
    log('fs.watch failed for ' + root + ': ' + e.message);
  }
}

function unwatchRoot(root) {
  const w = rootWatchers.get(root);
  if (w) { try { w.close(); } catch {} rootWatchers.delete(root); }
}

// Which known root cwd owns this changed path? Longest-prefix wins.
function ownerCwd(changedPath) {
  const p = path.resolve(changedPath);
  let best = null;
  for (const root of cwdToSession.keys()) {
    if (p === root || p.startsWith(root + path.sep)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

function scheduleRun(root) {
  const existing = debounceTimers.get(root);
  if (existing) clearTimeout(existing);
  debounceTimers.set(root, setTimeout(() => {
    debounceTimers.delete(root);
    runTests(root);
  }, DEBOUNCE_MS));
}

function runTests(root) {
  if (running.has(root)) { rerun.add(root); return; } // coalesce; re-run after
  running.add(root);
  lastResult.set(root, 'running… (' + new Date().toISOString() + ')');
  log('running `' + TEST_COMMAND + '` in ' + root);
  exec(TEST_COMMAND, {
    cwd: root,
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  }, (err, stdout, stderr) => {
    running.delete(root);
    const failed = !!err;
    if (!failed) {
      lastResult.set(root, 'passed ✔ (' + new Date().toISOString() + ')');
      log('tests passed in ' + root);
    } else {
      const code = err.killed ? 'timeout/killed' : (err.code != null ? err.code : 'error');
      lastResult.set(root, 'FAILED (exit ' + code + ') ' + new Date().toISOString());
      log('tests FAILED (exit ' + code + ') in ' + root);
      reportFailure(root, code, stdout || '', stderr || '');
    }
    if (rerun.delete(root)) scheduleRun(root); // a change landed while we ran
  });
}

async function reportFailure(root, code, stdout, stderr) {
  const combined = (stdout + (stdout && stderr ? '\n' : '') + stderr).trimEnd();
  const tail = combined.length > TAIL_CHARS ? '…\n' + combined.slice(-TAIL_CHARS) : combined;
  const sessionId = cwdToSession.get(root);
  const text =
    '[test-on-save] `' + TEST_COMMAND + '` failed (exit ' + code + ') in ' + root + '.\n' +
    'Please fix the failing tests. Output tail:\n\n' + (tail || '(no output captured)');
  if (sessionId) {
    try {
      await wks.call('agents.sendMessage', { sessionId, text });
      log('sent failure to session ' + sessionId);
    } catch (e) {
      // Agent may not be at an input prompt (busy/dialog/ended) — that's fine,
      // the notification below still surfaces the failure.
      log('agents.sendMessage failed for ' + sessionId + ': ' + e.message);
    }
  } else {
    log('no session mapped for ' + root + '; skipping sendMessage');
  }
  try {
    await wks.call('notifications.post', {
      title: 'Tests failed',
      body: TEST_COMMAND + ' — ' + path.basename(root) + ' (exit ' + code + ')',
    });
  } catch (e) {
    log('notifications.post failed: ' + e.message);
  }
}

async function onEvent(event) {
  const t = event.type;
  const d = event.data || {};
  if (t === 'agent.state_changed' || t === 'agent.snapshot') {
    // Discover / refresh live agents' cwds so we know where to watch + who to
    // notify. `agent.state_changed` carries { sessionId, hookEvent, mode, cwd };
    // `agent.snapshot` (if the host emits it) is a per-session snapshot.
    await learnAgent(d.sessionId, d.cwd);
    // Drop the mapping + watcher when a session ends so stale cwds don't get
    // messaged or keep a watcher alive.
    if (d.sessionId && d.cwd && /^SessionEnd/i.test(String(d.hookEvent || ''))) {
      const root = path.resolve(d.cwd);
      if (cwdToSession.get(root) === d.sessionId) {
        cwdToSession.delete(root);
        unwatchRoot(root);
      }
    }
    return;
  }
  if (t === 'fs.changed') {
    const changed = d.path;
    if (!changed || isIgnoredPath(changed) || !looksLikeSource(changed)) return;
    const root = ownerCwd(changed);
    if (!root) return; // change outside any agent tree we're tracking
    scheduleRun(root);
    return;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (wks.connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.75rem">command <code>'
    + escapeHtml(TEST_COMMAND) + '</code> · debounce ' + DEBOUNCE_MS + 'ms · watching '
    + rootWatchers.size + ' of ' + cwdToSession.size + ' agent tree(s)</p>'
    + '<pre style="font-size:.72rem;color:var(--wks-text-secondary,#bbb);white-space:pre-wrap">'
    + (Array.from(cwdToSession.entries())
        .map(([c, s]) => escapeHtml(path.basename(c) + '  [' + s + ']  ' + (lastResult.get(c) || 'idle')))
        .join('\n') || 'no agents discovered yet…') + '</pre>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>');
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));

// Route each consumed bus event to onEvent (the SDK subscribes to '*'; we
// dispatch only the topics this plugin declares in plugin.json `consumes`).
for (const t of TOPICS) wks.on(t, (_data, ev) => { onEvent(ev).catch((e) => log('onEvent error: ' + e.message)); });
wks.ready.then(() => log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)')));
