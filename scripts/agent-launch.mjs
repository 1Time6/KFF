import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const release = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-root': { type: 'string' }, config: { type: 'string' } } });
const [command = 'help'] = positionals;
if (positionals.length > 1 || !['help', 'verify', 'start', 'install-browser'].includes(command)) throw new Error('Use agent.cmd help');
if (command === 'help') {
  console.log('agent.cmd verify\nagent.cmd start --data-root C:\\KFF-Agent-Data [--config .kff\\pairings\\second.json]\nagent.cmd install-browser\nKeep the same data root when changing release folders. See README.md.');
} else {
  const manifest = JSON.parse(readFileSync(path.join(release, 'release.json'), 'utf8'));
  if (manifest.schema_version !== 'kff.agent-release.v1' || manifest.protocol_version !== 'kff.agent.v1' || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.node_version !== process.versions.node) throw new Error('RELEASE_RUNTIME_MISMATCH');
  const seen = new Set();
  function verify(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('RELEASE_LINK_NOT_ALLOWED');
      if (entry.isDirectory()) verify(file, relative + '/');
      else {
        if (!lstatSync(file).isFile()) throw new Error('RELEASE_FILE_INVALID');
        if (relative === 'release.json') continue;
        if (createHash('sha256').update(readFileSync(file)).digest('hex') !== manifest.files[relative]) throw new Error('RELEASE_HASH_MISMATCH: ' + relative);
        seen.add(relative);
      }
    }
  }
  verify(release);
  if (Object.keys(manifest.files).length !== seen.size) throw new Error('RELEASE_FILE_MISSING');
  if (command === 'verify') console.log(JSON.stringify({ release_id: manifest.release_id, verified_files: seen.size, protocol_version: manifest.protocol_version }));
  else if (command === 'install-browser') execFileSync(process.execPath, [path.join(release, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: release, windowsHide: true, stdio: 'inherit' });
  else {
    if (!values['data-root'] || !path.isAbsolute(values['data-root'])) throw new Error('ABSOLUTE_DATA_ROOT_REQUIRED');
    const dataRoot = realpathSync(values['data-root']);
    const relative = path.relative(release, dataRoot);
    if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('DATA_ROOT_MUST_BE_OUTSIDE_RELEASE');
    process.env.KFF_ROOT = dataRoot;
    if (values.config) process.env.KFF_AGENT_CONFIG_FILE = path.resolve(dataRoot, values.config);
    else delete process.env.KFF_AGENT_CONFIG_FILE;
    // Explicit data/config arguments select the pairing. A caller's dev overrides must not reroute it.
    delete process.env.KFF_AGENT_TOKEN; delete process.env.KFF_APP_ORIGIN; delete process.env.TSX_TSCONFIG_PATH;
    process.chdir(release);
    const { register } = await import('tsx/esm/api');
    register({ tsconfig: path.join(release, 'tsconfig.json') });
    await import(pathToFileURL(path.join(release, 'apps/agent/src/main.ts')).href);
  }
}
