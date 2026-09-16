// Log in through the real HTTP API and report what the UI actually receives.
// Read-only: only GET requests after login.
import {readFileSync} from 'node:fs';

const base = 'http://127.0.0.1:3000';
const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));

const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Origin': base},
  body: JSON.stringify({email: 'operator@kff.local', password: config.operator_password}),
});
console.log('login status =', login.status);
const cookie = (login.headers.getSetCookie?.() ?? []).map(v => v.split(';')[0]).join('; ');
console.log('cookie present =', cookie.length > 0);
if (!login.ok) {
  console.log('login body =', (await login.text()).slice(0, 300));
  process.exit(1);
}

const get = async path => {
  const res = await fetch(base + '/api/' + path, {headers: {Cookie: cookie}});
  if (!res.ok) return {__status: res.status, __body: (await res.text()).slice(0, 200)};
  return res.json();
};

const workspace = await get('workspace');
const real = (workspace.accounts ?? []).filter(a => !a.is_synthetic);
console.log('\n=== totals ===');
console.log('accounts total   =', (workspace.accounts ?? []).length);
console.log('accounts REAL    =', real.length);
console.log('environments     =', (workspace.environments ?? []).length);
console.log('can_manage       =', workspace.organization?.can_manage);
console.log('write enabled    =', workspace.can_write ?? workspace.organization?.can_write ?? 'n/a');

console.log('\n=== real accounts as the UI sees them ===');
for (const a of real) {
  const envs = (workspace.environments ?? []).filter(e => e.account_id === a.id);
  console.log(JSON.stringify({
    name: a.display_name, type: a.account_type, external_id: a.external_id, state: a.state,
    synthetic: a.is_synthetic,
    environments: envs.map(e => ({
      name: e.name, state: e.state,
      browser_configured: e.browser_configured,
      browser_status: e.browser_status,
      identity_check_state: e.identity_check_state,
    })),
  }));
}

const acq = await get('acquisition');
console.log('\n=== acquisition payload ===');
console.log('accounts  =', (acq.accounts ?? []).length, '| real =', (acq.accounts ?? []).filter(a => !a.is_synthetic).length);
console.log('monitors  =', (acq.monitors ?? []).length);
console.log('leads     =', (acq.leads ?? []).length);
console.log('readiness =', JSON.stringify(acq.readiness ?? {}));
