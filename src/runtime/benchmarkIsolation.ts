import fs from 'node:fs';
import path from 'node:path';
import { runSafeCommand } from './execUtils';
import { computeRepoSnapshotHash, copyRepoSnapshot, inspectGitContext } from './repoFs';

export async function prepareBenchmarkIsolation(
  source: string,
  runDir: string,
  signal?: AbortSignal,
) {
  const git = inspectGitContext(source);
  const roots = ['worktree-baseline', 'worktree-optimized'].map(name => path.join(runDir, name));
  const snapshot = path.join(runDir, 'snapshot-base');
  const registered: string[] = [];

  const removeWorktrees = async () => {
    while (registered.length > 0) {
      const root = registered[registered.length - 1];
      const result = await runSafeCommand('git', ['worktree', 'remove', '--force', root], git.absGitRoot!);
      if (result.exitCode !== 0) throw new Error(`Cannot remove worktree ${root}: ${result.combined}`);
      registered.pop();
    }
  };

  const cleanup = async () => {
    await removeWorktrees();
    for (const dir of [...roots, snapshot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    const gitVersion = await runSafeCommand('git', ['--version'], source, { signal });
    if (gitVersion.exitCode !== 0) {
      throw new Error('Git executable is required to save benchmark diffs, including in snapshot_copy mode.');
    }
    const sourceHash = computeRepoSnapshotHash(source);
    let reason = 'No usable Git HEAD was available.';
    if (git.absGitRoot && git.headCommit) {
      let allAdded = true;
      for (const root of roots) {
        const result = await runSafeCommand(
          'git', ['worktree', 'add', '--detach', root, git.headCommit], git.absGitRoot, { signal }
        );
        if (result.exitCode !== 0) {
          allAdded = false;
          if (fs.existsSync(path.join(root, '.git'))) registered.push(root);
          reason = `git worktree add failed (exit ${result.exitCode}): ${result.combined}`;
          break;
        }
        registered.push(root);
      }

      if (allAdded) {
        const [baselineDir, optimizedDir] = roots.map(root => path.join(root, git.repoSubpath));
        const matchesSource = [baselineDir, optimizedDir].every(dir =>
          fs.existsSync(dir) && computeRepoSnapshotHash(dir) === sourceHash);
        const entries = matchesSource
          ? await runSafeCommand('git', ['ls-files', '--stage', '-z', '--', '.'], baselineDir, { signal })
          : null;
        const safeWorktree = entries?.exitCode === 0 &&
          !entries.stdout.split('\0').some(entry => /^(120000|160000) /.test(entry));
        if (matchesSource && safeWorktree) {
          return {
            mode: 'git_worktree' as const, baselineDir, optimizedDir, baseCommit: git.headCommit,
            snapshotHash: undefined, git, reason: undefined, cleanup,
          };
        }
        reason = matchesSource
          ? 'Worktree entries could not be verified as ordinary files (such as links or submodules).'
          : 'Checked-out Git trees did not match the requested source directory.';
      }
      await cleanup();
    }

    copyRepoSnapshot(source, snapshot);
    const snapshotHash = computeRepoSnapshotHash(snapshot);
    if (sourceHash !== snapshotHash || computeRepoSnapshotHash(source) !== snapshotHash) {
      throw new Error('The source changed while taking the benchmark snapshot.');
    }
    const [baselineDir, optimizedDir] = roots;
    for (const dir of roots) {
      copyRepoSnapshot(snapshot, dir);
      if (computeRepoSnapshotHash(dir) !== snapshotHash) {
        throw new Error(`Snapshot verification failed for ${path.basename(dir)}.`);
      }
    }
    return {
      mode: 'snapshot_copy' as const, baselineDir, optimizedDir, baseCommit: null,
      snapshotHash, git, reason, cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
