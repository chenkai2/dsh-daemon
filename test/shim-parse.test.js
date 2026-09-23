'use strict';
// Unit tests for parseShimTarget() in lib/index.js: following a pnpm global
// bin shim to the real JS entry. The daemon spawns `node <DSH_BIN> web`, so a
// pnpm shim (a POSIX sh script, NOT npm's node-script symlink) would be
// executed as JavaScript and crash with a SyntaxError before dsh web starts.
// discover() must resolve the shim to the .js file it execs.
//
// The fixtures below are the actual shim formats pnpm writes:
//   - pnpm >= 9.15: shims carry an absolute `# cmd-shim-target=` comment
//     (verified against pnpm 10 on Linux: ~/.local/share/pnpm/bin/*)
//   - older cmd-shim format: every exec branch quotes the target after the
//     node invocation, relative to $basedir (sh) or %dp0% (.cmd on Windows)
const path = require('node:path');
const assert = require('node:assert');

process.env.DSH_DAEMON_TEST_HOOK = '1';
const root = path.join(__dirname, '..');
delete require.cache[require.resolve(path.join(root, 'lib', 'index.js'))];
const plugin = require(path.join(root, 'lib', 'index.js'));
const { parseShimTarget } = plugin.__test;

assert.ok(parseShimTarget, 'test hook not exported (DSH_DAEMON_TEST_HOOK=1 must be set)');

// ---- pnpm >= 9.15: absolute marker line wins ------------------------------
const pnpmV10Shim = [
  '#!/bin/sh',
  '# Resolve $0 through symlinks so basedir is the shim\'s real directory.',
  'link="$0"',
  'hops=0',
  'while [ -L "$link" ] && [ "$hops" -lt 40 ]; do',
  '  hops=$((hops+1))',
  '  target=$(readlink "$link")',
  '  case "$target" in',
  '    /*) link="$target" ;;',
  '    *)  link="$(dirname "$link")/$target" ;;',
  '  esac',
  'done',
  'basedir=$(dirname "$(echo "$link" | sed -e \'s,\\\\,/,g\')")',
  'basedir_win="$basedir"',
  '',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "$basedir/../global/v11/6a01ad/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  'elif command -v node >/dev/null 2>&1; then',
  '  exec node  "$basedir/../global/v11/6a01ad/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  'fi',
  '# cmd-shim-target=/home/user/.local/share/pnpm/global/v11/6a01ad/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '',
].join('\n');
assert.strictEqual(
  parseShimTarget(pnpmV10Shim, '/home/user/.local/share/pnpm/bin'),
  '/home/user/.local/share/pnpm/global/v11/6a01ad/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'pnpm >= 9.15 shim should resolve through the cmd-shim-target marker');

// ---- older sh shim: $basedir-relative exec target --------------------------
// Real cmd-shim files quote the SAME target in both branches (only the node
// invocation differs), so whichever branch matches resolves identically.
const cmdShimPosix = [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  '',
  'case `uname` in',
  '    *CYGWIN*|*MINGW*|*MSYS*) basedir=`cygpath -w "$basedir"`;;',
  'esac',
  '',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "$basedir/../global/5/.pnpm/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  'else',
  '  exec node  "$basedir/../global/5/.pnpm/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  'fi',
  '',
].join('\n');
assert.strictEqual(
  parseShimTarget(cmdShimPosix, '/home/user/.local/share/pnpm'),
  '/home/user/.local/share/pnpm/../global/5/.pnpm/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'old sh shim should resolve $basedir-relative exec target against the shim dir');

// $basedir_win variant (win32 branch of the same shim family).
const cmdShimWinRef = [
  '#!/bin/sh',
  'basedir=$(dirname "$0")',
  'basedir_win="$basedir"',
  'if [ -x "$basedir/node.exe" ]; then',
  '  exec "$basedir/node.exe"  "$basedir_win/../global/v11/abc/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"',
  'fi',
].join('\n');
assert.strictEqual(
  parseShimTarget(cmdShimWinRef, '/home/u/.local/share/pnpm/bin'),
  '/home/u/.local/share/pnpm/bin/../global/v11/abc/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '$basedir_win-relative target should resolve like $basedir');

// ---- Windows .cmd shim: %dp0%-relative target -------------------------------
const cmdShimCmd = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\global\\v11\\6a01ad\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
  '',
].join('\r\n');
assert.strictEqual(
  parseShimTarget(cmdShimCmd, 'C:/Users/u/AppData/Local/pnpm'),
  'C:/Users/u/AppData/Local/pnpm/../global/v11/6a01ad/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '.cmd shim should resolve %dp0%-relative target with forward slashes');

// ---- non-shims must return null (no behaviour change for npm installs) ----
const jsBin = [
  '#!/usr/bin/env node',
  'const { main } = require(\'../dist/cli.js\');',
  'main(process.argv.slice(2));',
  '',
].join('\n');
assert.strictEqual(parseShimTarget(jsBin, '/usr/lib/node_modules/@deepseek-ai/dsh/lib'),
  null, 'a node-shebang JS bin is not a shim');
assert.strictEqual(parseShimTarget('', '/x'), null, 'empty text is not a shim');
assert.strictEqual(parseShimTarget(null, '/x'), null, 'null text is not a shim');
assert.strictEqual(parseShimTarget('#!/bin/sh\necho hi\n', '/x'),
  null, 'a sh script without a JS target is not a resolvable shim');

// Marker must be absolute to be trusted; a relative one falls through to
// the exec regex instead of producing a bogus path.
assert.strictEqual(
  parseShimTarget('# cmd-shim-target=relative/bin.js\nexec node "x/bin.js" "$@"\n', '/shim/dir'),
  '/shim/dir/x/bin.js',
  'non-absolute marker should be ignored in favour of the exec target');

console.log('shim-parse tests passed (marker, $basedir, %dp0%, non-shim guards)');
