import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, serialFixture } from './serial-git.js';

export function parallelPlan(f: ReturnType<typeof serialFixture>, agent = { model: 'mock', effort: 'low' }) {
  const files = {
    'price.mjs': 'export const price = () => 100;\n',
    'view.mjs': "import { price } from './price.mjs'; export const view = () => String(price());\n",
    'checks.mjs': `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { price } from './price.mjs';
import { view } from './view.mjs';
const names = process.argv.slice(2);
for (const name of names) {
  if (name === 'A') assert.equal(readFileSync('a.txt', 'utf8').trim(), 'alpha');
  else if (name === 'B') assert.equal(readFileSync('b.txt', 'utf8').trim(), 'beta');
  else if (name === 'C') assert.deepEqual(price(), { amount: 100, currency: 'JPY' });
  else if (name === 'D') assert.equal(view(), 'JPY 90');
  else if (name === 'integration') { assert.equal(Number.isFinite(typeof price() === 'number' ? price() : price().amount), true); if (names.includes('D')) assert.equal(view(), 'JPY 90'); }
  else throw new Error('unknown check');
}
console.log('passed: ' + names.join(','));
`
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(f.repository, file), text);
  git(f.repository, 'add', '.'); git(f.repository, 'commit', '-m', 'parallel scenario baseline'); git(f.repository, 'push', 'origin', 'source');
  f.plan.run.max_parallel = 2;
  f.plan.tasks = ['A', 'B', 'C', 'D', 'E', 'F'].map((id, i) => ({
    id, depends_on: i < 2 ? [] : i < 4 ? ['A', 'B'] : ['C', 'D'],
    scope: [id === 'C' ? 'price.mjs' : id === 'D' ? 'view.mjs' : id.toLowerCase() + '.txt'],
    conflicts_with: [], agent, continuation: { mode: 'new' }, completion: [id]
  }));
  f.savePlan(); return f;
}
