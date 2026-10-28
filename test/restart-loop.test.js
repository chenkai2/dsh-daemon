// restart-loop tests (v0.1.28)
//
// Comes out of a real incident (2026-10-28): a healthy dsh web was restarted
// three times in half an hour on an 8-core box running under load average
// 100+, and after the third restart the daemon's pid file pointed at a process
// that was already gone while an untracked dsh web kept serving the port. From
// then on the watchdog launched a new dsh web every few minutes, each one
// dying with EADDRINUSE, because it neither recognised the real listener nor
// could it ever be re-tracked.
//
// Two independent fixes are pinned here, both against the REAL generated
// watchdog (the one install() spawns via nohup):
//   T1  an unmanaged dsh web already serving the port is ADOPTED (pid file
//       corrected, no second instance launched, nothing killed)
//   T2  a /health probe slower than the old 5s budget is tolerated: no restart
//       while the server keeps answering (was: 3 misses x 5s -> SIGKILL)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-restart-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const watchdogLog = path.join(daemonDir, 'logs', 'watchdog.log');
const marker = path.join(tmp, 'fake-web.events');
const PORT = 3095;
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
function sigterms() { return events().filter((l) => l.startsWith('sigterm')); }
function logText() { try { return fs.readFileSync(watchdogLog, 'utf8'); } catch (e) { return ''; } }
function pidFromFile(file) {
  try { return Number(fs.readFileSync(path.join(daemonDir, file), 'utf8').trim()) || 0; } catch (e) { return 0; }
}
function watchdogPids() {
  const out = [];
  const re = /watchdog started \(PID (\d+)/g;
  for (let m = re.exec(logText()); m; m = re.exec(logText())) out.push(Number(m[1]));
  return out;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

async function killAll(budgetMs = 20000) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const candidates = [pidFromFile('.dsh-watchdog.pid'), pidFromFile('.dsh-web.pid')].concat(watchdogPids());
    for (const line of events()) candidates.push(Number(line.split(/\s+/)[1]));
    let anyAlive = false;
    for (const pid of candidates) {
      if (!pid || !alive(pid)) continue;
      anyAlive = true;
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
    }
    if (!anyAlive) break;
    if (Date.now() > until) break;
    await sleep(100);
  }
  for (const file of ['.dsh-web.started', '.dsh-web.pid']) {
    try { fs.unlinkSync(path.join(daemonDir, file)); } catch (e) { /* absent */ }
  }
}

// ---- fake `dsh web`: serves /health after a per-request latency -----------
const fakeDir = path.join(tmp, 'fake-dsh');
const fakeBin = path.join(fakeDir, 'lib', 'bin.js');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
fs.writeFileSync(fakeBin, [
  "#!/usr/bin/env node",
  "'use strict';",
  "const fs = require('node:fs');",
  "const http = require('node:http');",
  "const args = process.argv.slice(2);",
  "const log = (ev) => { try { fs.appendFileSync(process.env.FAKE_MARKER, ev + ' ' + process.pid + '\\n'); } catch (e) {} };",
  "if (args[0] !== 'web') process.exit(0);",
  "const portIdx = args.indexOf('--port');",
  "const port = Number(args[portIdx + 1]);",
  "const latency = Number(process.env.FAKE_HEALTH_LATENCY_MS || 0);",
  "log('start');",
  "console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake');",
  "const server = http.createServer((req, res) => {",
  "  const answer = () => { if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"ok\":true}'); return; } res.writeHead(200); res.end('ok'); };",
  "  if (req.url === '/health' && latency > 0) setTimeout(answer, latency); else answer();",
  "});",
  "server.listen(port, '127.0.0.1');",
  "process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });",
].join('\n') + '\n');
fs.chmodSync(fakeBin, 0o755);
fs.symlinkSync(fakeBin, path.join(tmp, 'bin', 'dsh'));

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

