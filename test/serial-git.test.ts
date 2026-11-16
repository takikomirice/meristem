import test from 'node:test';
import assert from 'node:assert/strict';
import { serialGit } from './live/serial-git.js';
test('serial_new_worker_candidate_correction_and_new_handoff_with_local_bare_remote', async () => {
  const result = await serialGit(); assert.equal(result.result, 'passed'); assert.equal(result.integrationShas.length, 2);
});
