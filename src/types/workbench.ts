import { AbRunReport, DataProvenance, ProviderStatus } from '../engine/provenance';
import { KvCacheSegment, SimulationConfig } from '../engine/abModelSimulation';
import { JuryDeliverablesBundle } from '../engine/juryDeliverables';
import { SupportedLanguage } from '../engine/astLodHashline';
import { TestRunnerKind } from '../engine/outputCompressor';

export interface WorkspaceRepoInfo {
  repoPath: string;
  repoName: string;
  manifestFile: string;
  language: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  testRunnerKind: TestRunnerKind;
  lintCommand: string;
  specMarkerSyntax: string;
  changes: string[];
  sourceFileCount: number;
  isGitRepo: boolean;
}

export interface SavedRunSummary {
  runId: string;
  createdAt: string;
  repoName: string;
  changeId: string;
  model: string;
  provider: string;
  status: string;
  provenance: string;
  totalSavingsPct: number | null;
}

export interface WorkbenchStatusResponse {
  provider: ProviderStatus;
  repos: WorkspaceRepoInfo[];
  savedRuns: SavedRunSummary[];
}

export interface LiveRunProgressEvent {
  ts: string;
  runId: string;
  phase: 'setup' | 'baseline' | 'spectrim' | 'verify' | 'done' | 'error' | 'cancelled';
  message: string;
  step?: number;
  totalSteps?: number;
}

export interface ActiveBenchmarkState {
  report: AbRunReport;
  deliverables: JuryDeliverablesBundle;
  kvCacheLayout: KvCacheSegment[];
}

export const PROVENANCE_LABEL: Record<DataProvenance, string> = {
  measured: 'MEASURED · API + Git Worktree',
  measured_local: 'MEASURED_LOCAL · Файлы и тесты на диске',
  estimated: 'ESTIMATED · Эвристика токенизации',
  simulated: 'SIMULATED · Локальная математическая модель (не API-замер)',
  demo_fixture: 'DEMO_FIXTURE · Встроенный образец лога/диффа',
};

export type { SimulationConfig };
