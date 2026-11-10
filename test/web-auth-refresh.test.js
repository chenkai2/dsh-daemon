// web-auth-refresh tests (fix/web-auth-refresh)
//
// Bug (2026-11-10): `.web-auth-url` never followed the running dsh web.
// `dsh web` answers /health as soon as its listener is up but prints
// `dsh web: http://127.0.0.1:<port>/?token=...` only AFTER the plugin loader
// settles. seedWebAuth() polled from a bare setTimeout chain and the one-shot
// CLI (`watchdog.js --restart`) called process.exit() the moment
// waitForHealth() returned — dropping the pending poll. So the token was never
// captured/logged/written, the resident watchdog never re-seeded, and status
// advertised a dead token as "(valid while this web process runs)".
//
// Runs against the REAL generated watchdog (install() writes it) and a fake
// `dsh web` reproducing the upstream ordering: /health at once, token ~3s later.
//   A  --restart waits for the token, persists the NEW one, and the CLI seed
//      path itself writes `.web-auth-opened`
//   B  `.dsh-web.logoffset` anchors the run; status says "stale" (template and
//      plugin); B3: a base past EOF must not lie either
//   C  the resident watchdog self-heals a lost .web-auth-url without a 2nd popup
//   D  browser open is throttled per GENERATION, not per process
//   E  --restart with no token line terminates fast with
//      `Web auth URL: not captured yet ...` within AUTH_WAIT (default 20s)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-webauth-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const logDir = path.join(daemonDir, 'logs');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const watchdogLog = path.join(logDir, 'watchdog.log');
const webLog = path.join(logDir, 'dsh-web.log');
const webMarker = path.join(tmp, 'fake-web.events');
const tokenFile = path.join(tmp, 'fake-web.token.json');
const openMarker = path.join(tmp, 'browser-opens.log');
const PORT = 3096;
// E contract: the one-shot CLI awaits awaitWebSeed(AUTH_WAIT_MS), where
// AUTH_WAIT_MS comes from DSH_DAEMON_AUTH_WAIT (seconds, default 20). So even
// with no token line the CLI must exit well inside this cap — a timeout here
// means the CLI really hangs (the old fire-and-forget build exited in ~1s and
// printed nothing, which is the other half of the same bug).
const AUTH_WAIT_MAX_MS = 35000;
const TOKEN_DELAY_MS = 3000;
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
// Last few non-empty lines, for failure messages.
function brief(s, n = 5) {
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
function tokenInfo() { try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch (e) { return null; } }
function currentAuthUrl() { return readDaemon('.web-auth-url').trim(); }
function genStarted() { return readDaemon('.dsh-web.started').trim(); }
function readOffset() {
  const raw = readDaemon('.dsh-web.logoffset');
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return { base: Number(o.base), started: Number(o.started) };
  } catch (e) { return null; }
}
function webLogFrom(base) {
  try { const text = fs.readFileSync(webLog, 'utf8'); return text.slice(base); } catch (e) { return ''; }
}

async function killAll(budgetMs = 20000) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const candidates = [pidFromFile('.dsh-watchdog.pid'), pidFromFile('.dsh-web.pid')].concat(watchdogPids());
    for (const line of webEvents()) candidates.push(Number(line.split(/\s+/)[1]));
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
    try { fs.unlinkSync(daemonFile(file)); } catch (e) { /* absent */ }
  }
}

