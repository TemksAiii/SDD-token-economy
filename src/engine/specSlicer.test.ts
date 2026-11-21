import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenSpecBundle, sliceSpecForTask } from './specSlicer';
import { DEMO_KNOWN_CONTRACTS, DEMO_OPENSPEC_BUNDLE } from '../data/demoFixtures';

test('parseOpenSpecBundle extracts all 10 REQs, 6 DES sections, and 10 tasks', () => {
  const graph = parseOpenSpecBundle(DEMO_OPENSPEC_BUNDLE);
  assert.equal(graph.requirements.length, 10);
  assert.equal(graph.designSections.length, 6);
  assert.equal(graph.tasks.length, 10);
  assert.ok(graph.edges.length >= 16);
});

test('sliceSpecForTask cuts token load dramatically while keeping linked REQ and DES', () => {
  const result = sliceSpecForTask(
    DEMO_OPENSPEC_BUNDLE,
    'TSK-07',
    ['TSK-01', 'TSK-02', 'TSK-03', 'TSK-04', 'TSK-05', 'TSK-06'],
    DEMO_KNOWN_CONTRACTS
  );
  assert.equal(result.task.id, 'TSK-07');
  assert.deepEqual(
    result.requirements.map((r) => r.id),
    ['REQ-09']
  );
  assert.deepEqual(
    result.designSections.map((d) => d.id),
    ['DES-04']
  );
  assert.equal(result.stateCapsule.completedTasks.length, 6);
  assert.ok(result.reductionPct > 55, `Expected >55% reduction, got ${result.reductionPct}%`);
});
