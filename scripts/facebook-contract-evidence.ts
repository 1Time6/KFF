import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@kff/database';
import { digest, requireCondition } from '@kff/core';
import { adapterSourceHashes } from '../packages/core/src/artifacts';

const requiredTestFiles = [
  'tests/contracts/acquisition.test.ts',
  'tests/contracts/facebook-messenger.test.ts',
  'tests/contracts/facebook-browser-discovery.test.ts',
  'tests/contracts/browser-inbox.test.ts',
  'tests/contracts/facebook-browser-message.test.ts',
];

/**
 * Reads the shipped contract reports for one controller release and proves they describe the sources
 * actually installed. The installed package carries the report files and the contract test files, so
 * this check is the same one the developer checkout ran - merely re-executed against the installed
 * hashes. Nothing here claims a real platform call; the artifact stays CODE_CONTRACT_ONLY.
 */
export function facebookContractEvidence(root: string) {
  // A developer checkout keeps the run-check output under .kff/checks; the controller package ships
  // the same two reports under docs/evidence because the release manifest forbids any .kff/ entry.
  const packaged = [path.join(root, 'docs/evidence/contracts.json'), path.join(root, 'docs/evidence/contracts-results.json')];
  const checkout = [path.join(root, '.kff/checks/contracts.json'), path.join(root, '.kff/checks/contracts-results.json')];
  const [checkFile, reportFile] = packaged.every(existsSync) ? packaged : checkout;
  requireCondition(existsSync(checkFile) && existsSync(reportFile), 'CAPABILITY_UNASSESSED', '缺少随包合同报告，请使用完整控制端包');
  const result = JSON.parse(readFileSync(checkFile, 'utf8').replace(/^\uFEFF/, ''));
  const report = JSON.parse(readFileSync(reportFile, 'utf8').replace(/^\uFEFF/, ''));
  const hashes = adapterSourceHashes(root, 'facebook');
  requireCondition(result.exit_code === 0 && report.success && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTotalTests > 0 && report.testResults.some((value: { name: string; status: string }) => value.name.endsWith('facebook.test.ts') && value.status === 'passed'), 'CAPABILITY_UNASSESSED', '随包合同报告不完整');
  for (const [file, hash] of Object.entries(hashes)) requireCondition(result.source_hashes?.[file] === hash, 'VERSION_CONFLICT', '安装包源码与合同报告不一致：' + file);
  for (const file of ['tests/contracts/facebook.test.ts', ...requiredTestFiles]) {
    requireCondition(existsSync(path.join(root, file)), 'CAPABILITY_UNASSESSED', '缺少合同测试文件：' + file);
    requireCondition(result.source_hashes?.[file] === digest(readFileSync(path.join(root, file), 'utf8')), 'VERSION_CONFLICT', '安装包合同测试与报告不一致：' + file);
    requireCondition(report.testResults.some((row: { name: string; status: string }) => row.name.replaceAll('\\', '/').endsWith(file) && row.status === 'passed'), 'CAPABILITY_UNASSESSED', '缺少通过的合同报告：' + file);
  }
  const evidence = {
    kind: 'CODE_CONTRACT_ONLY', adapter_version: 'facebook-graph-v1', implementation_digest: digest(hashes), source_hashes: hashes,
    command: 'pnpm test:contracts', test_count: report.numTotalTests,
    facebook_test_count: report.testResults.find((value: { name: string }) => value.name.endsWith('facebook.test.ts')).assertionResults.length,
    exit_code: result.exit_code, started_at: result.started_at, ended_at: result.ended_at, real_calls: 0, real_verification: 'PENDING',
  };
  return { evidence, hashes };
}

export async function registerFacebookContractEvidence(root: string, options: { documentPath?: string } = {}) {
  const { evidence, hashes } = facebookContractEvidence(root);
  await query('INSERT INTO kff.adapter_artifacts(id,adapter_version,source_hashes,test_count,test_command,test_ended_at,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [evidence.implementation_digest, evidence.adapter_version, hashes, evidence.test_count, evidence.command, evidence.ended_at, evidence]);
  if (options.documentPath) {
    mkdirSync(path.dirname(options.documentPath), { recursive: true });
    writeFileSync(options.documentPath, JSON.stringify(evidence, null, 2) + '\n');
  }
  return { implementation_digest: evidence.implementation_digest, test_count: evidence.test_count, facebook_test_count: evidence.facebook_test_count };
}
