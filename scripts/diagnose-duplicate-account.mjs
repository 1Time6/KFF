// Does re-registering an existing Facebook account produce a clear message, or a raw
// database constraint error? Uses a throwaway synthetic id so no real data is touched.
import {readFileSync} from 'node:fs';

const base = 'http://127.0.0.1:3000';
const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Origin': base},
  body: JSON.stringify({email: 'operator@kff.local', password: config.operator_password}),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map(v => v.split(';')[0]).join('; ');

// An existing REAL account id, reused on purpose to trigger the unique constraint.
const existingExternalId = '61594402378582'; // 白青天

const create = async label => {
  const res = await fetch(base + '/api/accounts', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Origin': base, Cookie: cookie},
    body: JSON.stringify({
      display_name: 'DIAGNOSTIC 重复登记检查 ' + label,
      external_id: existingExternalId,
      platform: 'facebook',
      account_type: 'profile',
    }),
  });
  const text = await res.text();
  console.log(label.padEnd(22), 'HTTP', res.status, '->', text.replace(/\s+/g, ' ').slice(0, 220));
};

console.log('=== registering an already-registered Facebook id ===');
await create('first attempt');
await create('second attempt');

console.log('\n=== invalid platform id (letters) ===');
const bad = await fetch(base + '/api/accounts', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Origin': base, Cookie: cookie},
  body: JSON.stringify({display_name: 'DIAGNOSTIC 非法ID', external_id: 'abc123', platform: 'facebook', account_type: 'profile'}),
});
console.log('HTTP', bad.status, '->', (await bad.text()).replace(/\s+/g, ' ').slice(0, 220));
