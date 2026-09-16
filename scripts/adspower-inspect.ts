import path from 'node:path';
import { AdsPowerClient } from '../packages/adapters/src/browser-profile';
import { browserProviderEnvironment } from '../apps/agent/src/browser-provider-configuration';
import { AppError } from '../packages/core/src/index';

// Read-only: serial_number is the API's numeric "编号", not the editable UI sequence/name.
const serialNumber = process.argv[2];
if (process.argv.length > 3 || serialNumber && !/^[0-9]{1,12}$/.test(serialNumber)) throw new Error('Usage: node --import tsx scripts/adspower-inspect.ts [serial_number]');
try {
  const client = new AdsPowerClient(browserProviderEnvironment(path.resolve('.')));
  const health = await client.health();
  console.log(JSON.stringify({ health, profiles: await client.listProfiles({ serialNumber }), inspected_at: new Date().toISOString() }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof AppError ? error.code : 'AGENT_CONFIGURATION_INVALID', inspected_at: new Date().toISOString() }));
  process.exitCode = 1;
}
