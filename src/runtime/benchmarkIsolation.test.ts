import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareBenchmarkIsolation } from './benchmarkIsolation';
import { computeRepoSnapshotHash } from './repoFs';

test('standalone Git starts from HEAD and cleans up registered worktrees', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectrim-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const run = path.join(root, 'run');
  fs.mkdirSync(source);
  fs.mkdirSync(run);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(source, 'source.txt'), 'committed');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const isolation = await prepareBenchmarkIsolation(source, run);
  try {
    assert.equal(isolation.mode, 'git_worktree');
    assert.equal(isolation.baseCommit, head);
    assert.equal(isolation.git.repoSubpath, '');
    fs.writeFileSync(path.join(isolation.baselineDir, 'source.txt'), 'changed on A');
    assert.equal(fs.readFileSync(path.join(isolation.optimizedDir, 'source.txt'), 'utf8'), 'committed');
  } finally {
    await isolation.cleanup();
  }
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('second worktree refusal cleans up the first and verifies two independent snapshot copies',
  { skip: process.platform === 'win32' }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectrim-fallback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const run = path.join(root, 'run');
    const bin = path.join(root, 'bin');
    for (const dir of [source, run, bin]) fs.mkdirSync(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(source, 'source.txt'), 'committed');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
    fs.writeFileSync(path.join(source, '.env'), 'excluded');
    fs.symlinkSync(path.join(source, 'source.txt'), path.join(source, 'link.txt'));
    const originalPath = process.env.PATH!;
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = add ]; then
  case "$4" in
    */worktree-optimized) echo 'worktree creation disabled' >&2; exit 42 ;;
  esac
fi
PATH="$SPECTRIM_TEST_GIT_PATH" exec git "$@"
`, { mode: 0o755 });
    process.env.SPECTRIM_TEST_GIT_PATH = originalPath;
    process.env.PATH = bin + path.delimiter + originalPath;
    try {
      const isolation = await prepareBenchmarkIsolation(source, run);
      try {
        assert.equal(isolation.mode, 'snapshot_copy');
        assert.equal(isolation.baseCommit, null);
        assert.match(isolation.reason ?? '', /disabled/);
        for (const dir of [isolation.baselineDir, isolation.optimizedDir]) {
          assert.equal(computeRepoSnapshotHash(dir), isolation.snapshotHash);
          assert.equal(fs.existsSync(path.join(dir, '.env')), false);
          assert.equal(fs.existsSync(path.join(dir, 'link.txt')), false);
        }
        fs.writeFileSync(path.join(isolation.baselineDir, 'source.txt'), 'changed on A');
        assert.notEqual(computeRepoSnapshotHash(isolation.baselineDir), isolation.snapshotHash);
        assert.equal(computeRepoSnapshotHash(isolation.optimizedDir), isolation.snapshotHash);
        assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
      } finally {
        await isolation.cleanup();
      }
      assert.deepEqual(fs.readdirSync(run), []);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.SPECTRIM_TEST_GIT_PATH;
    }
  });
