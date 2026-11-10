// pluginless-health tests (fix/pluginless-health-loop, v2 contract / brief appendix B)
//
// Incident (2026-11-10): in a fresh, empty DSH_HOME the daemon restarted a
// perfectly alive `dsh web` forever and popped one browser tab per generation.
// `/health` is registered BY THIS PLUGIN (ctx.webServer.register('/health')), so
// in a profile where the plugin is not active the port answers 404 forever. The
// watchdog counted that as "unhealthy", walked to FAIL_THRESHOLD, relaunched
// (= new generation = new token = one more tab), and status only ever said
// "still starting" / "unhealthy" — the real cause was invisible.
//
// v2 lesson: a /health 404 alone proves NOTHING (it is our own route). Liveness
// now needs POSITIVE evidence from a CORE asset — GET /manifest.webmanifest is
// served by @deepseek-ai/dsh-host-frontend-static with no cookie (no plugin
// involved), and the core auth fence answers / with 401. So the watchdog asks
// that, and only then concludes "dsh web is alive, our plugin is missing".
//
// Three cases against the REAL generated watchdog plus a fake `dsh web` whose
// per-path status codes are chosen by the case:
//
//   G  /manifest.webmanifest 200 + /health 404  => dsh web alive, plugin absent.
//      Exactly ONE generation (a restart cannot load a missing plugin), the
//      give-up state is written, and BOTH status paths say what is wrong.
//      The unfixed build restarts 4x in the same window, one tab per
//      generation, so G is the regression gate.
//   H  /manifest.webmanifest 200 + /health 503  => a REAL fault (plugin serving
//      but broken). The restart policy must survive the fix: >=2 starts in the
//      same window and no give-up state.
//   I  /manifest.webmanifest 404 + / 404 + /health 404 (a non-dsh process holds
//      the port) => dsh web is NOT serving, so it MUST still restart (>=2
//      starts) and must never be classified as pluginless. I guards the
//      dangerous direction of this change: an over-wide liveness criterion
//      would wedge the watchdog into never restarting again.
//
// The plugin is loaded in DYNAMIC SANDBOX mode (`new Function('ctx','harness',
// src)`), never `require('lib/index.js')`: the static path pulls
// @deepseek-ai/dsh-tools through the committed package-lock.json, whose
// `link: true` entry is machine-local and dangles in CI. Same loader as
// test/logs-command.test.js — this file must run with no node_modules at all.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-pluginless-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const logDir = path.join(daemonDir, 'logs');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const watchdogLog = path.join(logDir, 'watchdog.log');
const webMarker = path.join(tmp, 'fake-web.events');
const openMarker = path.join(tmp, 'browser-opens.log');
const pluginlessState = path.join(daemonDir, '.daemon-pluginless');
const PORT = 3094;
// The brief's window: long enough that "it stopped restarting" is a real
// statement and not "the next restart has not come around yet" (on the broken
// build the restart period is ~17s).
const OBSERVE_MS = 60000;
// A binding anchor (the give-up line, or the 2nd start) lands in <=20s, so this
// only ever times out on a build that behaves in neither direction.
const ANCHOR_WAIT_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Debug/verification knob: `PLUGINLESS_CASES=I node test/pluginless-health.test.js`
// runs a subset (used to prove case I discriminates a too-wide liveness probe).
const CASES = String(process.env.PLUGINLESS_CASES || 'G,H,I')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (name) => CASES.indexOf(name) >= 0;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [ok]   ' + name); return; }
  failures += 1;
  console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  -> ' + extra));
}
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > until) return false; await sleep(100); }
}
// Last few non-empty lines, for failure messages.
function brief(s, n = 6) {
  return String(s || '').trim().split('\n').filter(Boolean).slice(-n).join(' | ');
}
const daemonFile = (name) => path.join(daemonDir, name);
function readDaemon(name) { try { return fs.readFileSync(daemonFile(name), 'utf8'); } catch (e) { return ''; } }
function pidFromFile(name) { return Number(readDaemon(name).trim()) || 0; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
function webEvents() {
  try { return fs.readFileSync(webMarker, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; }
}
function starts() { return webEvents().filter((l) => l.startsWith('start ')); }
function opens() {
  try { return fs.readFileSync(openMarker, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; }
}
function logText() { try { return fs.readFileSync(watchdogLog, 'utf8'); } catch (e) { return ''; } }
function watchdogPids() {
  const out = [];
  const re = /watchdog started \(PID (\d+)/g;
  const text = logText();
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(Number(m[1]));
  return out;
}
function readPluginless() {
  try { return JSON.parse(fs.readFileSync(pluginlessState, 'utf8')); } catch (e) { return null; }
}
// The `Web server:` verdict lines of a status output. Both the "no `still
// starting`" and the "says the pluginless verdict" assertions have to look at
// THESE lines only: the plugin-side dsh_daemon_status also echoes the last
// watchdog log lines, and a legitimate pre-grace line ("dsh web still starting
// (4s of 8s grace, PID ...) — not restarting") is expected to stay there. The
// brief allows `still starting` anywhere in the output; only the verdict is
// constrained.
function verdictLines(text) {
  return String(text || '').split('\n').filter((l) => l.indexOf('Web server:') >= 0);
}
const VERDICT_ALIVE_404 = 'alive but /health is 404';
const PLUGIN_NOT_ACTIVE = 'the dsh-daemon plugin is not active in the profile this daemon launches';
// Probe one path on the fake web. Returns the HTTP status, or 0 when nothing
// answered (which also distinguishes "listening but 404" from "port dead").
async function probeStatus(p) {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + p, { signal: AbortSignal.timeout(5000) });
    return res.status;
  } catch (e) { return 0; }
}

// ---- process helpers -------------------------------------------------------
// Every scraped PID is checked against its command line before it is signalled:
// `watchdogPids()` comes out of a log file, and a recycled PID must never be
// killed.
function psCommand(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return String(out || '');
  } catch (e) { return ''; }
}
function isOurProcess(pid) {
  const cmd = psCommand(pid);
  return cmd !== '' && cmd.indexOf(tmp) !== -1;
}
async function killPids(candidates, budgetMs = 15000) {
  const until = Date.now() + budgetMs;
  for (;;) {
    let lived = false;
    for (const pid of candidates()) {
      if (!pid || !alive(pid) || !isOurProcess(pid)) continue;
      lived = true;
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
    }
    if (!lived) break;
    if (Date.now() > until) break;
    await sleep(100);
  }
}
// Teardown order is part of the contract this test exists for: a surviving
// nohup watchdog keeps relaunching the web, and one generation = one more tab.
// Watchdogs first, then the fake web, the sandbox directory last.
function watchdogCandidates() {
  const out = watchdogPids().slice();
  const tracked = pidFromFile('.dsh-watchdog.pid');
  if (tracked) out.push(tracked);
  return out;
}
function webCandidates() {
  const out = [];
  const tracked = pidFromFile('.dsh-web.pid');
  if (tracked) out.push(tracked);
  for (const line of webEvents()) out.push(Number(line.split(/\s+/)[1]));
  return out;
}
async function killWatchdogs() {
  await killPids(watchdogCandidates);
  try { fs.unlinkSync(daemonFile('.dsh-watchdog.pid')); } catch (e) { /* absent */ }
}
async function killWebs() {
  await killPids(webCandidates);
  for (const file of ['.dsh-web.pid', '.dsh-web.started']) {
    try { fs.unlinkSync(daemonFile(file)); } catch (e) { /* absent */ }
  }
}
async function reap(child, budgetMs = 5000) {
  if (!child) return;
  try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, budgetMs);
    child.once('exit', finish);
    if (child.exitCode !== null) finish();
  });
}

