// update-gate tests (v0.1.29)
//
// Two gaps this pins down, both from a real question: "自动更新会判断客户端 dsh
// 版本吗？不兼容就别硬升"。
//
//   1. Before v0.1.29 the updater compared DAEMON versions only (isNewer +
//      sameMajor): a client whose dsh was older than the new daemon requires
//      would silently receive a package it cannot run. Now every published
//      version declares `dsh.requires.dsh` in package.json and the updater
//      enforces it BEFORE downloading: undeclared range / unreadable local dsh
//      version / unsatisfied range => automatic update skipped (a human can
//      still force it with `dsh-daemon update --apply`).
//   2. Every registry failure used to be reported as "registry unreachable",
//      so a timeout, a DNS failure and a 5xx looked identical. The probe now
//      classifies the error and retries once.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [ok]   ' + name); return; }
  failures += 1;
  console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  -> ' + extra));
}

// ---- 1) dshRangeSatisfied: extract the module-scope function and evaluate ---
const fnStart = src.indexOf('function dshRangeSatisfied');
const fnEnd = src.indexOf('function extractTokenUrl', fnStart);
assert.ok(fnStart > 0 && fnEnd > fnStart, 'dshRangeSatisfied not found in lib/index.js');
const dshRangeSatisfied = new Function(src.slice(fnStart, fnEnd) + '\nreturn dshRangeSatisfied;')();

const RANGE = '>=0.1.2-alpha.1 <0.3.0';
const cases = [
  ['0.2.1-rc.2', RANGE, true, '当前这台的 dsh（0.2.1-rc.2）在支持范围内'],
  ['0.1.2-alpha.1', RANGE, true, '下界本身算满足（>=）'],
  ['0.1.2-alpha.0', RANGE, false, '下界之前的 prerelease 不满足'],
  ['0.1.1', RANGE, false, '比最低支持版本旧'],
  ['0.2.1', RANGE, true, '0.2.x 受支持'],
  ['0.3.0', RANGE, false, '0.3.0 超出上界'],
  ['1.0.0', RANGE, false, '1.x 超出上界'],
  ['0.2.0-rc.1', '>=0.2.0 <0.3.0', false, 'prerelease 小于同版本 release，不满足 >=0.2.0'],
  ['0.2.0', '>=0.2.0 <0.3.0', true, 'release 满足下界'],
  ['0.2.1', '=0.2.1', true, '精确匹配'],
  ['0.2.1', '>0.2.1', false, '严格大于不成立'],
  ['0.2.1', '<=0.2.1', true, '小于等于成立'],
  ['0.2.1', '>=0.2.9', false, '低于下界'],
  ['0.2.1', '', null, '空区间 => 无法判定（null），不能当成满足'],
  [null, RANGE, null, '读不到本地 dsh 版本 => null'],
  [undefined, RANGE, null, '未定义版本 => null'],
  ['not-a-version', RANGE, null, '非法版本串 => null'],
  ['0.2.1', '^0.2.0', null, '不支持的语法（^）要当作无法判定，不能猜'],
];
for (const [v, r, want, label] of cases) {
  const got = dshRangeSatisfied(v, r);
  check(label + '（' + String(v) + ' / ' + r + '）', got === want, 'want ' + String(want) + ', got ' + String(got));
}

// ---- 2) package.json 声明了兼容区间，且能被上面的解析器判定 ----------------
check('package.json 声明了 dsh.requires.dsh',
  !!(pkg.dsh && pkg.dsh.requires && pkg.dsh.requires.dsh), JSON.stringify(pkg.dsh));
check('声明的区间可被解析（对 0.2.1 判定为满足）',
  dshRangeSatisfied('0.2.1', pkg.dsh.requires.dsh) === true, String(pkg.dsh.requires.dsh));

