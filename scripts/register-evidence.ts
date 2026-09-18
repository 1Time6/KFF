import { closePool, projectRoot } from '@kff/database';
import path from 'node:path';
import { registerFacebookContractEvidence } from './facebook-contract-evidence';

const result = await registerFacebookContractEvidence(projectRoot, { documentPath: path.join(projectRoot, 'docs/evidence/facebook-contracts.json') });
await closePool();
console.log('Recorded Facebook code contract evidence; real account verification remains pending. ' + JSON.stringify(result));
