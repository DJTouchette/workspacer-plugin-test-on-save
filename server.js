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

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// The hub injects the bus URL + this plugin's scoped token. Accept the common
// conventions so the scaffold runs however your hub wires it.
const BUS_URL = process.env.WKS_BUS_URL || 'ws://127.0.0.1:7895/bus';
function readToken() {
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try { return fs.readFileSync(path.join(DIR, '.bus-token'), 'utf8').trim(); } catch { return ''; }
}
// Host-injected settings (from manifest `settings`), passed as JSON in env.
let settings = {};
try { settings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}

const TOPICS = manifest.consumes || [];
const recent = [];
let ws = null, connected = false, callSeq = 0;
const pending = new Map();

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Call a hub capability (must be declared in plugin.json `capabilities`).
function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error('not connected'));
    const id = 'c' + (++callSeq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 'call', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 8000);
  });
}
// Publish an event/command (must be declared in `emits`).
function publish(type, data) {
  if (connected) ws.send(JSON.stringify({ op: 'publish', event: { type, source: manifest.id, data: data || {} } }));
}

function connect() {
  const tok = readToken();
  ws = new WebSocket(BUS_URL + (tok ? '?token=' + encodeURIComponent(tok) : ''));
  ws.addEventListener('open', () => {
    connected = true;
    if (TOPICS.length) ws.send(JSON.stringify({ op: 'subscribe', topics: TOPICS }));
    log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)'));
  });
  ws.addEventListener('message', (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.op === 'event' && f.event) onEvent(f.event).catch((e) => log('onEvent error: ' + e.message));
    else if (f.op === 'result' && pending.has(f.id)) { pending.get(f.id).resolve(f.result); pending.delete(f.id); }
    else if (f.op === 'error' && pending.has(f.id)) { pending.get(f.id).reject(new Error(f.error)); pending.delete(f.id); }
  });
  ws.addEventListener('close', () => { connected = false; setTimeout(connect, 1500); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

// ── test-on-save logic ────────────────────────────────────────────────────────
//
// Flow: learn each live agent's cwd from `agent.state_changed` (and
// `agent.snapshot`), watch that working tree via `fs.watch`, and when a source
// file under it changes, debounce per-cwd then run `settings.testCommand` in the
// cwd. On a non-zero exit we push the failing tail back to the owning agent with
// `agents.sendMessage` and raise an OS notification via `notifications.post`.

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
const rootWatched = new Set();  // root cwds we've expanded + started watching
const watchedDirs = new Set();  // every dir we've asked the host to fs.watch
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

// Enumerate directories under `root` (bounded), skipping ignored ones, so we can
// watch the whole tree — the host's fs.watch is non-recursive, so one watch per
// directory is how we get coverage of nested source files. The sidecar runs on
// the same host as the workspace, so reading the tree directly is safe.
function collectDirs(root, depth, out, budget) {
  if (out.length >= budget) return;
  out.push(root);
  if (depth <= 0) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    collectDirs(path.join(root, e.name), depth - 1, out, budget);
    if (out.length >= budget) return;
  }
}

async function watchDir(dir) {
  if (watchedDirs.has(dir)) return;
  watchedDirs.add(dir);
  try {
    // Runtime param is { path } (singular); the manifest's paths:["${agentCwd}"]
    // form is the authorization scope. Confirmed via hubCapabilities.ts + the
    // desktop web backend's own client.call('fs.watch', { path }).
    await call('fs.watch', { path: dir });
  } catch (e) {
    watchedDirs.delete(dir); // let a later event retry
    log('fs.watch failed for ' + dir + ': ' + e.message);
  }
}

// Learn (or refresh) an agent's cwd → session mapping and begin watching its tree.
async function learnAgent(sessionId, cwd) {
  if (!sessionId || !cwd || typeof cwd !== 'string') return;
  const root = path.resolve(cwd);
  cwdToSession.set(root, sessionId);
  if (rootWatched.has(root)) return;
  rootWatched.add(root);
  const dirs = [];
  collectDirs(root, 6, dirs, 800);
  log('watching ' + dirs.length + ' dir(s) under ' + root + ' for session ' + sessionId);
  for (const d of dirs) await watchDir(d);
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
      await call('agents.sendMessage', { sessionId, text });
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
    await call('notifications.post', {
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
    // Drop the mapping when a session ends so stale cwds don't get messaged.
    if (d.sessionId && d.cwd && /^SessionEnd/i.test(String(d.hookEvent || ''))) {
      const root = path.resolve(d.cwd);
      if (cwdToSession.get(root) === d.sessionId) cwdToSession.delete(root);
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
    + (connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.75rem">command <code>'
    + escapeHtml(TEST_COMMAND) + '</code> · debounce ' + DEBOUNCE_MS + 'ms · watching '
    + watchedDirs.size + ' dir(s) across ' + cwdToSession.size + ' agent tree(s)</p>'
    + '<pre style="font-size:.72rem;color:var(--wks-text-secondary,#bbb);white-space:pre-wrap">'
    + (Array.from(cwdToSession.entries())
        .map(([c, s]) => escapeHtml(path.basename(c) + '  [' + s + ']  ' + (lastResult.get(c) || 'idle')))
        .join('\n') || 'no agents discovered yet…') + '</pre>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>');
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
connect();