// ---- 3) 模板接线：生成脚本里真的有门禁与错误细分 --------------------------
check('模板内联了 dshRangeSatisfied', src.includes('dshRangeSatisfied.toString()'));
check('模板有 fetchLatestManifest（重试封装）', src.includes("'async function fetchLatestManifest() {"));
check('fetch 超时/重试常量存在',
  src.includes('UPDATE_FETCH_TIMEOUT_MS = 15000') && src.includes('UPDATE_FETCH_RETRY_MS = 2000'));
check('失败分类覆盖 timeout/DNS/连接',
  src.includes('timeout after ') && src.includes('DNS lookup failed') && src.includes('connection failed'));
check('门禁三个动作都在', src.includes("'unverified-compat'") && src.includes("'incompatible'") && src.includes("'unknown-dsh'"));
check('自动更新不可绕门禁（apply 只来自手动 --apply 才 force）',
  src.includes("checkUpdate(true, true)") && src.includes("'async function checkUpdate(apply, force) {"));
check('插件侧 status 也认识这三个动作',
  src.includes("'incompatible': '⛔ requires dsh '") && src.includes("'unverified-compat': '⚠️  new version declares no dsh compatibility range"));

// ---- 4) 真实生成一次 watchdog，确认生成物可解析且带门禁 -------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-gate-'));
const home = path.join(tmp, 'home');
const dshHome = path.join(home, '.dsh');
const daemonDir = path.join(dshHome, 'daemon');
const watchdogJs = path.join(daemonDir, 'watchdog.js');
const PORT = 3099;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeDir = path.join(tmp, 'fake-dsh');
const fakeBin = path.join(fakeDir, 'lib', 'bin.js');
fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
fs.writeFileSync(fakeBin, "#!/usr/bin/env node\nconsole.log('dsh web: http://127.0.0.1:' + 0 + '/?token=fake');\n");
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
    shell, fs: fsMock,
    timer: { timeout: (ms) => sleep(ms), interval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id); } },
    webServer: { port: 3080, register() { return () => {}; } },
    agents: { list: () => [] }, jobs: { list: () => [] },
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
      DSH_DAEMON_HEALTH_INTERVAL: '10s',
      PATH: path.join(tmp, 'bin') + path.delimiter + process.env.PATH,
    });
    fs.mkdirSync(home, { recursive: true });
    const registered = [];
    const plugin = require(path.join(root, 'lib', 'index.js'));
    await plugin.apply(makeCtx(registered));
    const install = registered.find((t) => t.name === 'dsh_daemon_install');
    await install.execute({ port: PORT }, {});
    await sleep(1200);
    check('安装生成了 watchdog 脚本', fs.existsSync(watchdogJs));
    const script = fs.readFileSync(watchdogJs, 'utf8');
    // 生成物必须能被 node 解析（门禁函数是 toString() 内联的，最容易拼坏）
    execFileSync(process.execPath, ['--check', watchdogJs], { stdio: 'pipe' });
    check('生成的 watchdog.js 通过 node --check', true);
    check('生成物内联了 dshRangeSatisfied', script.includes('function dshRangeSatisfied(version, range)'));
    check('生成物有 fetchLatestManifest', script.includes('async function fetchLatestManifest()'));
    check('生成物有兼容门禁分支', script.includes('dsh compatibility gate') && script.includes('unverified-compat'));
    check('生成物的 --apply-update 走 force', script.includes('checkUpdate(true, true)'));
    check('生成物 status 认识 incompatible', script.includes("'incompatible': '⛔ requires dsh '"));
  } catch (e) {
    failures += 1;
    console.log('  [FAIL] 异常: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e));
  } finally {
    for (const f of ['.dsh-watchdog.pid', '.dsh-web.pid']) {
      try {
        const pid = Number(fs.readFileSync(path.join(daemonDir, f), 'utf8').trim());
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
      } catch (e) { /* absent */ }
    }
    console.log(failures ? `\nFAILED (${failures})` : '\nupdate-gate tests passed (range gate + failure classification wiring)');
    process.exit(failures ? 1 : 0);
  }
})();
