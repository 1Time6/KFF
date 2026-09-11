import { commitCollectionPage, type CollectionClaim } from '../../packages/core/src/collections';
import { query, closePool } from '../../packages/database/src/index';

const database = (await query('SELECT current_database() AS name'))[0].name;
if (database !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(database)) throw new Error('Isolated test database required');
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')) as { claim: CollectionClaim; page: unknown; boundary: 'before' | 'after' };
setInterval(() => {}, 1000);
await commitCollectionPage(input.claim, input.page, input.boundary === 'before' ? async () => { process.send?.({ barrier: 'before' }); await new Promise<void>(() => {}); } : undefined);
await closePool(); process.send?.({ barrier: 'after' });
