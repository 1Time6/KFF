// Probe frozen/legacy endpoints with EMPTY payloads. A zod validation error means
// the endpoint is wired and would work; an immediate policy refusal means the UI
// entry is a dead end that no user action can satisfy.
import {readFileSync} from 'node:fs';

const base = 'http://127.0.0.1:3000';
const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Origin': base},
  body: JSON.stringify({email: 'operator@kff.local', password: config.operator_password}),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map(v => v.split(';')[0]).join('; ');
if (!login.ok) { console.log('login failed', login.status); process.exit(1); }

const post = async (path, body = {}) => {
  const res = await fetch(base + '/api/' + path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Origin': base, Cookie: cookie},
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {path, status: res.status, body: text.slice(0, 200)};
};

// Empty payloads: cannot create anything, but reveals whether the route is gated.
const probes = [
  'orders', 'payments', 'refunds', 'products',
  'acquisition/monitors', 'tasks', 'environments', 'schedules',
  'collections', 'templates', 'contacts', 'inbox/channels',
];
console.log('=== POST with empty payload (validation vs policy gate) ===');
for (const p of probes) {
  const r = await post(p, {});
  console.log(String(r.status).padEnd(4), p.padEnd(22), r.body.replace(/\s+/g, ' '));
}