// Spawn the generated watchdog as the resident supervisor for one case. The
// case's per-path status codes ride along in the environment: doLaunch() hands
// process.env to the fake `dsh web`.
function startResident() {
  const child = spawn(process.execPath, [watchdogJs], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.streamed = '';
  child.stdout.on('data', (d) => { child.streamed += d; });
  child.stderr.on('data', (d) => { child.streamed += d; });
  return child;
}

// Run the generated watchdog in a one-shot CLI mode, as the `dsh-daemon`
// wrapper does: `node watchdog.js --status`.
function runCli(args, capMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [watchdogJs].concat(args), {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, capMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, timedOut, ms: Date.now() - t0 });
    });
  });
}

// ---- sandbox: fake `dsh` package + fake browser openers --------------------
const fakeDir = path.join(tmp, 'fake-dsh');
const fakeBin = path.join(fakeDir, 'lib', 'bin.js');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' })); // token-auth capable
// The fake web models the incident exactly: the LISTENER is up, and each path
// answers what the case needs. Per case:
//   /health                the plugin's own route        (404 pluginless / 503 broken)
//   /manifest.webmanifest  CORE static asset, no cookie  (200 = dsh web alive / 404)
//   /                      core auth fence               (401 alive / 404 not dsh)
//   everything else        FAKE_OTHER                    (200 / 404)
// `start` is logged from the listen callback, so a logged start implies the
// port really answers.
fs.writeFileSync(fakeBin, [
  "#!/usr/bin/env node",
  "'use strict';",
  "const FS = require('node:fs');",
  "const HTTP = require('node:http');",
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'web') process.exit(0);",
  "const port = Number(args[args.indexOf('--port') + 1]);",
  "const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };",
  "const healthCode = num('FAKE_HEALTH', 404);",
  "const manifestCode = num('FAKE_MANIFEST', 200);",
  "const rootCode = num('FAKE_ROOT', 401);",
  "const otherCode = num('FAKE_OTHER', 200);",
  "const log = (ev) => { try { FS.appendFileSync(process.env.FAKE_WEB_MARKER, ev + ' ' + process.pid + '\\n'); } catch (e) {} };",
  "const token = 'tok_' + process.pid + '_' + Math.random().toString(36).slice(2, 12);",
  "const server = HTTP.createServer((req, res) => {",
  "  if (req.url === '/health') { res.writeHead(healthCode, { 'content-type': 'application/json' }); res.end('{\"ok\":false,\"code\":' + healthCode + '}'); return; }",
  "  if (req.url === '/manifest.webmanifest') { res.writeHead(manifestCode, { 'content-type': 'application/manifest+json' }); res.end('{\"name\":\"DeepSeek Harness\"}'); return; }",
  "  if (req.url === '/' || req.url === '/index.html') { res.writeHead(rootCode, { 'content-type': 'text/plain' }); res.end(rootCode === 401 ? 'Unauthorized' : 'x'); return; }",
  "  res.writeHead(otherCode); res.end('ok');",
  "});",
  "server.listen(port, '127.0.0.1', () => {",
  "  log('start');",
  "  setTimeout(() => { console.log('dsh web: http://127.0.0.1:' + port + '/?token=' + token); }, Number(process.env.FAKE_TOKEN_DELAY_MS || 3000));",
  "});",
  "process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });",
].join('\n') + '\n');
fs.chmodSync(fakeBin, 0o755);
fs.symlinkSync(fakeBin, path.join(tmp, 'bin', 'dsh'));
// Fake browser opener: openBrowser() spawns `open` on darwin and `xdg-open` on
// linux, so BOTH names must be shadowed inside tmp/bin. Faking only `open` made
// every open-count assertion vacuous on linux CI — the positive one went red
// and the negative ones passed for the wrong reason (v0.1.30 publish attempt).
const openerScript = '#!/bin/sh\necho "$*" >> ' + JSON.stringify(openMarker) + '\n';
for (const name of ['open', 'xdg-open']) {
  const p = path.join(tmp, 'bin', name);
  fs.writeFileSync(p, openerScript);
  fs.chmodSync(p, 0o755);
}

