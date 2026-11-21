import { sliceSpecForTask } from '../../src/engine/specSlicer';
import { applyHashlinePatch, renderAstLodView } from '../../src/engine/astLodHashline';
import { compressGitDiff, compressTestLog } from '../../src/engine/outputCompressor';
import { runLocalPreReviewGate } from '../../src/runtime/localGateRunner';
import { readOpenSpecBundleFromDisk } from '../../src/runtime/repoFs';

export const specTrimOpenCodePlugin = {
  id: 'spectrim-sdd',
  version: '1.0.0',
  async onTaskSessionStart(repoPath: string, changeId: string, taskId: string, completedTasks: string[]) {
    const bundle = readOpenSpecBundleFromDisk(repoPath, changeId);
    return sliceSpecForTask(bundle, taskId, completedTasks);
  },
  onReadFile(filePath: string, content: string, language: 'typescript' | 'python' | 'go' | 'java', isTarget: boolean) {
    return renderAstLodView(filePath, content, language, isTarget ? 'LOD0' : 'LOD1');
  },
  onHashlinePatch: applyHashlinePatch,
  onToolOutput(kind: 'test' | 'diff', output: string) {
    return kind === 'diff' ? compressGitDiff(output) : compressTestLog(output);
  },
  async onPreReviewGate(repoPath: string, changeId: string) {
    return runLocalPreReviewGate(repoPath, changeId);
  },
};
