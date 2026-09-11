import { enqueueTask } from '../../packages/core/src/service';
import { query, closePool } from '../../packages/database/src/index';
import { localIds } from '../../scripts/seed';
import { uuid } from '../../packages/contracts/src/index';

const database = (await query('SELECT current_database() AS name'))[0].name;
if (database !== process.env.KFF_TEST_DATABASE || !/^kff_test_[a-f0-9]{20}$/.test(database)) throw new Error('Isolated test database required');
const run = await enqueueTask({ organization_id: localIds.organization, brand_id: localIds.brand, user_id: localIds.user, role: 'admin' }, uuid.parse(process.argv[2]));
await closePool(); process.send?.({ type: 'committed', run_id: run.id });
// Keep the caller alive at the post-commit/pre-response crash boundary selected by its test.
setInterval(() => {}, 1000);
