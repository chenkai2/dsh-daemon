// startup-grace tests (v0.1.26)
//
// Comes out of a real incident: `dsh web` can take well over a minute to serve
// /health (large plugin set, cold caches, or a slow first boot after a reboot).
// The watchdog used to SIGKILL it after three consecutive 30s health misses —
// 60-90s on the tick grid — so a dsh web that starts fine by hand (just slowly)
// was killed mid-boot, relaunched, killed again, forever: dsh-daemon looked
// like it "cannot start dsh web" while `dsh web` from a shell worked.
//
// The watchdog now keeps a startup window (DSH_DAEMON_STARTUP_GRACE, default
// 5m) during which health misses never count towards a restart, and it stops a
// previous server with SIGTERM (then SIGKILL) and waits for the port before
// launching, so a leftover listener can no longer kill the fresh server with
// EADDRINUSE.
//
// The tests drive the REAL generated watchdog (the one install() spawns via
// nohup) against a fake `dsh` on PATH. Each scenario re-installs with its own
// env, so the process under test is exactly one watchdog, started the way the
// daemon starts it in production:
//   F1  a slow boot inside the grace is never killed or relaunched
//   F2  a boot that never serves /health is restarted after the grace, with a
//       graceful (SIGTERM) stop first
//   F3  every relaunch is preceded by a stop, i.e. the port is released first
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-grace-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const watchdogLog = path.join(daemonDir, 'logs', 'watchdog.log');
const marker = path.join(tmp, 'fake-web.events');
const PORT = 3093;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function events() {
  try { return fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; }
}
function starts() { return events().filter((l) => l.startsWith('start ')); }
function stops() { return events().filter((l) => l.startsWith('sigterm')); }
function watchdogLogText() {
  try { return fs.readFileSync(watchdogLog, 'utf8'); } catch (e) { return ''; }
}
function watchdogPids() {
  const out = [];
  const re = /watchdog started \(PID (\d+)/g;
  const text = watchdogLogText();
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(Number(m[1]));
  return out;
}
function alive(pids) {
  return pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  });
}
function pidFromFile(file) {
  try { return Number(fs.readFileSync(path.join(daemonDir, file), 'utf8').trim()) || 0; } catch (e) { return 0; }
}
// Kill the watchdog and every web process it started, and WAIT until they are
// really gone. install() starts the watchdog through nohup, so it takes a
// moment to appear; returning too early leaves a live watchdog behind, and two
// watchdogs then launch two web servers on the same port (the loser dies with
// EADDRINUSE), which has nothing to do with what a scenario observes. Hence:
// wait for `expectNewWatchdogs` fresh watchdog starts, then require a quiet
// window with nothing alive.
async function killAll(expectNewWatchdogs = 0, budgetMs = 40000) {
  const base = watchdogPids().length;
  const until = Date.now() + budgetMs;
  let quietSince = 0;
  for (;;) {
    const candidates = [pidFromFile('.dsh-watchdog.pid'), pidFromFile('.dsh-web.pid')].concat(watchdogPids());
    for (const line of events()) candidates.push(Number(line.split(/\s+/)[1]));
    let anyAlive = false;
    for (const pid of candidates) {
      if (!pid) continue;
      try { process.kill(pid, 0); } catch (e) { continue; }
      anyAlive = true;
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
    }
    if (anyAlive) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    const quiet = quietSince !== 0 && Date.now() - quietSince >= 2000;
    if (quiet && watchdogPids().length - base >= expectNewWatchdogs) break;
    if (Date.now() > until) break;
    await sleep(100);
  }
  // Drop the launch bookkeeping of the process we just killed: the watchdog
  // refuses to relaunch within MIN_RESTART_GAP_MS of the last launch, and a
  // clean slate is what each scenario wants to observe.
  for (const file of ['.dsh-web.started', '.dsh-web.pid']) {
    try { fs.unlinkSync(path.join(daemonDir, file)); } catch (e) { /* absent */ }
  }
}
// The install-spawned watchdog is the process under test: a second one would
// mean the single-instance guard failed and the scenario result is meaningless.
function checkSingleWatchdog(label) {
  const live = alive(watchdogPids());
  check(label + '：场景中只有一个 watchdog 在运行', live.length === 1, 'live watchdogs: ' + JSON.stringify(live));
}