// Run the generated watchdog in one of its one-shot CLI modes, as the
// `dsh-daemon` wrapper does: `node watchdog.js --restart`.
function runCli(args, extraEnv, capMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [watchdogJs].concat(args), {
      env: Object.assign({}, process.env, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
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

// ---- sandbox: fake `dsh` package + fake `open` + fake `dsh web` -------------
const fakeDir = path.join(tmp, 'fake-dsh');
const fakeBin = path.join(fakeDir, 'lib', 'bin.js');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' })); // token-auth + --no-open capable
// The fake web reproduces the upstream ordering that triggered the bug:
//   /health answers IMMEDIATELY (listener is up), the token line only appears
//   TOKEN_DELAY_MS later (plugin loader settle).
fs.writeFileSync(fakeBin, [
  "#!/usr/bin/env node",
  "'use strict';",
  "const FS = require('node:fs');",
  "const HTTP = require('node:http');",
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'web') process.exit(0);",
  "const port = Number(args[args.indexOf('--port') + 1]);",
  "const log = (ev) => { try { FS.appendFileSync(process.env.FAKE_WEB_MARKER, ev + ' ' + process.pid + '\\n'); } catch (e) {} };",
  "const token = 'tok_' + process.pid + '_' + Math.random().toString(36).slice(2, 12);",
  "const line = 'dsh web: http://127.0.0.1:' + port + '/?token=' + token;",
  // oracle: written at spawn time so the test knows the token of THIS process
  "try { FS.writeFileSync(process.env.FAKE_WEB_TOKEN_FILE, JSON.stringify({ pid: process.pid, url: line.replace(/^dsh web: /, ''), token: token })); } catch (e) {}",
  "log('start');",
  "const server = HTTP.createServer((req, res) => {",
  "  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"ok\":true}'); return; }",
  "  res.writeHead(200); res.end('ok');",
  "});",
  "server.listen(port, '127.0.0.1');",
  // FAKE_TOKEN_NEVER=1 models "dsh never prints the token line" (test E).
  "if (!process.env.FAKE_TOKEN_NEVER) setTimeout(() => { console.log(line); }, Number(process.env.FAKE_TOKEN_DELAY_MS || " + TOKEN_DELAY_MS + "));",
  "process.on('SIGTERM', () => { log('sigterm'); process.exit(0); });",
].join('\n') + '\n');
fs.chmodSync(fakeBin, 0o755);
fs.symlinkSync(fakeBin, path.join(tmp, 'bin', 'dsh'));
// Fake `open`: counts browser opens without touching a real desktop.
const fakeOpen = path.join(tmp, 'bin', 'open');
fs.writeFileSync(fakeOpen, '#!/bin/sh\necho "$*" >> ' + JSON.stringify(openMarker) + '\n');
fs.chmodSync(fakeOpen, 0o755);

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
  let residentWatchdog = null;
  try {
    Object.assign(process.env, {
      HOME: home, DSH_HOME: dshHome,
      DSH_DAEMON_NO_SYSTEM: '1', DSH_DAEMON_AUTOREGEN: '0',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'),
      DSH_DAEMON_AUTO_UPDATE: '0',
      // Baked into the generated watchdog: fast tick for the self-heal case.
      DSH_DAEMON_HEALTH_INTERVAL: '1s',
      // Kept short so test E cannot be stretched by the "still starting, wait
      // up to the startup grace" extension of the token poll.
      DSH_DAEMON_STARTUP_GRACE: '10s',
      FAKE_WEB_MARKER: webMarker,
      FAKE_WEB_TOKEN_FILE: tokenFile,
      PATH: path.join(tmp, 'bin') + path.delimiter + process.env.PATH,
    });
    // A real SSH/browser-disabled environment would silently skip openBrowser
    // and make test D meaningless.
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
    delete process.env.DSH_DAEMON_OPEN_BROWSER;
    delete process.env.DSH_WEB_PORT;
    fs.mkdirSync(home, { recursive: true });

    const registered = [];
    const plugin = require(path.join(root, 'lib', 'index.js'));
    await plugin.apply(makeCtx(registered));
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    const statusTool = registered.find((t) => t.name === 'dsh_daemon_status');
    check('注册了 dsh_daemon_install / dsh_daemon_status', !!install && !!statusTool);

    // ---- baseline: install generates the REAL watchdog, starts generation 1
    const installOut = await install.execute({ port: PORT }, {});
    check('安装生成了 watchdog 脚本', fs.existsSync(watchdogJs), brief(installOut, 4));
    const gen1Ok = await waitFor(() => {
      const t = tokenInfo();
      return !!(t && currentAuthUrl() && currentAuthUrl() === t.url);
    }, 30000);
    check('基线：常驻 watchdog 抓到第一代 token（进程活着时轮询链能跑完）', gen1Ok,
      'file=' + currentAuthUrl() + ' token=' + JSON.stringify(tokenInfo()) + ' log=' + brief(logText(), 4));
    const gen1Pid = pidFromFile('.dsh-web.pid');
    const gen1Url = currentAuthUrl();

    // Kill the install-spawned watchdog; from here every launch is explicit,
    // which is exactly the one-shot-CLI mode the bug lived in.
    await killAll();
    check('基线：watchdog/web 已停，端口空出', !alive(gen1Pid));

    // ===== A: --restart must capture the token printed AFTER /health =======
    const a = await runCli(['--restart'], {}, 40000);
    const aToken = tokenInfo();
    const aPid = pidFromFile('.dsh-web.pid');
    const aExpect = aToken ? aToken.url : null;
    check('A --restart 正常退出（没有挂死）', !a.timedOut, 'ms=' + a.ms + ' signal=' + a.signal);
    check('A --restart 退出码 0', a.code === 0, 'code=' + a.code + ' err=' + brief(a.err) + ' out=' + brief(a.out));
    check('A 本次 restart 确实换了一个新 web 进程', !!(aToken && aPid && aToken.pid === aPid && aPid !== gen1Pid),
      'gen1=' + gen1Pid + ' new=' + aPid + ' token=' + JSON.stringify(aToken));
    check('A stdout 含 `Web auth URL:`', /Web auth URL:/.test(a.out), brief(a.out));
    check('A stdout 里的 URL 就是本代 token', !!(aExpect && a.out.indexOf(aExpect) >= 0),
      'expect=' + aExpect + ' stdout=' + brief(a.out));
    check('A .web-auth-url == 新 token（bug 的核心断言）', !!aExpect && currentAuthUrl() === aExpect,
      'file=' + (currentAuthUrl() || '<absent>') + ' expect=' + aExpect
      + (currentAuthUrl() === gen1Url ? ' （文件仍是上一代的 ' + gen1Url + '，新 token 被丢弃）' : ''));
    check('A 本代 token 已落到 watchdog.log', !!aExpect && logText().indexOf(aExpect) >= 0, brief(logText(), 4));
    // The per-generation throttle file must be written by the SEED itself, so a
    // one-shot `--restart` (no resident watchdog anywhere) produces it too.
    // This is what keeps `.web-auth-opened` from being an ensureWebAuth-only
    // side effect that the CLI path silently skips.
    await waitFor(() => readDaemon('.web-auth-opened').trim() !== '', 5000);
    await waitFor(() => opens().length > 0, 5000); // openBrowser spawns detached
    const openedAfterA = readDaemon('.web-auth-opened').trim();
    const startedA = genStarted();
    check('A .web-auth-opened 由 CLI seed 路径写出（不是只有常驻 watchdog 才写）',
      openedAfterA !== '' && openedAfterA === startedA,
      '.web-auth-opened=' + JSON.stringify(openedAfterA) + ' .dsh-web.started=' + JSON.stringify(startedA));

    // ===== B: run anchor + honest status ===================================
    const offA = readOffset();
    check('B .dsh-web.logoffset 存在且是 {base, started}', !!offA,
      'raw=' + JSON.stringify(readDaemon('.dsh-web.logoffset')) + ' dir=' + fs.readdirSync(daemonDir).join(','));
    check('B logoffset.base 锚定在本代 token 行之前', !!offA && offA.base >= 0 && !!aExpect && webLogFrom(offA.base).indexOf(aExpect) >= 0,
      'base=' + (offA && offA.base) + ' weblog=' + brief(webLogFrom(offA ? offA.base : 0), 3));

    // Status must not pass off a URL from a dead process as "valid". The token
    // deliberately does NOT contain the word "stale": the assertion has to be
    // about the status wording, not about an echo of our own fixture.
    const deadGenUrl = 'http://127.0.0.1:' + PORT + '/?token=deadgen0seededbypreviousprocess';
    fs.writeFileSync(daemonFile('.web-auth-url'), deadGenUrl + '\n');
    const pluginStatus = String(await statusTool.execute({}, {}));
    check('B 插件 doStatus 在上一代 URL 上输出 stale', /stale/.test(pluginStatus), brief(pluginStatus, 6));
    check('B 插件 doStatus 报出的是那条上一代 URL', pluginStatus.indexOf('deadgen0seededbypreviousprocess') >= 0,
      brief(pluginStatus, 6));
    check('B 插件 doStatus 不再谎称 valid while this web process runs',
      !/valid while this web process runs/.test(pluginStatus), brief(pluginStatus, 6));

    fs.writeFileSync(daemonFile('.web-auth-url'), deadGenUrl + '\n');
    const b = await runCli(['--status'], {}, 40000);
    check('B 模板 --status 在上一代 URL 上输出 stale', /stale/.test(b.out), brief(b.out, 6));
    check('B 模板 --status 报出的是那条上一代 URL', b.out.indexOf('deadgen0seededbypreviousprocess') >= 0, brief(b.out, 6));
    check('B 模板 --status 不含 valid while this web process runs',
      !/valid while this web process runs/.test(b.out), brief(b.out, 6));

    // ===== B3: a run anchor past EOF (log truncated / rotated) =============
    // dsh-web.log can shrink under the watchdog (rotation, a recreated log on
    // win32). `base > WEB_LOG.size` must degrade to "no current-run token",
    // never to a crash and never to a "valid" claim.
    const goodOffset = readDaemon('.dsh-web.logoffset');
    const hugeBase = Math.max(1024 * 1024, (offA ? offA.base : 0) + 8 * 1024 * 1024);
    fs.writeFileSync(daemonFile('.dsh-web.logoffset'),
      JSON.stringify({ base: hugeBase, started: Date.now() }) + '\n');
    const b3 = await runCli(['--status'], {}, 40000);
    check('B3 logoffset.base > WEB_LOG.size 时 --status 不崩（退出码 0）',
      !b3.timedOut && b3.code === 0, 'code=' + b3.code + ' signal=' + b3.signal + ' err=' + brief(b3.err) + ' out=' + brief(b3.out));
    check('B3 截断后的 base 不误报 valid while this web process runs',
      !/valid while this web process runs/.test(b3.out), brief(b3.out, 6));
    check('B3 输出退化为 not captured 或 stale', /not captured|stale/.test(b3.out), brief(b3.out, 6));
    // C relies on the REAL anchor to know the current run's token.
    fs.writeFileSync(daemonFile('.dsh-web.logoffset'), goodOffset);

    // ===== C: resident watchdog self-heals a lost .web-auth-url ============
    const opensBeforeHeal = opens().length;
    const startsBeforeC = starts().length;
    try { fs.unlinkSync(daemonFile('.web-auth-url')); } catch (e) { /* absent */ }
    residentWatchdog = spawn(process.execPath, [watchdogJs], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let wdOut = '';
    residentWatchdog.stdout.on('data', (d) => { wdOut += d; });
    residentWatchdog.stderr.on('data', (d) => { wdOut += d; });
    const healed = await waitFor(() => currentAuthUrl() === aExpect, 25000);
    check('C 删掉 .web-auth-url 后一个健康 tick 内被写回本代 token', healed,
      'file=' + (currentAuthUrl() || '<absent>') + ' expect=' + aExpect + ' wd=' + brief(wdOut) + ' log=' + brief(logText(), 4));
    check('C 自愈没有重启 web（start 事件数不变）', starts().length === startsBeforeC,
      'before=' + startsBeforeC + ' after=' + starts().length + ' events=' + JSON.stringify(webEvents().slice(-4)));
    // A self-heal re-seeds the SAME generation: it must not pop a second tab.
    await sleep(300); // give a (wrong) detached open time to land before counting
    check('C 自愈不重复弹窗：open 次数不变', opens().length === opensBeforeHeal,
      'before=' + opensBeforeHeal + ' after=' + opens().length + ' lines=' + JSON.stringify(opens().slice(-3)));
    check('C 自愈不重复弹窗：.web-auth-opened 内容不变',
      readDaemon('.web-auth-opened').trim() === openedAfterA,
      'now=' + JSON.stringify(readDaemon('.web-auth-opened').trim()) + ' was=' + JSON.stringify(openedAfterA));

    // ===== D: browser open is throttled per GENERATION =====================
    // Cross generation: a restart may open the browser once more.
    if (residentWatchdog) {
      try { residentWatchdog.kill('SIGKILL'); } catch (e) { /* gone */ }
      await new Promise((r) => { if (residentWatchdog.exitCode !== null) return r(); residentWatchdog.once('exit', r); setTimeout(r, 5000); });
      residentWatchdog = null;
    }
    const startsBeforeD = starts().length;
    const opensBeforeD = opens().length;
    // doLaunch() silently skips a launch when the previous dsh web was started
    // less than MIN_RESTART_GAP_MS (15s) ago — that would produce no new
    // generation and fail D for the wrong reason. Wait the gap out explicitly
    // instead of racing it.
    const lastStartMs = Number(genStarted()) || 0;
    const gapWaitMs = Math.max(0, 15500 - (Date.now() - lastStartMs));
    if (gapWaitMs > 0) {
      console.log('     (D: 等 ' + Math.round(gapWaitMs / 1000) + 's 避开 MIN_RESTART_GAP_MS 的跳过)');
      await sleep(gapWaitMs);
    }
    const d = await runCli(['--restart'], {}, 40000);
    const dToken = tokenInfo();
    const dExpect = dToken ? dToken.url : null;
    check('D 跨代 --restart 正常退出', !d.timedOut && d.code === 0, 'code=' + d.code + ' ms=' + d.ms + ' out=' + brief(d.out));
    check('D 跨代 .web-auth-url 更新到新代 token', !!dExpect && currentAuthUrl() === dExpect,
      'file=' + currentAuthUrl() + ' expect=' + dExpect);
    check('D 跨代真的换进程了', starts().length > startsBeforeD && genStarted() !== startedA,
      'starts=' + startsBeforeD + '->' + starts().length + ' started=' + startedA + '->' + genStarted());
    check('D 跨代允许再开一次浏览器（open 次数 +1）',
      await waitFor(() => opens().length === opensBeforeD + 1, 5000),
      'before=' + opensBeforeD + ' after=' + opens().length + ' lines=' + JSON.stringify(opens().slice(-3)));
    check('D 跨代 .web-auth-opened 记录的是新代 WEB_STARTED', readDaemon('.web-auth-opened').trim() === genStarted(),
      '.web-auth-opened=' + JSON.stringify(readDaemon('.web-auth-opened').trim()) + ' started=' + JSON.stringify(genStarted()));

    const offD = readOffset();
    check('B2 .dsh-web.logoffset.base 跨代递增', !!offA && !!offD && offD.base > offA.base && offD.started > offA.started,
      'base ' + (offA && offA.base) + '->' + (offD && offD.base) + ' started ' + (offA && offA.started) + '->' + (offD && offD.started));

    // ===== E: no token line must still terminate with a verdict ============
    // Contract: the one-shot CLI awaits awaitWebSeed(AUTH_WAIT_MS), AUTH_WAIT_MS
    // from DSH_DAEMON_AUTH_WAIT (seconds, default 20) — never the 90s poll chain
    // and never the startup grace. E1 compresses the wait via that env var; E2
    // proves the DEFAULT is a 20s-class bound and not a fudge factor.
    await killAll();
    const e1 = await runCli(['--restart'], { FAKE_TOKEN_NEVER: '1', DSH_DAEMON_AUTH_WAIT: '5' }, AUTH_WAIT_MAX_MS);
    check('E1 dsh 永不打印 token 行时 --restart 不挂死（DSH_DAEMON_AUTH_WAIT=5）', !e1.timedOut,
      'timedOut after ' + e1.ms + 'ms (cap ' + AUTH_WAIT_MAX_MS + 'ms)');
    check('E1 退出码明确（0 或 1）', e1.code === 0 || e1.code === 1,
      'code=' + e1.code + ' signal=' + e1.signal + ' err=' + brief(e1.err));
    check('E1 stdout 含 `Web auth URL: not captured yet`', /Web auth URL: not captured yet/.test(e1.out), brief(e1.out));

    // Drop the fake web + its `.dsh-web.started` so E2 is not skipped by
    // MIN_RESTART_GAP_MS (same reason as the D wait above).
    await killAll();
    const e2 = await runCli(['--restart'], { FAKE_TOKEN_NEVER: '1' }, AUTH_WAIT_MAX_MS);
    check('E2 默认 AUTH_WAIT（不传 DSH_DAEMON_AUTH_WAIT）也在 35s 内退出', !e2.timedOut && e2.ms <= AUTH_WAIT_MAX_MS,
      'ms=' + e2.ms + ' (cap ' + AUTH_WAIT_MAX_MS + 'ms) signal=' + e2.signal);
    check('E2 默认路径同样输出 `Web auth URL: not captured yet`', /Web auth URL: not captured yet/.test(e2.out), brief(e2.out));
    console.log('     (E1 ' + (e1.ms / 1000).toFixed(1) + 's / E2 ' + (e2.ms / 1000).toFixed(1)
      + 's —— AUTH_WAIT 默认 20s，上限断言 ' + (AUTH_WAIT_MAX_MS / 1000) + 's)');
  } catch (e) {
    failures += 1;
    console.log('  [FAIL] 测试异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e));
  } finally {
    if (residentWatchdog) { try { residentWatchdog.kill('SIGKILL'); } catch (e) { /* gone */ } }
    await killAll();
    console.log(failures ? `\nFAILED (${failures})` : '\nweb-auth-refresh tests passed (A-E: token refresh, run anchor, self-heal, open throttle, bounded wait)');
    console.log('sandbox: ' + tmp);
    process.exit(failures ? 1 : 0);
  }
})();
