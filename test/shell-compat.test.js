// 回归测试：dsh 0.2.x 的 shell 服务只有 resolve + execute（方法从 run 改名而来），
// 且返回带 result() 的句柄。0.1.25 之前 daemon 直接 await shell.run(...)，
// 在 0.2.1 上抛 "shell.run is not a function"，导致 reinstall 等路径全废。
'use strict'
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const calls = []
// 刻意只提供 resolve + execute —— 不提供 run，复刻 0.2.x
const shell = {
  resolve(request) { return Object.assign({}, request) },
  async execute(spec) {
    calls.push(spec.command)
    return { async result() { return { exitCode: 0, stdout: { text: 'ok' }, stderr: { text: '' } } } }
  },
}
const ctx = {
  shell,
  fs: {
    async resolve(p) { return { path: p } },
    async writeText() { return { version: 'v1' } },
    async readText() { return '' },
    async stat() { return undefined },
    async listDir() { return [] },
  },
  timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval() { return () => {} } },
  webServer: { port: 3080, register() { return () => {} } },
  agents: { list: () => [] },
  jobs: { list: () => [] },
  sandboxPolicy: { resolve: (req) => Object.assign({ mode: 'danger-full-access' }, req || {}) },
  tools: { register(def) { registered.push(def); return () => {} } },
  get(name) { return ctx[name] },
  on() { return () => {} },
  effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {} },
  provide() { return () => {} },
  timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
}
const registered = []

;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-compat-'))
  process.env.HOME = home
  process.env.DSH_HOME = path.join(home, '.dsh')
  process.env.DSH_DAEMON_AUTOREGEN = '0'
  process.env.DSH_DAEMON_NO_SYSTEM = '1'
  process.env.DSH_DAEMON_CLI_DIR = path.join(home, 'bin')

  const plugin = require(path.join(__dirname, '..', 'lib', 'index.js'))
  const mod = plugin && plugin.default ? plugin.default : plugin
  await mod.apply(ctx)

  const status = registered.find((t) => t.name === 'dsh_daemon_status')
  if (!status) throw new Error('dsh_daemon_status 未注册')
  await status.execute({}, {})                       // 内部多次 shell 调用

  if (calls.length === 0) throw new Error('shell.execute 一次都没被调用（是否仍走了 shell.run？）')
  if (!calls.every((c) => typeof c === 'string' && c.length > 0)) throw new Error('命令应为非空字符串')
  console.log(`shell-compat tests passed（0.2.x 形态：shell.execute 调用 ${calls.length} 次，未依赖 shell.run）`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch (e) {}
})().catch((e) => { console.error('shell-compat tests FAILED: ' + (e && e.stack || e)); process.exit(1) })
