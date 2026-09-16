import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { query, closePool, projectRoot } from '@kff/database';
import { digest, requireCondition } from '@kff/core';
import { adapterSourceHashes } from '../packages/core/src/artifacts';

const result = JSON.parse(readFileSync('.kff/checks/contracts.json', 'utf8'));
const report = JSON.parse(readFileSync('.kff/checks/contracts-results.json', 'utf8'));
const hashes = adapterSourceHashes(projectRoot, 'facebook');
requireCondition(result.exit_code === 0 && report.success && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTotalTests > 0 && report.testResults.some((value: { name: string; status: string }) => value.name.endsWith('facebook.test.ts') && value.status === 'passed'), 'CAPABILITY_UNASSESSED', '没有完整通过的 Facebook 合同报告');
for (const [file, hash] of Object.entries(hashes)) requireCondition(result.source_hashes?.[file] === hash, 'VERSION_CONFLICT', '代码已变化，需先回归当前适配器');
const testFile = 'tests/contracts/facebook.test.ts';
requireCondition(result.source_hashes?.[testFile] === digest(readFileSync(testFile, 'utf8')), 'VERSION_CONFLICT', '合同测试已变化');
for(const file of ['tests/contracts/acquisition.test.ts','tests/contracts/facebook-messenger.test.ts','tests/contracts/facebook-browser-discovery.test.ts','tests/contracts/browser-inbox.test.ts','tests/contracts/facebook-browser-message.test.ts']){
  requireCondition(report.testResults.some((row:{name:string;status:string})=>row.name.replaceAll('\\','/').endsWith(file)&&row.status==='passed'), 'CAPABILITY_UNASSESSED', '缺少社交互动或 Messenger 合同报告');
  requireCondition(result.source_hashes?.[file]===digest(readFileSync(file,'utf8')), 'VERSION_CONFLICT', '社交互动合同已变化');
}
const evidence = { kind: 'CODE_CONTRACT_ONLY', adapter_version: 'facebook-graph-v1', implementation_digest: digest(hashes), source_hashes: hashes, command: 'pnpm test:contracts', test_count: report.numTotalTests, facebook_test_count: report.testResults.find((value: { name: string }) => value.name.endsWith('facebook.test.ts')).assertionResults.length, exit_code: result.exit_code, started_at: result.started_at, ended_at: result.ended_at, real_calls: 0, real_verification: 'PENDING' };
await query('INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [evidence.implementation_digest, evidence.adapter_version, hashes, evidence.test_count, evidence.command, evidence.ended_at, evidence]);
await closePool(); mkdirSync('docs/evidence', { recursive: true }); writeFileSync('docs/evidence/facebook-contracts.json', JSON.stringify(evidence, null, 2) + '\n');
console.log('Recorded Facebook code contract evidence; real account verification remains pending.');
