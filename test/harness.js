// Test driver for dsh-daemon.
//
// Runs the REAL plugin code with a thin harness mock (real bash via
// child_process, real fs via node:fs) and invokes one registered tool for
// real. Supports both modes:
//
//   node test/harness.js <tool> [jsonArgs]      # static package mode
//   DYNAMIC=1 node test/harness.js <tool> [...] # dynamic sandbox mode
//
// Examples:
//   node test/harness.js dsh_daemon_status
//   DYNAMIC=1 node test/harness.js dsh_daemon_status
//   node test/harness.js dsh_daemon_install '{"port": 3080}'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const toolName = process.argv[2];
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};
if (!toolName) { console.error('usage: node test/harness.js <tool> [jsonArgs]'); process.exit(1); }

// ---- mock ctx -----------------------------------------------------------
const services = {
  shell: {
    resolve(request) { return { ...request, workdir: process.cwd(), timeoutMs: request.timeoutMs || 30000 }; },
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
  },
  fs: {
    async resolve(p) { return { path: p }; },
    async writeText(target, content) {
      const dir = path.dirname(target.path);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target.path, content, 'utf8');
      return { version: 'v1' };
    },
    async readText(target) { return fs.readFileSync(target.path, 'utf8'); },
    async stat(target) {
      try { const s = fs.statSync(target.path); return { size: s.size, mtime: s.mtime }; }
      catch (e) { return undefined; }
    },
    async listDir(target) { return fs.readdirSync(target.path).map((n) => ({ name: n })); },
  },
  timer: {
    timeout(ms) { return new Promise((r) => setTimeout(r, ms)); },
    interval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id); },
  },
  webServer: { port: 3080 },
  tools: {
    register(def) { registered.push(def); return () => {}; },
  },
};
const registered = [];
const ctx = {
  get(name) { return services[name]; },
  on() { return () => {}; },
  effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {}; },
  provide() { return () => {}; },
  timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ---- load the plugin in the requested mode -------------------------------
let plugin;
if (process.env.DYNAMIC === '1') {
  // dynamic sandbox mode: evaluate lib/index.js as a function body with a
  // `harness` global, exactly like the DSH cordis host runner does.
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  const mockHarness = {
    defineTool(def) {
      if (!def || typeof def.execute !== 'function') throw new Error('bad tool def');
      if (!def.output || typeof def.output.render !== 'function') throw new Error('bad output');
      return def;
    },
    registerTool(ctx2, def) { registered.push(def); return () => {}; },
  };
  plugin = new Function('ctx', 'harness', src)(ctx, mockHarness);
} else {
  // static package mode: require the package like a DSH composition row does.
  delete require.cache[require.resolve(path.join(root, 'lib', 'index.js'))];
  plugin = require(path.join(root, 'lib', 'index.js'));
  if (plugin && plugin.default) plugin = plugin.default;
}

if (!plugin || typeof plugin.apply !== 'function') { console.error('plugin did not expose apply()'); process.exit(1); }
plugin.apply(ctx);

const tool = registered.find((t) => t.name === toolName);
if (!tool) {
  console.error('tool not found: ' + toolName + ' (have: ' + registered.map((t) => t.name).join(', ') + ')');
  process.exit(1);
}
tool.execute(toolArgs, {}).then((v) => { console.log(String(v)); }).catch((e) => {
  console.error('EXECUTE FAILED: ' + (e && e.stack || e));
  process.exit(1);
});
