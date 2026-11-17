'use strict';
// dsh 0.2.2-rc.3 turned every registered web route into an auth-gated route.
//
// The web server's policy accessor is
//     authPolicy(auth, request) { return typeof auth === 'function' ? auth(request) : auth ?? 'required'; }
// with WebAuthPolicy = 'anonymous' | 'required' | 'deny'. So a route that omits
// `auth` is 'required': a cookie-less GET gets 401. Both routes this plugin owns
// are probed by the watchdog with no cookie at all:
//
//   GET /health              -> the daemon health probe (a 401 there made the
//                               watchdog treat the web as permanently down and
//                               restart-storm it — every restart a new auth
//                               generation and therefore another browser tab)
//   GET /dsh-daemon/activity  -> the update idle-window probe (a 401 makes the
//                               updater believe dsh web is unreachable and defer
//                               every restart by DEFER_MAX_MS)
//
// Both must therefore declare `auth: 'anonymous'` — the same opt-out core
// plugins use (authentication-token's CONNECT_PATH, hmr, modules). This test is
// deliberately source-level and instant: it is the publish gate for a bug whose
// only other symptom appears 5 minutes later on a user's desktop as a stream of
// browser tabs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  [ok]   ' + name); return; }
  failures += 1;
  console.log('  [FAIL] ' + name + (extra === undefined ? '' : '  -> ' + extra));
}

// ---- every ws.register({...}) route object must declare `auth` explicitly ---
// Captures the object literal body from `ws.register({` up to the closing `}))`
// so a newly added cookie-less route cannot silently inherit 'required' again.
const routes = [];
const re = /ws\.register\(\{([\s\S]*?)\n\s*\}\)\)/g;
let m;
while ((m = re.exec(src)) !== null) {
  const body = m[1];
  const pathMatch = body.match(/path:\s*'([^']+)'/);
  routes.push({ path: pathMatch ? pathMatch[1] : '<unknown>', body });
}
check('found the plugin\'s web routes (ws.register({...}))', routes.length >= 2,
  'routes=' + JSON.stringify(routes.map((r) => r.path)));

for (const route of routes) {
  check('route ' + route.path + ' declares auth explicitly',
    /auth:\s*'anonymous'/.test(route.body),
    'omitting auth means WebAuthPolicy "required" => 401 to the cookie-less watchdog probe');
}

// ---- health route: exact 200 JSON, anonymously readable -------------------
const healthRoute = routes.find((r) => r.path === '/health');
check('the /health route exists', !!healthRoute);
check('/health answers 200 JSON', !!healthRoute && /writeHead\(200/.test(healthRoute.body));
check('/health is anonymous (the watchdog probe sends no cookie)',
  !!healthRoute && /auth:\s*'anonymous'/.test(healthRoute.body));

// ---- activity route: same fence opt-out ----------------------------------
const activityRoute = routes.find((r) => r.path === '/dsh-daemon/activity');
check('the /dsh-daemon/activity route exists', !!activityRoute);
check('/dsh-daemon/activity is anonymous (the idle-window probe sends no cookie)',
  !!activityRoute && /auth:\s*'anonymous'/.test(activityRoute.body));

// ---- the reason is documented, so a later cleanup does not undo it --------
check('source documents why auth is required (0.2.2-rc.3 / authPolicy)',
  /0\.2\.2-rc\.3/.test(src) && /authPolicy/.test(src),
  'the comment is the only thing stopping a future "cleanup" from dropping the option');

console.log('');
if (failures) { console.log('health-route-auth tests FAILED (' + failures + ')'); process.exit(1); }
console.log('health-route-auth tests passed (both cookie-less routes opt out of the auth fence)');
