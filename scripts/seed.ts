import { pathToFileURL } from 'node:url';
import { transaction, initializeLocalConfig, closePool } from '@kff/database';
import { digest, hashPassword, requireCondition } from '@kff/core';

export const localIds = { organization: '11111111-1111-4111-8111-111111111111', brand: '22222222-2222-4222-8222-222222222222', user: '33333333-3333-4333-8333-333333333333', account: '44444444-4444-4444-8444-444444444444', environment: '55555555-5555-4555-8555-555555555555', agent: '66666666-6666-4666-8666-666666666666', read: '77777777-7777-4777-8777-777777777777', publish: '88888888-8888-4888-8888-888888888888' };
export async function seed() {
  const config = initializeLocalConfig();
  requireCondition(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? config.database_url).hostname), 'FORBIDDEN_SCOPE', '合成数据仅允许写入本地开发数据库');
  await transaction(async client => {
    await client.query("INSERT INTO kff.organizations(id,name) VALUES($1,'KFF 本地开发') ON CONFLICT DO NOTHING", [localIds.organization]);
    await client.query("INSERT INTO kff.organization_memberships(organization_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING", [localIds.organization, localIds.user]);
    await client.query("INSERT INTO kff.brands(id,organization_id,name) VALUES($1,$2,'开发工作区') ON CONFLICT DO NOTHING", [localIds.brand, localIds.organization]);
    await client.query("INSERT INTO kff.local_users(id,email,password_hash) VALUES($1,'operator@kff.local',$2) ON CONFLICT DO NOTHING", [localIds.user, hashPassword(config.operator_password)]);
    await client.query("INSERT INTO kff.memberships(user_id,organization_id,brand_id,role) VALUES($1,$2,$3,'admin') ON CONFLICT DO NOTHING", [localIds.user, localIds.organization, localIds.brand]);
    await client.query("INSERT INTO kff.accounts(id,organization_id,brand_id,display_name,platform,account_type,external_id,state,is_synthetic) VALUES($1,$2,$3,'本地验证主页','kff','page','100000000000000001','ACTIVE',true) ON CONFLICT DO NOTHING", [localIds.account, localIds.organization, localIds.brand]);
    await client.query("INSERT INTO kff.agents(id,organization_id,brand_id,name,token_hash,status) VALUES($1,$2,$3,'本机开发 Agent',$4,'PAIRED') ON CONFLICT DO NOTHING", [localIds.agent, localIds.organization, localIds.brand, digest(config.agent_token)]);
    await client.query("INSERT INTO kff.environments(id,organization_id,brand_id,name,account_id,agent_id) VALUES($1,$2,$3,'隔离验证环境',$4,$5) ON CONFLICT DO NOTHING", [localIds.environment, localIds.organization, localIds.brand, localIds.account, localIds.agent]);
    for (const [action, id] of [['read', localIds.read], ['publish', localIds.publish]]) await client.query("INSERT INTO kff.capabilities(id,organization_id,brand_id,account_id,capability_key,adapter_version,evidence_state,mode,is_synthetic,description) VALUES($1,$2,$3,$4,$5,'fixture-page-v1','FEASIBLE','TEST_ONLY',true,$6) ON CONFLICT DO NOTHING", [id, localIds.organization, localIds.brand, localIds.account, 'kff.fixture.page.' + action + '.browser', action === 'read' ? '在本项目合成页面读取主页身份，用于验证执行链' : '在本项目合成页面发布文本并回读结果，不产生 Facebook 动作']);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { await seed(); await closePool(); console.log('Local development identity and synthetic environment ready.'); }
