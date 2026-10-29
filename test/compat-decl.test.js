// compat-decl tests (v0.1.29)
//
// Why this exists as a CI gate: from 0.1.29 on, the updater REFUSES to apply an
// update automatically when the new version does not declare `dsh.requires.dsh`
// (conservative policy — an undeclared range means "cannot verify"). That makes
// the declaration load-bearing: forget it in one release and every 0.1.29+
// client silently stops auto-updating. This is a static, side-effect-free check
// so it can run in CI on every publish.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [ok]   ' + name); return; }
  failures += 1;
  console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  -> ' + extra));
}

const range = pkg.dsh && pkg.dsh.requires && pkg.dsh.requires.dsh;
check('package.json 声明了 dsh.requires.dsh（更新门禁依赖它）', typeof range === 'string' && range.length > 0, JSON.stringify(pkg.dsh));
check('compat 声明与 dsh.bundle 并存（不破坏 dsh 插件的 bundle 读取）',
  !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml'), JSON.stringify(pkg.dsh && pkg.dsh.bundle));
check('模板内联了区间判定函数', src.includes('dshRangeSatisfied.toString()') && src.includes('function dshRangeSatisfied(version, range)'));
check('更新检查在读 manifest 的 dsh.requires.dsh', src.includes('body.dsh.requires.dsh'));
check('三种「不自动升级」状态都存在',
  src.includes("'incompatible'") && src.includes("'unknown-dsh'") && src.includes("'unverified-compat'"));
check('自动路径不带 force，只有 --apply 带 force',
  src.includes('checkUpdate(true, true)') && src.includes("'async function checkUpdate(apply, force) {"));

// 实际把声明的区间套一遍：至少要能判定当前主流 dsh 版本，且下界之前的版本被拒。
const fnStart = src.indexOf('function dshRangeSatisfied');
const fnEnd = src.indexOf('function extractTokenUrl', fnStart);
const dshRangeSatisfied = new Function(src.slice(fnStart, fnEnd) + '\nreturn dshRangeSatisfied;')();
check('声明的区间对 0.2.1-rc.2 判定为满足', dshRangeSatisfied('0.2.1-rc.2', range) === true, range);
check('声明的区间拒绝 0.1.1', dshRangeSatisfied('0.1.1', range) === false, range);
check('声明的区间拒绝 0.3.0', dshRangeSatisfied('0.3.0', range) === false, range);

console.log(failures ? `\nFAILED (${failures})` : '\ncompat-decl tests passed (published package must declare dsh.requires.dsh)');
process.exit(failures ? 1 : 0);
