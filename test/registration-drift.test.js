// registration-drift tests (v0.1.23)
//
// Comes out of a real incident: a daemon registered while DSH_HOME pointed at a
// temporary staging dir kept a LaunchAgent referencing a watchdog script under
// /tmp. Once /tmp was cleaned the registration was permanently broken, while
// `status` kept reporting the nohup-spawned watchdog as healthy.
//
// Runs the plugin IN-PROCESS against a temp HOME/DSH_HOME (so the deferred boot
// hook is observable) with DSH_DAEMON_NO_SYSTEM=1: no service manager is ever
// touched, and the watchdog the install spawns is killed before asserting.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-drift-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const plist = path.join(home, 'Library', 'LaunchAgents', 'com.deepseek-ai.dsh-watchdog.plist');
const watchdogLog = path.join(daemonDir, 'logs', 'watchdog.log');
const TRUSTED = 'chenkai2-dsh.e.weibo.com';
const PORT = 3099;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [ok]   ' + name); return; }
  failures += 1;
  console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  -> ' + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > until) return false; await sleep(100); }
}

// ---- minimal ctx mock (same shapes as test/harness.js) ----------------------
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
function killSpawned() {
  try {
    const wpid = fs.readFileSync(path.join(daemonDir, '.dsh-watchdog.pid'), 'utf8').trim();
    if (wpid) process.kill(Number(wpid), 'SIGKILL');
  } catch (e) { /* gone */ }
  try {
    const pids = execFileSync('/bin/bash', ['-c',
      "lsof -ti :" + PORT + " -sTCP:LISTEN 2>/dev/null; pgrep -f '" + tmp + "' 2>/dev/null"], { encoding: 'utf8' });
    for (const pid of pids.split('\n').map((s) => s.trim()).filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { /* gone */ }
    }
  } catch (e) { /* nothing matched */ }
}

(async () => {
  try {
    Object.assign(process.env, {
      HOME: home, DSH_HOME: dshHome, DSH_DAEMON_NO_SYSTEM: '1',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'), DSH_DAEMON_AUTOREGEN: '0',
      DSH_DAEMON_TRUSTED_HOST: TRUSTED,
    });
    fs.mkdirSync(home, { recursive: true });

    // ---- install through the real tool, in-process -------------------------
    const registered = [];
    const plugin = require(path.join(root, 'lib', 'index.js'));
    await plugin.apply(makeCtx(registered));                 // boot hook #1: not installed yet
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    check('注册了 dsh_daemon_install 工具', !!install);
    await install.execute({ port: PORT }, {});
    killSpawned();

    check('安装生成了 watchdog 脚本', fs.existsSync(watchdogJs));
    check('安装生成了 LaunchAgent plist', fs.existsSync(plist));
    const script = fs.readFileSync(watchdogJs, 'utf8');

    // F4: the install-time trusted host is embedded, not only read from the
    // watchdog's environment (the plugin's nohup self-start has no plist env).
    check('F4 watchdog 内嵌 DSH_DAEMON_TRUSTED_HOST 兜底值',
      script.indexOf('DSH_DAEMON_TRUSTED_HOST || "' + TRUSTED + '"') !== -1);
    check('GEN_VERSION 与 package.json 一致',
      script.indexOf('const GEN_VERSION = "' + require(path.join(root, 'package.json')).version + '"') !== -1);
    check('注册指向当前 watchdog 路径（基线）',
      fs.readFileSync(plist, 'utf8').indexOf('<string>' + watchdogJs + '</string>') !== -1);

    // F3: status must call out a stale registration instead of staying green.
    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace(watchdogJs, '/tmp/gone-daemon/watchdog.js'), 'utf8');
    const staleStatus = execFileSync('node', [watchdogJs, '--status'], { encoding: 'utf8' });
    check('F3 status 报 Registration stale', /Registration:\s*❌\s*stale/.test(staleStatus),
      staleStatus.split('\n').filter((l) => l.indexOf('Registration') !== -1).join(' | '));

    // F2: a later plugin boot repairs the drifted registration. NO_SYSTEM=1 keeps
    // this to file writes (no launchctl), which is exactly what users need the
    // boot hook to do for old broken installs.
    process.env.DSH_DAEMON_AUTOREGEN = '1';
    await plugin.apply(makeCtx([]));                          // boot hook #2
    const repaired = await waitFor(() => fs.existsSync(plist) &&
      fs.readFileSync(plist, 'utf8').indexOf('<string>' + watchdogJs + '</string>') !== -1, 10000);
    check('F2 自愈把注册改回当前 watchdog 路径', repaired,
      fs.readFileSync(plist, 'utf8').slice(0, 160));
    check('F2 自愈留下日志证据', (fs.existsSync(watchdogLog) ? fs.readFileSync(watchdogLog, 'utf8') : '')
      .indexOf('repaired stale LaunchAgent') !== -1);

    const healed = execFileSync('node', [watchdogJs, '--status'], { encoding: 'utf8' });
    check('F3 自愈后 status 不再报 stale', !/Registration:\s*❌\s*stale/.test(healed));
  } finally {
    killSpawned();
    try { execFileSync('/bin/bash', ['-c', 'chmod -R u+w ' + JSON.stringify(tmp) + ' 2>/dev/null; rm -rf ' + JSON.stringify(tmp)]); } catch (e) { /* best-effort */ }
  }

  console.log('');
  if (failures > 0) { console.error('registration-drift tests FAILED (' + failures + ')'); process.exit(1); }
  console.log('registration-drift tests passed (F2 registration self-heal, F3 status honesty, F4 embedded trusted host)');
})().catch((e) => { console.error('registration-drift tests crashed: ' + (e && e.stack || e)); process.exit(1); });