(async () => {
  try {
    Object.assign(process.env, {
      HOME: home, DSH_HOME: dshHome,
      DSH_DAEMON_NO_SYSTEM: '1', DSH_DAEMON_AUTOREGEN: '0',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'),
      DSH_DAEMON_AUTO_UPDATE: '0',
      DSH_DAEMON_HEALTH_INTERVAL: '1s',
      DSH_DAEMON_STARTUP_GRACE: '20s',
      FAKE_MARKER: marker,
      FAKE_HEALTH_LATENCY_MS: '0',
      PATH: path.join(tmp, 'bin') + path.delimiter + process.env.PATH,
    });
    fs.mkdirSync(home, { recursive: true });
    const registered = [];
    const plugin = require(path.join(root, 'lib', 'index.js'));
    await plugin.apply(makeCtx(registered));
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    check('注册了 dsh_daemon_install 工具', !!install);

    // ===== T1: adopt the real listener when the pid file points at a ghost ===
    // 复刻 2026-10-28 现场：真正在服务的是 X，pid 文件里写的却是已经死掉的 Y。
    await install.execute({ port: PORT }, {});
    check('安装生成了 watchdog 脚本', fs.existsSync(watchdogJs));
    await waitFor(() => pidFromFile('.dsh-web.pid') > 0, 20000);
    const realPid = pidFromFile('.dsh-web.pid');
    check('T1 场景 dsh web 已由 watchdog 拉起', await waitFor(
      () => alive(realPid) && events().some((l) => l.startsWith('start ') && Number(l.split(' ')[1]) === realPid), 20000),
      'realPid=' + realPid + ' events=' + JSON.stringify(events()));
    // 把 pid 文件改成一个死 PID（等价于「双拉起里记到了失败的那个」）
    fs.writeFileSync(path.join(daemonDir, '.dsh-web.pid'), '999999\n');
    const adopted = await waitFor(() => pidFromFile('.dsh-web.pid') === realPid, 25000);
    check('T1 pid 文件被纠正为真实监听者', adopted, 'pid file=' + pidFromFile('.dsh-web.pid') + ' real=' + realPid);
    check('T1 watchdog 记录了收养', /adopted the running dsh web/.test(logText()), logText().split('\n').slice(-3).join(' | '));
    check('T1 没有为收养再起第二个 dsh web', starts().filter((l) => Number(l.split(' ')[1]) === realPid).length === 1,
      'events: ' + JSON.stringify(events()));
    check('T1 没有杀掉被收养的进程', !sigterms().some((l) => Number(l.split(' ')[1]) === realPid), JSON.stringify(sigterms()));
    check('T1 没有把端口误判成 unmanaged', !/is held by an unmanaged process/.test(logText()), logText().split('\n').slice(-3).join(' | '));

    // ===== T2: a >5s /health answer is not a failure =======================
    await killAll();
    fs.writeFileSync(marker, '');
    try { fs.unlinkSync(watchdogLog); } catch (e) { /* absent */ }
    Object.assign(process.env, { FAKE_HEALTH_LATENCY_MS: '6000' });
    await install.execute({ port: PORT }, {});
    await waitFor(() => watchdogPids().length >= 1, 15000);
    check('T2 场景 watchdog 已启动', watchdogPids().length >= 1, JSON.stringify(watchdogPids()));
    check('T2 dsh web 已启动', await waitFor(() => starts().length >= 1, 15000), JSON.stringify(events()));
    await sleep(15000); // 旧逻辑：3 次 5s 超时 ≈ 15~20s 内即 SIGKILL
    check('T2 慢 /health 没有触发重启（仍是一个进程）', starts().length === 1, 'events: ' + JSON.stringify(events()));
    check('T2 没有被 SIGTERM', sigterms().length === 0, 'events: ' + JSON.stringify(events()));
    check('T2 没有记录到 5/5 失败', !/health check failed \(5\/5\)/.test(logText()), logText().split('\n').slice(-3).join(' | '));
  } catch (e) {
    failures += 1;
    console.log('  [FAIL] 测试异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e));
  } finally {
    await killAll();
    console.log(failures ? `\nFAILED (${failures})` : '\nrestart-loop tests passed (adoption + slow /health tolerance)');
    process.exit(failures ? 1 : 0);
  }
})();