function makeCtx(registered) {
  const shell = {
    resolve(request) { return Object.assign({}, request, { workdir: process.cwd(), timeoutMs: request.timeoutMs || 30000 }); },
    async run(spec) {
      let stdout = '', stderr = '', exitCode = 0;
      try {
        stdout = execFileSync('/bin/bash', ['-c', spec.command], { encoding: 'utf8', timeout: spec.timeoutMs || 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        exitCode = e.status === undefined ? 1 : e.status;
        stdout = e.stdout ? e.stdout.toString() : '';
        stderr = e.stderr ? e.stderr.toString() : '';
        if (exitCode === 0) exitCode = 1;
      }
      return { exitCode, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } };
    },
  };
  const fsMock = {
    async resolve(p) { return { path: p }; },
    async writeText(target, content) { fs.mkdirSync(path.dirname(target.path), { recursive: true }); fs.writeFileSync(target.path, content, 'utf8'); return { version: 'v1' }; },
    async readText(target) { return fs.readFileSync(target.path, 'utf8'); },
    async stat(target) { try { const s = fs.statSync(target.path); return { size: s.size, mtime: s.mtime }; } catch (e) { return undefined; } },
    async listDir(target) { return fs.readdirSync(target.path).map((n) => ({ name: n })); },
  };
  const ctx = {
    shell,
    fs: fsMock,
    timer: { timeout: (ms) => sleep(ms), interval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id); } },
    webServer: { port: 3080, register() { return () => {}; } },
    agents: { list: () => [] },
    jobs: { list: () => [] },
    sandboxPolicy: { resolve: (r) => ({ mode: (r && r.mode) || 'danger-full-access', workspaceRoot: process.cwd() }) },
    tools: { register(def) { registered.push(def); return () => {}; } },
    get(name) { return ctx[name]; },
    on() { return () => {}; },
    effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {}; },
    provide() { return () => {}; },
    timeout: (ms) => sleep(ms),
  };
  return ctx;
}

