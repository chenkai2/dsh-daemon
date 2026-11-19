// home-env-preference tests (v0.1.33)
//
// Comes out of a real failure: a docker build of the dsh image started a
// headless `dsh web`, called `{"cmd":"install"}` and the daemon wrote the
// watchdog to /root/.dsh/daemon/watchdog.js even though the image had
// ENV DSH_HOME=/data1/.dsh (DSH_DAEMON_NO_SYSTEM from the same ENV block did
// take effect, so the env was not missing).
//
// Root cause: homeAndDshHome() resolved the home by RUNNING A SHELL and
// trusting `${DSH_HOME:-$HOME/.dsh}`. That shell runs under dsh's managed
// shell environment (shell-env registry), which does not necessarily inherit
// the plugin process's own env. The fix prefers process.env.DSH_HOME and only
// falls back to the shell when it is unset.
//
// This test simulates the curated-shell environment by spawning every mock
// shell command WITHOUT DSH_HOME (and without HOME), which is exactly the
// condition that made the container write to /root/.dsh.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-homeenv-'));
const home = path.join(tmp, 'root-home');
const dshHome = path.join(tmp, 'data1', '.dsh');       // 与 $HOME 无关的绝对路径
const daemonDir = path.join(dshHome, 'daemon');
const watchdogInDshHome = path.join(daemonDir, 'watchdog.js');
const watchdogInHome = path.join(home, '.dsh', 'daemon', 'watchdog.js');
const PORT = 3097;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [ok]   ' + name); return; }
  failures += 1;
  console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  -> ' + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 受管 shell：故意丢掉 DSH_HOME / HOME（复现 dsh 的 shell 工具行为）----
function curatedShell() {
  return {
    resolve(request) { return Object.assign({}, request, { workdir: process.cwd(), timeoutMs: request.timeoutMs || 30000 }); },
    async run(spec) {
      const env = Object.assign({}, process.env);
      delete env.DSH_HOME;
      delete env.HOME;
      delete env.USERPROFILE;
      let stdout = '', stderr = '', exitCode = 0;
      try {
        stdout = execFileSync('/bin/bash', ['-c', spec.command], {
          encoding: 'utf8', timeout: spec.timeoutMs || 30000, stdio: ['ignore', 'pipe', 'pipe'], env,
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
}

function makeCtx(registered) {
  const ctx = {
    shell: curatedShell(),
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
    webServer: { port: PORT, register() { return () => {}; } },
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
      HOME: home,
      DSH_HOME: dshHome,
      DSH_DAEMON_NO_SYSTEM: '1',
      DSH_DAEMON_CLI_DIR: path.join(tmp, 'bin'),
      DSH_DAEMON_AUTOREGEN: '0',
    });
    fs.mkdirSync(home, { recursive: true });

    // ---- 受管 shell 确实看不到 DSH_HOME（前提自检）----
    const probeHome = execFileSync('/bin/bash', ['-c', 'echo ${DSH_HOME:-$HOME/.dsh}'], {
      encoding: 'utf8',
      env: (() => { const e = Object.assign({}, process.env); delete e.DSH_HOME; delete e.HOME; return e; })(),
    }).trim();
    check('前提：受管 shell 求值 ${DSH_HOME:-$HOME/.dsh} 会丢到别的目录',
      probeHome !== dshHome, probeHome);

    // ---- 真实 install ----
    // 用 dynamic-sandbox 方式加载：与 DSH 的 cordis 宿主一致（harness 全局），
    // 这样本测试不依赖 node_modules 里是否装了 @deepseek-ai/dsh-tools。
    const registered = [];
    const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
    const mockHarness = {
      defineTool(def) { return def; },
      registerTool(ctx2, def) { registered.push(def); return () => {}; },
    };
    const plugin = new Function('ctx', 'harness', src)(makeCtx(registered), mockHarness);
    if (!plugin || typeof plugin.apply !== 'function') throw new Error('plugin did not expose apply()');
    await plugin.apply(makeCtx(registered));
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    check('注册了 dsh_daemon_install 工具', !!install);
    if (!install) throw new Error('install tool missing');
    let res;
    let installErr = '';
    try {
      res = await install.execute({ port: PORT }, {});
    } catch (e) {
      installErr = (e && e.message) || String(e);
    }
    killSpawned();

    const out = typeof res === 'string' ? res : JSON.stringify(res || '');
    check('install 未抛异常', installErr === '', installErr);
    check('install 成功输出不含 error', !/"error"\s*:\s*"[^"]+"/.test(out), out.slice(0, 200));

    // ---- 核心断言：watchdog 落在进程 env 的 DSH_HOME 下 ----
    check('watchdog 写在 $DSH_HOME/daemon（进程 env 优先）', fs.existsSync(watchdogInDshHome),
      'expected ' + watchdogInDshHome + '; got ' + (fs.existsSync(watchdogInHome) ? watchdogInHome : 'nothing'));
    check('watchdog 没有落到 $HOME/.dsh（即修复前的容器病象）', !fs.existsSync(watchdogInHome), watchdogInHome);

    if (fs.existsSync(watchdogInDshHome)) {
      const script = fs.readFileSync(watchdogInDshHome, 'utf8');
      check('watchdog 内 baked 的 DSH_HOME 就是进程 env 的值',
        script.indexOf('const DSH_HOME = ' + JSON.stringify(dshHome) + ';') !== -1);
      check('watchdog 内不出现 $HOME/.dsh 路径', script.indexOf(path.join(home, '.dsh')) === -1);
    }

    // ---- 变异提示：把 homeAndDshHome 改回"只信 shell"，上面第一条会挂 ----
    console.log('\n  （判别力：把 homeAndDshHome 里的 envDshHome 去掉、只保留 shell 反查，本条即失败）');
  } catch (e) {
    failures += 1;
    console.error('  [FAIL] 异常: ' + (e && e.stack ? e.stack : e));
  } finally {
    killSpawned();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    console.log('\n' + (failures === 0 ? 'home-env-preference: OK' : 'home-env-preference: ' + failures + ' FAILED'));
    process.exit(failures === 0 ? 0 : 1);
  }
})();
