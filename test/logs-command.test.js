// logs-command tests (v0.1.27)
//
// Two guarantees from the operator's point of view:
//   1. the watchdog tick default is 10s (`INTERVAL_MS = 10000` baked into the
//      generated script when DSH_DAEMON_HEALTH_INTERVAL is unset);
//   2. when dsh web fails to start, the failure report says HOW to read the
//      details — systemctl prints a `journalctl -xe` pointer when a unit fails,
//      and `dsh-daemon logs` is the daemon equivalent. It must work both as the
//      generated CLI command and as the watchdog `--logs` mode it forwards to.
//
// The test drives the REAL generated watchdog against a fake `dsh` that dies
// immediately on `web` (the classic "plugin activation failed" startup death),
// then reads the logs through both entry points.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-logs-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const logsDir = path.join(daemonDir, 'logs');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const cliPath = path.join(tmp, 'bin', 'dsh-daemon');
const PORT = 3094;
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
function pidFromFile(file) {
  try { return Number(fs.readFileSync(path.join(daemonDir, file), 'utf8').trim()) || 0; } catch (e) { return 0; }
}
// The install-spawned watchdog must not keep relaunching the fake web while a
// scenario runs; kill the tracked processes and drop the launch bookkeeping so
// the one-shot CLI runs exactly what the test describes.
async function killTracked() {
  for (const pid of [pidFromFile('.dsh-watchdog.pid'), pidFromFile('.dsh-web.pid')]) {
    if (!pid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
  for (const file of ['.dsh-watchdog.pid', '.dsh-web.pid', '.dsh-web.started']) {
    try { fs.unlinkSync(path.join(daemonDir, file)); } catch (e) { /* absent */ }
  }
  await sleep(300);
}
function runNode(args) {
  try {
    const out = execFileSync(process.execPath, args, {
      encoding: 'utf8', env: process.env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status === undefined ? 1 : e.status,
      out: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''),
    };
  }
}
// The generated CLI is a #!bash script — run it directly, not through node.
function runCli(args) {
  try {
    const out = execFileSync(cliPath, args, {
      encoding: 'utf8', env: process.env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status === undefined ? 1 : e.status,
      out: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''),
    };
  }
}

// ---- fake dsh: `dsh web` dies immediately with a plugin-activation error ----
const fakeDir = path.join(tmp, 'fake-dsh');
const fakeBin = path.join(fakeDir, 'lib', 'bin.js');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' }));
fs.writeFileSync(fakeBin, [
  "#!/usr/bin/env node",
  "'use strict';",
  "const args = process.argv.slice(2);",
  "if (args[0] !== 'web') process.exit(0);",
  "process.stderr.write('fake dsh web: plugin activation failed: cannot find module @x/y\\n');",
  "process.exit(1);",
  "",
].join('\n'), { mode: 0o755 });
fs.symlinkSync(fakeBin, path.join(tmp, 'bin', 'dsh'));

// ---- ctx mock (same shapes as test/harness.js) ------------------------------
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
  return {
    shell,
    fs: {
      async resolve(p) { return { path: p }; },
      async writeText(target, content) {
        fs.mkdirSync(path.dirname(target.path), { recursive: true });
        fs.writeFileSync(target.path, content, 'utf8');
        return { version: 'v1' };
      },
      async readText(target) { return fs.readFileSync(target.path, 'utf8'); },
      async stat(target) { try { const s = fs.statSync(target.path); return { size: s.size, mtime: s.mtime }; } catch (e) { return undefined; } },
      async listDir(target) { return fs.readdirSync(target.path).map((n) => ({ name: n })); },
    },
    timer: { timeout: (ms) => sleep(ms), interval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id); } },
    webServer: { port: 3080, register() { return () => {}; } },
    agents: { list: () => [] },
    jobs: { list: () => [] },
    sandboxPolicy: { resolve: (r) => ({ mode: (r && r.mode) || 'danger-full-access', workspaceRoot: process.cwd() }) },
    tools: { register(def) { registered.push(def); return () => {}; } },
    get(name) { return this[name]; },
    on() { return () => {}; },
    effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {}; },
    provide() { return () => {}; },
    timeout: (ms) => sleep(ms),
  };
}