// ---- one observation window ------------------------------------------------
let resident = null; // the resident watchdog of the CURRENT window
// Kill leftovers, pick the case's per-path codes, spawn the resident watchdog,
// prove the fixture answers what the case claims, wait for the case's BINDING
// POSITIVE SIGNAL, then run the whole window out and report the deltas. Every
// negative assertion downstream is anchored on `anchored` being true, never on
// a bare sleep.
async function runWindow(label, codes, anchorFn) {
  await reap(resident); resident = null;
  await killWatchdogs();
  await killWebs();
  // Each window asks whether IT produces the give-up state, so start clean
  // instead of inheriting the previous window's verdict file.
  try { fs.unlinkSync(pluginlessState); } catch (e) { /* absent */ }
  Object.assign(process.env, codes);
  const t0 = Date.now();
  const base = { starts: starts().length, opens: opens().length, log: logText().length };
  resident = startResident();
  const up = await waitFor(() => starts().length > base.starts, 20000);
  const probed = {
    '/health': await probeStatus('/health'),
    '/manifest.webmanifest': await probeStatus('/manifest.webmanifest'),
    '/': await probeStatus('/'),
  };
  const anchored = await waitFor(() => anchorFn(base), ANCHOR_WAIT_MS);
  const startsAtAnchor = starts().length;
  // Run the window out: "stopped restarting" must mean stopped, not "the next
  // restart has not come around yet".
  await waitFor(() => Date.now() - t0 >= OBSERVE_MS, OBSERVE_MS + 20000);
  const delta = logText().slice(base.log);
  return {
    label, up, probed, anchored, startsAtAnchor, delta,
    starts: starts().length - base.starts,
    opens: opens().length - base.opens,
    state: readPluginless(),
    stateExists: fs.existsSync(pluginlessState),
    allStarts: starts().length,
  };
}
(async () => {
  try {
    Object.assign(process.env, {
      HOME: home, DSH_HOME: dshHome,
      DSH_DAEMON_NO_SYSTEM: '1', DSH_DAEMON_AUTOREGEN: '0',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'),
      DSH_DAEMON_AUTO_UPDATE: '0',
      // Baked into the generated watchdog (envVal() at install time).
      DSH_DAEMON_HEALTH_INTERVAL: '1s',
      DSH_DAEMON_STARTUP_GRACE: '8s',
      FAKE_WEB_MARKER: webMarker,
      PATH: path.join(tmp, 'bin') + path.delimiter + process.env.PATH,
    });
    // A headless/SSH environment would silently skip openBrowser and make the
    // tab-count assertion meaningless.
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
    delete process.env.DSH_DAEMON_OPEN_BROWSER;
    delete process.env.DSH_WEB_PORT;
    fs.mkdirSync(home, { recursive: true });

    const registered = [];
    // Dynamic sandbox loading — see the header. Anything wired into test:ci
    // (the publish gate) must not depend on @deepseek-ai/dsh-tools.
    const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
    const mockHarness = {
      defineTool(def) {
        if (!def || typeof def.execute !== 'function') throw new Error('bad tool def');
        if (!def.output || typeof def.output.render !== 'function') throw new Error('bad output');
        return def;
      },
      registerTool(ctx2, def) { registered.push(def); return () => {}; },
    };
    const pluginCtx = makeCtx(registered);
    const plugin = new Function('ctx', 'harness', src)(pluginCtx, mockHarness);
    await plugin.apply(pluginCtx);
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    const statusTool = registered.find((t) => t.name === 'dsh_daemon_status');
    check('registered dsh_daemon_install / dsh_daemon_status', !!install && !!statusTool);

    // ---- baseline: install generates the REAL watchdog, starts generation 1
    const installOut = await install.execute({ port: PORT }, {});
    check('install generated the real watchdog script', fs.existsSync(watchdogJs), brief(installOut, 4));
    check('baseline: the generated watchdog launched a fake dsh web',
      await waitFor(() => starts().length >= 1, 30000),
      'marker=' + JSON.stringify(webEvents().slice(-3)) + ' log=' + brief(logText(), 4));
    // From here every generation is launched by the watchdog this test spawns,
    // so each window owns its start count. The install-spawned supervisor must
    // go first — two watchdogs would race launches and pollute the counts.
    await killWatchdogs();
    await killWebs();

    // ===== G: dsh web alive (manifest 200), our /health is 404 =============
    // Anchored on the give-up line itself, so "no new start afterwards" means
    // the decision fired and held. The `not restarting` substring is NOT unique
    // in this log (a pre-grace tick legitimately logs `dsh web still starting
    // (Ns of Ns grace, PID …) — not restarting`), so the anchor requires the
    // substring ON THE 404 LINE.
    const GIVE_UP_LINE_MATCH = (text) => text.split('\n')
      .some((l) => l.indexOf('/health is 404') >= 0 && l.indexOf('not restarting') >= 0);
    if (want('G')) {
      const g = await runWindow('G', { FAKE_MANIFEST: '200', FAKE_ROOT: '401', FAKE_HEALTH: '404', FAKE_OTHER: '200' },
        (b) => GIVE_UP_LINE_MATCH(logText().slice(b.log)));
      check('G precondition: /manifest.webmanifest=200, /=401, /health=404',
        g.up && g.probed['/manifest.webmanifest'] === 200 && g.probed['/'] === 401 && g.probed['/health'] === 404,
        'listening=' + g.up + ' probed=' + JSON.stringify(g.probed));

      check('G1 exactly ONE generation: start events === 1 (a 404 must never restart)',
        g.anchored && g.starts === 1,
        'anchored=' + g.anchored + ' starts=' + g.starts + ' startsAtAnchor=' + g.startsAtAnchor
        + ' events=' + JSON.stringify(webEvents().slice(-5)));

      const giveUpLine = g.delta.split('\n').find((l) => l.indexOf('/health is 404') >= 0) || '';
      check('G2 the give-up line says `/health is 404` + `dsh web is alive` + `not restarting` + `dsh_daemon_reinstall`',
        giveUpLine.indexOf('dsh web is alive') >= 0
        && giveUpLine.indexOf('not restarting') >= 0
        && giveUpLine.indexOf('dsh_daemon_reinstall') >= 0,
        giveUpLine ? brief(giveUpLine, 1) : 'no `/health is 404` line; tail=' + brief(g.delta, 6));

      check('G3 .daemon-pluginless exists and records code 404',
        !!g.state && g.state.code === 404,
        'raw=' + (g.stateExists ? JSON.stringify(readDaemon('.daemon-pluginless')) : '<absent>')
        + ' dir=' + (fs.existsSync(daemonDir) ? fs.readdirSync(daemonDir).join(',') : '<no dir>'));

      // Positive anchor for the negative assertion: once the give-up line is on
      // record, no new web may be started for the rest of the window.
      check('G1b after the give-up line no further dsh web was started (the loop is broken)',
        g.anchored && starts().length === g.startsAtAnchor,
        'startsAtAnchor=' + g.startsAtAnchor + ' now=' + starts().length + ' tail=' + brief(g.delta, 6));

      const gCliStatus = await runCli(['--status'], 60000);
      const gPluginStatus = String(await statusTool.execute({}, {}));
      const gCliVerdicts = verdictLines(gCliStatus.out);
      const gPluginVerdicts = verdictLines(gPluginStatus);
      check('G4a template `--status` verdict says `alive but /health is 404`',
        gCliVerdicts.length === 1 && gCliVerdicts[0].indexOf(VERDICT_ALIVE_404) >= 0,
        'verdicts=' + JSON.stringify(gCliVerdicts));
      check('G4a\' the template verdict does not say `still starting`',
        gCliVerdicts.length === 1 && !/still starting/.test(gCliVerdicts[0]),
        'verdicts=' + JSON.stringify(gCliVerdicts));
      check('G4b plugin dsh_daemon_status verdict says `alive but /health is 404`',
        gPluginVerdicts.length === 1 && gPluginVerdicts[0].indexOf(VERDICT_ALIVE_404) >= 0,
        'verdicts=' + JSON.stringify(gPluginVerdicts));
      check('G4b\' the plugin verdict does not say `still starting`',
        gPluginVerdicts.length === 1 && !/still starting/.test(gPluginVerdicts[0]),
        'verdicts=' + JSON.stringify(gPluginVerdicts));
      check('G4c both verdicts carry the cause + the fix (`...not active in the profile...` + `dsh_daemon_reinstall`)',
        gCliVerdicts.length === 1 && gPluginVerdicts.length === 1
        && gCliVerdicts[0].indexOf(PLUGIN_NOT_ACTIVE) >= 0 && gPluginVerdicts[0].indexOf(PLUGIN_NOT_ACTIVE) >= 0
        && gCliVerdicts[0].indexOf('dsh_daemon_reinstall') >= 0 && gPluginVerdicts[0].indexOf('dsh_daemon_reinstall') >= 0,
        'cli=' + JSON.stringify(gCliVerdicts) + ' || plugin=' + JSON.stringify(gPluginVerdicts));
      check('G4d `--status` exit code 0', !gCliStatus.timedOut && gCliStatus.code === 0,
        'code=' + gCliStatus.code + ' ms=' + gCliStatus.ms + ' err=' + brief(gCliStatus.err));

      // The incident's user-visible half: one tab per generation. One
      // generation => exactly one tab.
      check('G5 at most ONE browser tab for the whole window (no per-generation tab)',
        g.anchored && g.opens >= 1 && g.opens <= 1,
        'opens=' + g.opens + ' (expected exactly 1: the only generation) lines=' + JSON.stringify(opens().slice(-4)));
    }

    // ===== H: dsh web alive (manifest 200), /health 503 ====================
    // A REAL fault: the plugin is serving but broken, so the existing restart
    // policy must survive the fix.
    if (want('H')) {
      const h = await runWindow('H', { FAKE_MANIFEST: '200', FAKE_ROOT: '401', FAKE_HEALTH: '503', FAKE_OTHER: '200' },
        (b) => starts().length - b.starts >= 2);
      check('H precondition: /manifest.webmanifest=200, /=401, /health=503',
        h.up && h.probed['/manifest.webmanifest'] === 200 && h.probed['/'] === 401 && h.probed['/health'] === 503,
        'listening=' + h.up + ' probed=' + JSON.stringify(h.probed));
      check('H1 a real failure keeps the restart policy: start events >= 2 in the same window',
        h.anchored && h.starts >= 2,
        'anchored=' + h.anchored + ' starts=' + h.starts + ' events=' + JSON.stringify(webEvents().slice(-5)));
      check('H2 the 503 path really walked through the failure threshold',
        h.delta.indexOf('failure threshold reached, restarting web server') >= 0, brief(h.delta, 6));
      check('H3 a 503 is NOT classified as pluginless: no .daemon-pluginless',
        h.anchored && !h.stateExists,
        'anchored=' + h.anchored + ' raw=' + (h.stateExists ? JSON.stringify(readDaemon('.daemon-pluginless')) : '<absent>'));
      const hCliStatus = await runCli(['--status'], 60000);
      const hVerdicts = verdictLines(hCliStatus.out);
      check('H4 status does not claim the 404 verdict for a 503',
        hVerdicts.length === 1 && hVerdicts[0].indexOf(VERDICT_ALIVE_404) < 0,
        'verdicts=' + JSON.stringify(hVerdicts));
    }

    // ===== I: the port is held by something that is NOT dsh ================
    // Nothing answers the core liveness evidence (manifest 404, / 404) and
    // /health is 404 too. This is a real fault: the watchdog must keep
    // restarting and must never conclude "the plugin is missing". An over-wide
    // liveness criterion makes exactly this case wedge forever.
    if (want('I')) {
      const i = await runWindow('I', { FAKE_MANIFEST: '404', FAKE_ROOT: '404', FAKE_HEALTH: '404', FAKE_OTHER: '404' },
        (b) => starts().length - b.starts >= 2);
      check('I precondition: nothing valid answers (manifest=404, /=404, /health=404) while the port listens',
        i.up && i.probed['/manifest.webmanifest'] === 404 && i.probed['/'] === 404 && i.probed['/health'] === 404,
        'listening=' + i.up + ' probed=' + JSON.stringify(i.probed));
      check('I1 a non-dsh listener still gets restarted: start events >= 2 (the fix must not wedge it)',
        i.anchored && i.starts >= 2,
        'anchored=' + i.anchored + ' starts=' + i.starts + ' events=' + JSON.stringify(webEvents().slice(-5)));
      check('I2 the failure threshold path really ran',
        i.delta.indexOf('failure threshold reached, restarting web server') >= 0, brief(i.delta, 6));
      check('I3 no .daemon-pluginless: a dead core is a real fault, not "plugin missing"',
        i.anchored && !i.stateExists,
        'anchored=' + i.anchored + ' raw=' + (i.stateExists ? JSON.stringify(readDaemon('.daemon-pluginless')) : '<absent>'));
      check('I4 the log never claims `dsh web is alive` for a listener that fails the core probe',
        i.delta.indexOf('dsh web is alive') < 0, brief(i.delta, 6));
      const iCliStatus = await runCli(['--status'], 60000);
      const iVerdicts = verdictLines(iCliStatus.out);
      check('I5 status does not claim the pluginless verdict either',
        iVerdicts.length === 1 && iVerdicts[0].indexOf(VERDICT_ALIVE_404) < 0,
        'verdicts=' + JSON.stringify(iVerdicts));
    }
  } catch (e) {
    failures += 1;
    console.log('  [FAIL] unexpected error: '
      + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e)));
  } finally {
    // Teardown order: watchdog -> web -> directory. A surviving watchdog is
    // what kept the incident going (it relaunches the web, i.e. opens another
    // tab), so it must never outlive this test.
    await reap(resident);
    await killWatchdogs();
    await killWebs();
    if (failures) {
      console.log('\n--- watchdog.log tail (evidence) ---');
      console.log(String(logText() || '<empty>').trim().split('\n').slice(-16).join('\n'));
    }
    // Only ever the private mkdtemp sandbox — never a real ~/.dsh.
    if (tmp.indexOf(os.tmpdir()) === 0 && tmp.indexOf('dsh-daemon-pluginless-') !== -1) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
    console.log(failures ? '\nFAILED (' + failures + ')'
      : '\npluginless-health tests passed (' + CASES.join('/')
        + ': 404-pluginless stops and explains itself; 503 and a non-dsh listener still restart)');
    console.log('sandbox: ' + tmp + (fs.existsSync(tmp) ? ' (kept)' : ' (removed)'));
    process.exit(failures ? 1 : 0);
  }
})();