// ---- fake dsh: `dsh web --port N` serving /health after FAKE_HEALTH_DELAY_MS
const fakeDir = path.join(tmp, 'fake-dsh');
const fakeBin = path.join(fakeDir, 'lib', 'bin.js');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' }));
// mode 0o755: PATH search only accepts executable files, and the daemon
// resolves `dsh` through `command -v dsh`.
fs.writeFileSync(fakeBin, [
  "#!/usr/bin/env node",
  "'use strict';",
  "const fs = require('node:fs');",
  "const http = require('node:http');",
  "const args = process.argv.slice(2);",
  "const markerFile = process.env.FAKE_MARKER;",
  "const log = (ev) => { try { fs.appendFileSync(markerFile, ev + ' ' + process.pid + '\\n'); } catch (e) {} };",
  "if (args[0] !== 'web') process.exit(0);",
  "const portIdx = args.indexOf('--port');",
  "const port = Number(args[portIdx + 1]);",
  "const delay = Number(process.env.FAKE_HEALTH_DELAY_MS || 0);",
  "const never = process.env.FAKE_HEALTH_NEVER === '1';",
  "const startedAt = Date.now();",
  "log('start');",
  "const server = http.createServer((req, res) => {",
  "  if (req.url === '/health' && !never && Date.now() - startedAt >= delay) {",
  "    if (!server.healthyAt) { server.healthyAt = Date.now(); log('healthy'); }",
  "    res.writeHead(200, { 'content-type': 'application/json' });",
  "    res.end('{\"ok\":true}');",
  "    return;",
  "  }",
  "  res.writeHead(503);",
  "  res.end('booting');",
  "});",
  "server.listen(port, '127.0.0.1');",
  "process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });",
  "process.on('SIGINT', () => { log('sigint'); process.exit(0); });",
  "",
].join('\n'), { mode: 0o755 });
// A symlink (not a copy) so `command -v dsh` resolves to the fake bin.js:
// the daemon reads the dsh version from its sibling package.json.
fs.symlinkSync(fakeBin, path.join(tmp, 'bin', 'dsh'));

