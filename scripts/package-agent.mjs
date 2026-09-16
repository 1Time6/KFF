import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHash } from './source-hash.mjs';

// Copy the installed, locked dependency closure. Never copy the workspace or its runtime directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Build requires Windows x64 and Node 22 or newer');
const sources = ['packages/core/src/index.ts', 'packages/core/src/artifacts.ts'];
for (const directory of ['apps/agent/src', 'packages/contracts/src', 'packages/adapters/src', 'packages/database/src']) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) throw new Error('Unexpected source entry: ' + directory + '/' + entry.name);
    sources.push(directory + '/' + entry.name);
  }
}
const licenseFile = `scripts/licenses/node-v${process.versions.node}.txt`;
if (!existsSync(path.join(root, licenseFile))) throw new Error('Add the official license for this exact Node version before packaging: ' + licenseFile);
const sourceHashes = Object.fromEntries([...sources, licenseFile, 'scripts/package-agent.mjs', 'scripts/source-hash.mjs', 'scripts/agent-launch.mjs', 'docs/api/agent-delivery.md', 'package.json', 'tsconfig.json', 'pnpm-lock.yaml'].sort().map(file => [file, sourceHash(path.join(root, file))]));
const nodeHash = hash(readFileSync(process.execPath));
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
const nodeLicense = readFileSync(path.join(root, licenseFile), 'utf8');
if (!nodeLicense.startsWith('Node.js is licensed for use as follows:')) throw new Error('Unexpected Node license response');
const version = json(path.join(root, 'package.json')).version;
const releaseId = `kff-agent-${version}-win32-x64-${hash(JSON.stringify({ sourceHashes, nodeHash, nodeLicense: hash(nodeLicense) })).slice(0, 12)}`;
const destination = path.join(root, 'dist', releaseId);
if (existsSync(destination) || existsSync(destination + '.zip')) throw new Error('Release already exists; keep it immutable: ' + destination);
mkdirSync(destination, { recursive: true });
const copy = (source, relative) => {
  if (!lstatSync(source).isFile()) throw new Error('Only regular files can be packaged: ' + relative);
  const target = path.join(destination, relative); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target);
};
for (const file of sources) copy(path.join(root, file), file);
copy(process.execPath, 'node.exe');
writeFileSync(path.join(destination, 'NODE-LICENSE.txt'), nodeLicense);
copy(path.join(root, 'scripts/agent-launch.mjs'), 'agent-launch.mjs');
copy(path.join(root, 'docs/api/agent-delivery.md'), 'README.md');
const compilerOptions = json(path.join(root, 'tsconfig.json')).compilerOptions;
writeFileSync(path.join(destination, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: compilerOptions.target, module: compilerOptions.module, moduleResolution: compilerOptions.moduleResolution, baseUrl: '.', paths: compilerOptions.paths } }, null, 2));
writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name: 'kff-agent-portable', version, private: true, type: 'module' }, null, 2));
writeFileSync(path.join(destination, 'agent.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0agent-launch.mjs" %*\r\nexit /b %errorlevel%\r\n');
const dependencies = new Map();
function packageRoot(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  try { return path.dirname(require.resolve(name + '/package.json')); }
  catch {
    let directory = path.dirname(require.resolve(name));
    while (directory !== path.dirname(directory)) {
      if (existsSync(path.join(directory, 'package.json')) && json(path.join(directory, 'package.json')).name === name) return directory;
      directory = path.dirname(directory);
    }
    throw new Error('Cannot locate dependency: ' + name);
  }
}
function copyTree(source, relative) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) throw new Error('Package contains an unhandled link: ' + entry.name);
    if (entry.isDirectory()) copyTree(path.join(source, entry.name), relative + '/' + entry.name);
    else copy(path.join(source, entry.name), relative + '/' + entry.name);
  }
}
function dependency(name, from, optional = false) {
  let directory;
  try { directory = realpathSync(packageRoot(name, from)); }
  catch (error) { if (optional) return; throw error; }
  const metadata = json(path.join(directory, 'package.json'));
  const allowed = (list, value) => !list || !list.includes('!' + value) && (list.every(item => item.startsWith('!')) || list.includes(value));
  if (!allowed(metadata.os, process.platform) || !allowed(metadata.cpu, process.arch)) { if (optional) return; throw new Error('Unsupported dependency: ' + name); }
  if (dependencies.has(name)) {
    if (dependencies.get(name) !== metadata.version) throw new Error('Conflicting dependency versions: ' + name);
    return;
  }
  dependencies.set(name, metadata.version); copyTree(directory, 'node_modules/' + name);
  for (const child of Object.keys(metadata.dependencies ?? {})) dependency(child, directory, Boolean(metadata.optionalDependencies?.[child]));
  for (const child of Object.keys(metadata.optionalDependencies ?? {})) dependency(child, directory, true);
}
for (const name of ['tsx', '@playwright/test', 'zod', 'pg', '@js-temporal/polyfill']) dependency(name, root);
const files = {};
function inventory(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) inventory(path.join(directory, entry.name), relative + '/');
    else files[relative] = hash(readFileSync(path.join(directory, entry.name)));
  }
}
inventory(destination);
const manifest = { schema_version: 'kff.agent-release.v1', release_id: releaseId, version, platform: process.platform, arch: process.arch, node_version: process.versions.node, node_license_source: licenseUrl, protocol_version: 'kff.agent.v1', local_supervision_protocol: 'kff.local-supervision.v1', guardian_protocol_version: 'kff.guardian-closure.v1', guardian_closure_versions: ['kff.guardian-closure.v1','kff.guardian-closure-compact.v1'], created_at: new Date().toISOString(), source_hashes: sourceHashes, dependencies: Object.fromEntries(dependencies), files };
writeFileSync(path.join(destination, 'release.json'), JSON.stringify(manifest, null, 2));
execFileSync(path.join(destination, 'node.exe'), [path.join(destination, 'agent-launch.mjs'), 'verify'], { cwd: destination, windowsHide: true, stdio: 'inherit' });
execFileSync('tar.exe', ['-a', '-c', '-f', destination + '.zip', '-C', path.dirname(destination), releaseId], { windowsHide: true });
const result = { release_id: releaseId, directory: destination, archive: destination + '.zip', archive_sha256: hash(readFileSync(destination + '.zip')), files: Object.keys(files).length, dependencies: dependencies.size, contains_pairing_or_browser_data: false };
writeFileSync(destination + '.zip.sha256', result.archive_sha256 + '  ' + releaseId + '.zip\n');
console.log(JSON.stringify(result));
