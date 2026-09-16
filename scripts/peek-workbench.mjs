// Extract the exact substrings needed for a safe edit (PowerShell butchers CJK in paths).
import {readFileSync} from 'node:fs';

const file = 'apps/web/components/workbench.tsx';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const l158 = lines[157];
for (const marker of ['<Field label="执行环境"', '<Field label="执行动作"']) {
  const i = l158.indexOf(marker);
  console.log('=== ' + marker + ' @ ' + i + ' ===');
  console.log(i < 0 ? '(not found)' : l158.slice(i, i + 520));
  console.log();
}