(async () => {
  try {
    Object.assign(process.env, {
      HOME: home,
      DSH_HOME: dshHome,
      DSH_DAEMON_NO_SYSTEM: '1',
      DSH_DAEMON_AUTOREGEN: '0',
      DSH_DAEMON_AUTO_UPDATE: '0',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'),
      DSH_DAEMON_STARTUP_GRACE: '5s',
      PATH: path.join(tmp, 'bin') + path.delimiter + process.env.PATH,
    });
    // The 10s default must be observable with the override UNSET, so make sure
    // an inherited env var cannot mask it.
    delete process.env.DSH_DAEMON_HEALTH_INTERVAL;
    fs.mkdirSync(home, { recursive: true });

    const registered = [];
    // Load the plugin the way the DSH cordis host loads it in dynamic-sandbox
    // mode: evaluate lib/index.js with a `harness` global. The static-package
    // path would require @deepseek-ai/dsh-tools, which this repo's committed
    // package-lock.json pins to a machine-local `link: true` entry — CI cannot
    // resolve it (`npm ci` succeeds, the symlink dangles), so the release-
    // pipeline test must not depend on that module.
    const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
    const mockHarness = {
      defineTool(def) {
        if (!def || typeof def.execute !== 'function') throw new Error('bad tool def');
        if (!def.output || typeof def.output.render !== 'function') throw new Error('bad output');
        return def;
      },
      registerTool(ctx2, def) { registered.push(def); return () => {}; },
    };
    const ctx = makeCtx(registered);
    const plugin = new Function('ctx', 'harness', src)(ctx, mockHarness);
    await plugin.apply(ctx);
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    const logsTool = registered.find((t) => t.name === 'dsh_daemon_logs');
    check('注册了 dsh_daemon_install 工具', !!install);
    check('注册了 dsh_daemon_logs 工具', !!logsTool);

    const installOut = await install.execute({ port: PORT }, {});
    check('安装生成了 watchdog 脚本', fs.existsSync(watchdogJs));
    const script = fs.readFileSync(watchdogJs, 'utf8');

    // ---- guarantee 1: 10s tick -------------------------------------------
    check('watchdog 默认健康检查间隔为 10s', script.indexOf('const INTERVAL_MS = 10000;') !== -1,
      (script.match(/const INTERVAL_MS = \d+;/) || ['<missing>'])[0]);
    check('安装输出提到 dsh-daemon logs', /dsh-daemon logs/.test(installOut));
    check('生成了 dsh-daemon CLI', fs.existsSync(cliPath));

    // ---- guarantee 2: startup failure points at the details --------------
    await killTracked();
    const start = runNode([watchdogJs, '--start']);
    check('--start 在 web 秒退时以非零码结束', start.code !== 0, 'exit ' + start.code);
    check('--start 明确报告启动失败', /dsh web exited during startup/.test(start.out), start.out.slice(-400));
    check('--start 指出了查看明细的命令', /dsh-daemon logs -n 100/.test(start.out), start.out.slice(-400));

    // the web log now holds the fake's dying words
    const webLog = path.join(logsDir, 'dsh-web.log');
    check('dsh-web.log 记录了失败原因', fs.existsSync(webLog) &&
      fs.readFileSync(webLog, 'utf8').indexOf('plugin activation failed') !== -1);
    // a watchdog.log line must carry the pointer too (so tailing the watchdog log
    // is enough to find the details); the watchdog spawned by --start writes it
    // asynchronously, and the self-heal tick writes another after a dead launch.
    const wdLog = path.join(logsDir, 'watchdog.log');
    const pointerLogged = await waitFor(() => fs.existsSync(wdLog) &&
      /details: dsh-daemon logs/.test(fs.readFileSync(wdLog, 'utf8')), 15000);
    check('watchdog.log 的失败行带有明细指针', pointerLogged,
      fs.existsSync(wdLog) ? fs.readFileSync(wdLog, 'utf8').split('\n').slice(-3).join(' | ') : 'no watchdog.log');

    // ---- `--status` and the status tool point at the same details ---------
    const status = runNode([watchdogJs, '--status']);
    check('--status 不健康时也指向明细命令', /Details: dsh-daemon logs -n 100/.test(status.out), status.out.slice(-400));
    const statusTool = registered.find((t) => t.name === 'dsh_daemon_status');
    const statusToolOut = await statusTool.execute({}, {});
    check('dsh_daemon_status 不健康时指向明细命令', /Details: dsh-daemon logs -n 100/.test(statusToolOut), statusToolOut.slice(-400));

    // ---- `--logs` mode ----------------------------------------------------
    const logs = runNode([watchdogJs, '--logs', '-n', '20']);
    check('--logs 以 0 退出', logs.code === 0, 'exit ' + logs.code + ' ' + logs.out.slice(-300));
    check('--logs 打印诊断头', /dsh-daemon logs — dsh web startup diagnostics/.test(logs.out), logs.out.slice(0, 300));
    check('--logs 打印 dsh-web.log 段', /--- dsh-web\.log \(last 20 lines/.test(logs.out));
    check('--logs 打印 watchdog.log 段', /--- watchdog\.log \(last 20 lines/.test(logs.out));
    check('--logs 包含真正的失败原因', /plugin activation failed/.test(logs.out));
    check('--logs 未把 /health 当成健康', /\/health ❌ not serving/.test(logs.out));

    const webOnly = runNode([watchdogJs, '--logs', '--web']);
    check('--logs --web 只输出 web 日志', /--- dsh-web\.log/.test(webOnly.out) && !/--- watchdog\.log/.test(webOnly.out));
    const badOpt = runNode([watchdogJs, '--logs', '--nope']);
    check('--logs 拒绝未知参数（退出码 2）', badOpt.code === 2 && /unknown option/.test(badOpt.out), 'exit ' + badOpt.code);
    const logsHelp = runNode([watchdogJs, '--logs', '--help']);
    check('--logs --help 打印用法', /Usage: dsh-daemon logs/.test(logsHelp.out));

    // ---- generated CLI wrapper -------------------------------------------
    const cli = runCli(['logs', '-n', '5']);
    check('`dsh-daemon logs` 转发到 watchdog --logs', cli.code === 0 &&
      /dsh-daemon logs — dsh web startup diagnostics/.test(cli.out), 'exit ' + cli.code + ' ' + cli.out.slice(0, 300));
    check('`dsh-daemon help` 里出现 logs', /logs/.test(runCli(['help']).out));

    // ---- agent tool -------------------------------------------------------
    const toolOut = await logsTool.execute({ lines: 10 }, {});
    check('dsh_daemon_logs 返回 web 日志段', /--- dsh-web\.log \(last 10 lines/.test(toolOut), toolOut.slice(0, 300));
    check('dsh_daemon_logs 返回失败原因', /plugin activation failed/.test(toolOut));
    check('dsh_daemon_logs 提示终端等价命令', /dsh-daemon logs/.test(toolOut));
    const toolWeb = await logsTool.execute({ source: 'web' }, {});
    check('dsh_daemon_logs source=web 只输出 web 日志', /--- dsh-web\.log/.test(toolWeb) && !/--- watchdog\.log/.test(toolWeb));
  } finally {
    await killTracked();
    try {
      execFileSync('/bin/bash', ['-c', 'chmod -R u+w ' + JSON.stringify(tmp) + ' 2>/dev/null; rm -rf ' + JSON.stringify(tmp)]);
    } catch (e) { /* best-effort */ }
  }
  console.log(failures === 0
    ? 'logs-command tests passed (10s tick default, `dsh-daemon logs`, failure-path hints, dsh_daemon_logs)'
    : 'logs-command tests FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})();
