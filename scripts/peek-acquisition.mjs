// Locate the outreach and automation render sites after my edits shifted line numbers.
import {readFileSync} from 'node:fs';

const file = 'apps/web/components/acquisition-workbench.tsx';
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const needles = ['准备获客动作', '为此监控配置自动执行', 'aria-label="准备获客动作"'];
for (const n of needles) {
  const idx = lines.findIndex(l => l.includes(n));
  console.log('=== ' + n + ' -> line ' + (idx + 1) + ' ===');
  if (idx >= 0) console.log(lines[idx].slice(0, 420));
  console.log();
}