// ---- ctx mock (same shapes as test/harness.js) -----------------------------
function makeCtx(registered) {
  const shell = {
    resolve(request) { return Object.assign({}, request, { workdir: process.cwd(), timeoutMs: request.timeoutMs || 30000 }); },
    async run(spec) {
      let stdout = '', stderr = '', exitCode = 0;
      try {
        stdout = execFileSync('/bin/bash', ['-c', spec.command], {
          encoding: 'utf8', timeout: spec.timeoutMs || 30000, stdio: ['ignore', 'pipe', 'pipe'],
        });
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
    async writeText(target, content) {
      fs.mkdirSync(path.dirname(target.path), { recursive: true });
      fs.writeFileSync(target.path, content, 'utf8');
      return { version: 'v1' };
    },
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

(async () => {
  let install;
  try {
    Object.assign(process.env, {
      HOME: home,
      DSH_HOME: dshHome,
      DSH_DAEMON_NO_SYSTEM: '1',
      DSH_DAEMON_AUTOREGEN: '0',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'),
      DSH_DAEMON_AUTO_UPDATE: '0',
      DSH_DAEMON_HEALTH_INTERVAL: '1s',
      DSH_DAEMON_STARTUP_GRACE: '20s',
      FAKE_MARKER: marker,
      PATH: path.join(tmp, 'bin') + path.delimiter + process.env.PATH,
    });
    fs.mkdirSync(home, { recursive: true });

    // ---- install through the real tool (health tick 1s, grace 20s) ---------
    const registered = [];
    const plugin = require(path.join(root, 'lib', 'index.js'));
    await plugin.apply(makeCtx(registered));
    install = registered.find((t) => t.name === 'dsh_daemon_install');
    check('注册了 dsh_daemon_install 工具', !!install);
    await install.execute({ port: PORT }, {});
    check('安装生成了 watchdog 脚本', fs.existsSync(watchdogJs));
    const script = fs.readFileSync(watchdogJs, 'utf8');
    check('watchdog 内嵌 20s 启动宽限期', script.indexOf('const STARTUP_GRACE_MS = 20000;') !== -1);
    // v0.1.28 起 stopWebServer 支持多个目标（跟踪 PID + 真实监听者），变量名由
    // pid 变成 v，SIGKILL 走 stubborn.forEach(killPid)：断言按行为而不是变量名。
    check('watchdog 先 SIGTERM 再 SIGKILL', script.indexOf("'SIGTERM'") !== -1 &&
      script.indexOf('process.kill(') !== -1 && script.indexOf('killPid') !== -1);
    await killAll(1);

    // ---- F1: a slow boot inside the grace is not killed ---------------------
    // Each scenario re-installs with its own env: install() spawns the watchdog,
    // so the process under test inherits exactly this scenario's fake behaviour.
    Object.assign(process.env, { FAKE_HEALTH_DELAY_MS: '8000', FAKE_HEALTH_NEVER: '0' });
    fs.writeFileSync(marker, '');
    await install.execute({ port: PORT }, {});
    const f1Watchdog = await waitFor(() => alive(watchdogPids()).length === 1, 15000);
    check('F1 场景 watchdog 已启动', f1Watchdog, 'live watchdogs: ' + JSON.stringify(alive(watchdogPids())));
    checkSingleWatchdog('F1');
    check('F1 慢启动进程已启动', await waitFor(() => starts().length >= 1, 15000), 'events: ' + JSON.stringify(events()));
    await sleep(10000); // past 3 misses on a 1s tick, still inside the 20s grace
    check('F1 慢启动进程没有被重启（只启动一次）', starts().length === 1, 'events: ' + JSON.stringify(events()));
    check('F1 慢启动进程没有被杀', stops().length === 0 && !events().some((l) => l.startsWith('sigint')),
      'events: ' + JSON.stringify(events()));
    check('F1 watchdog 记录了「仍在启动」而非重启', /still starting .*not restarting/.test(watchdogLogText()),
      watchdogLogText().split('\n').slice(-3).join(' | '));
    const healthy = await waitFor(() => events().some((l) => l.startsWith('healthy')), 15000);
    check('F1 慢启动最终变成健康（同一进程）', healthy, 'events: ' + JSON.stringify(events()));
    checkSingleWatchdog('F1（结束）');

    // ---- F2: never healthy -> restarted after the grace, gracefully ---------
    await killAll(1);
    fs.writeFileSync(marker, '');
    Object.assign(process.env, { DSH_DAEMON_STARTUP_GRACE: '2s', FAKE_HEALTH_DELAY_MS: '0', FAKE_HEALTH_NEVER: '1' });
    await install.execute({ port: PORT }, {});   // reinstall so the scenario watchdog embeds the shorter grace
    check('F2 场景 watchdog 已启动', await waitFor(() => alive(watchdogPids()).length === 1, 15000),
      'live watchdogs: ' + JSON.stringify(alive(watchdogPids())));
    checkSingleWatchdog('F2');
    const t0 = Date.now();
    const restarted = await waitFor(() => starts().length >= 2, 40000);
    const relaunchAfterMs = Date.now() - t0;
    check('F2 宽限期结束后会重启（不再无限等待）', restarted, 'events: ' + JSON.stringify(events()));
    check('F2 重启前先优雅停止（SIGTERM）', stops().length >= 1, 'events: ' + JSON.stringify(events()));
    check('F2 watchdog 记录了失败阈值', /failure threshold reached, restarting web server/.test(watchdogLogText()));
    check('F2 宽限期内没有重启（首次启动后先等宽限期）', relaunchAfterMs >= 3000, relaunchAfterMs + 'ms');

    // ---- F3: a relaunch only follows a graceful stop ------------------------
    await sleep(2000);
    const launches = starts().length;
    const stopped = stops().length;
    check('F3 每次重启都有对应的优雅停止（端口先释放）', stopped >= 1 && launches > stopped,
      'launches=' + launches + ' stops=' + stopped + ' events=' + JSON.stringify(events()));
  } finally {
    await killAll(0, 5000);
    try {
      execFileSync('/bin/bash', ['-c', 'chmod -R u+w ' + JSON.stringify(tmp) + ' 2>/dev/null; rm -rf ' + JSON.stringify(tmp)]);
    } catch (e) { /* best-effort */ }
  }
  console.log(failures === 0
    ? 'startup-grace tests passed (F1 slow boot inside grace, F2 restart after grace, F3 graceful stop before relaunch)'
    : 'startup-grace tests FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})();
