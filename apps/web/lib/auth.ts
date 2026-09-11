import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { query } from '@kff/database';
import { checkPassword, digest, requireCondition, AppError } from '@kff/core';
import { uuid, type Scope } from '@kff/contracts';

const origin = process.env.KFF_APP_ORIGIN ?? 'http://127.0.0.1:3000';
export function checkOrigin(request: Request) { requireCondition(request.headers.get('origin') === origin, 'FORBIDDEN_SCOPE', '请求来源不受信任', 403); }
export function localOnly(request: Request) {
  const host = request.headers.get('host');
  requireCondition(host === new URL(origin).host && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'FORBIDDEN_SCOPE', '本地登录仅允许在本机使用', 403);
}
function cookie(request: Request, key: string) { return (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(key + '='))?.slice(key.length + 1); }
export async function authenticate(request: Request): Promise<string> {
  if ((process.env.KFF_AUTH_MODE ?? 'local') === 'supabase') {
    const access = cookie(request, 'kff-access'); requireCondition(access, 'UNAUTHORIZED', '请先登录', 401);
    const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    requireCondition(url && key, 'AUTH_UNCONFIGURED', '身份服务尚未配置', 503);
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser(access);
    requireCondition(!error && data.user, 'UNAUTHORIZED', '登录已过期，请重新登录', 401); return data.user.id;
  }
  localOnly(request); const token = cookie(request, 'kff-session');
  requireCondition(token && /^[a-f0-9]{64}$/.test(token), 'UNAUTHORIZED', '请先登录', 401);
  const sessions = await query<{ user_id: string }>("SELECT s.user_id FROM kff.sessions s JOIN kff.local_users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.provider='local' AND s.expires_at>now() AND s.revoked_at IS NULL AND NOT u.disabled", [digest(token)]);
  requireCondition(sessions.length, 'UNAUTHORIZED', '登录已过期，请重新登录', 401); return sessions[0].user_id;
}
export async function requestScope(request: Request): Promise<Scope> {
  const userId = await authenticate(request); const brand = request.headers.get('x-kff-brand');
  if (brand) requireCondition(uuid.safeParse(brand).success, 'INVALID_INPUT', '品牌标识无效');
  const rows = await query<Scope>('SELECT user_id,organization_id,brand_id,role FROM kff.memberships WHERE user_id=$1 AND ($2::uuid IS NULL OR brand_id=$2) ORDER BY brand_id LIMIT 1', [userId, brand ?? null]);
  requireCondition(rows.length, 'FORBIDDEN_SCOPE', '当前账号没有此品牌权限', 403); return rows[0];
}
const failures = new Map<string, { count: number; expires: number }>();
export async function login(request: Request, email: string, password: string): Promise<string> {
  checkOrigin(request);
  const key = email.toLowerCase(); const bucket = failures.get(key);
  requireCondition(!bucket || bucket.expires < Date.now() || bucket.count < 8, 'RATE_LIMITED', '登录尝试过多，请稍后再试', 429);
  const fail = () => { failures.set(key, { count: bucket && bucket.expires > Date.now() ? bucket.count + 1 : 1, expires: Date.now() + 15 * 60000 }); throw new AppError('UNAUTHORIZED', '账号或密码不正确', 401); };
  const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
  if ((process.env.KFF_AUTH_MODE ?? 'local') === 'supabase') {
    const url = process.env.SUPABASE_URL; const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    requireCondition(url && publicKey, 'AUTH_UNCONFIGURED', '身份服务尚未配置', 503);
    const client = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return fail();
    failures.delete(key); return 'kff-access=' + data.session.access_token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + data.session.expires_in + secure;
  }
  localOnly(request);
  const user = (await query<{ id: string; password_hash: string }>('SELECT id,password_hash FROM kff.local_users WHERE lower(email)=$1 AND NOT disabled', [key]))[0];
  if (!user || !checkPassword(password, user.password_hash)) return fail();
  const token = randomBytes(32).toString('hex');
  await query("INSERT INTO kff.sessions(id_hash,user_id,provider,expires_at) VALUES($1,$2,'local',now()+interval '12 hours')", [digest(token), user.id]);
  failures.delete(key); return 'kff-session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + secure;
}
export async function logout(request: Request) {
  checkOrigin(request); const token = cookie(request, 'kff-session');
  if (token) await query('UPDATE kff.sessions SET revoked_at=now() WHERE id_hash=$1', [digest(token)]);
  const name = (process.env.KFF_AUTH_MODE ?? 'local') === 'supabase' ? 'kff-access' : 'kff-session';
  return name + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}
