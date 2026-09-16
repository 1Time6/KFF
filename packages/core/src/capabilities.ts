import { scoped, projectRoot } from '@kff/database';
import type { Capability, Scope } from '@kff/contracts';
import { requireCondition } from './index';
import { adapterImplementationDigest } from './artifacts';
import { audit, requireAdmin } from './service';

export async function attachLocalEvidence(scope: Scope, capabilityId: string) {
  requireAdmin(scope); return scoped(scope, async client => {
    const capability = (await client.query<Capability>('SELECT * FROM kff.capabilities WHERE id=$1 FOR UPDATE', [capabilityId])).rows[0];
    requireCondition(capability && !capability.is_synthetic && ['facebook-browser-comment-v1','facebook-browser-messenger-v1','facebook-inbox-browser-v1','facebook-search-browser-v1','facebook-graph-v1','facebook-messenger-v1','social-outreach-v1','instagram-graph-v1'].includes(capability.adapter_version), 'NOT_FOUND', '未找到此 Facebook 能力', 404);
    requireCondition(['UNASSESSED', 'FEASIBLE', 'IMPLEMENTED_TEST_ONLY'].includes(capability.evidence_state), 'VERSION_CONFLICT', '此状态不能由本地合同覆盖', 409);
    const hash = adapterImplementationDigest(projectRoot, 'facebook');
    const artifact = (await client.query('SELECT * FROM kff.adapter_artifacts WHERE id=$1 AND adapter_version=$2', [hash, 'facebook-graph-v1'])).rows[0];
    requireCondition(artifact, 'CAPABILITY_UNASSESSED', '当前代码缺少已登记的合同报告，请先运行合同测试和证据登记脚本', 409);
    await client.query('INSERT INTO kff.capability_checks(organization_id,brand_id,capability_id,artifact_id,recorded_by) VALUES($1,$2,$3,$4,$5)', [scope.organization_id, scope.brand_id, capabilityId, artifact.id, scope.user_id]);
    await client.query("UPDATE kff.capabilities SET evidence_state='IMPLEMENTED_TEST_ONLY',mode='CONTROLLED_PILOT',implementation_digest=$1 WHERE id=$2", [artifact.id, capabilityId]);
    await audit(client, scope, 'capability.local_evidence_attached', capabilityId, { artifact_id: artifact.id, real_verification: 'PENDING' }); return { attached: true, evidence_state: 'IMPLEMENTED_TEST_ONLY', real_verification: 'PENDING' };
  });
}
