export type DataProvenance =
  | 'measured'
  | 'measured_local'
  | 'estimated'
  | 'simulated'
  | 'demo_fixture';

export type SddStage = 'spec_prep' | 'apply' | 'review' | 'verify';

export type IsolationMode = 'git_worktree' | 'snapshot_copy';

export interface RunManifest {
  runId: string;
  createdAt: string;
  repoPath: string;
  repoName: string;
  changeId: string;
  baseCommit: string;
  isolationMode?: IsolationMode;
  snapshotHash?: string;
  gitRoot?: string | null;
  repoSubpath?: string;
  provider: string;
  model: string;
  sameModelEnforced: true;
  detectedLanguage: string;
  testCommand: string;
  lintCommand: string;
  baselineWorktree: string;
  optimizedWorktree: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  error?: string;
}

export interface TelemetryEventRecord {
  ts: string;
  run: 'baseline' | 'spectrim';
  provider: string;
  model: string;
  stage: SddStage;
  task_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_input_tokens: number;
  uncached_input_tokens: number;
  thoughts_tokens: number;
  total_tokens: number;
  tool_calls: number;
  retries: number;
  review_iteration: number;
  duration_ms: number;
  cost_usd: number | null;
  cache_usage_measured: boolean;
  provenance: DataProvenance;
}

export interface StageSideBreakdown {
  stage: SddStage;
  stageLabel: string;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  durationMs: number;
  toolCalls: number;
  retries: number;
  provenance: DataProvenance;
}

export interface PipelineSideSummary {
  side: 'baseline' | 'spectrim';
  provenance: DataProvenance;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  costUsd: number | null;
  cacheUsageMeasured: boolean;
  durationMs: number;
  toolCalls: number;
  retries: number;
  reviewIterations: number;
  testsPassed: boolean;
  testsOutputSummary: string;
  lintPassed: boolean;
  lintOutputSummary: string;
  reqCoveragePct: number;
  coveredReqs: string[];
  uncoveredReqs: string[];
  artifactConsistency: boolean;
  tasksCompleted: number;
  tasksTotal: number;
  changedFiles: string[];
  diffLineCount: number;
  stages: StageSideBreakdown[];
}

export interface AbRunReport {
  manifest: RunManifest;
  provenance: DataProvenance;
  limitations: string[];
  baseline: PipelineSideSummary;
  optimized: PipelineSideSummary;
  savings: {
    totalTokensPct: number | null;
    promptTokensPct: number | null;
    completionTokensPct: number | null;
    costPct: number | null;
    reviewIterationsDelta: number;
    retriesDelta: number;
    durationDeltaMs: number;
  };
  qualityParityPassed: boolean;
  baselineDiff: string;
  optimizedDiff: string;
  metricsJsonl: string;
}

export type LlmProviderId = 'gemini' | 'ollama' | 'openai_compat';

export interface OllamaDiscoveryStatus {
  enabled: boolean;
  reachable: boolean;
  baseUrl: string;
  configuredModel: string | null;
  installedModels: string[];
  error?: string;
}

export interface ProviderStatus {
  geminiConfigured: boolean;
  ollamaConfigured: boolean;
  openAiCompatConfigured: boolean;
  defaultProvider: LlmProviderId | 'none';
  ollamaStatus: OllamaDiscoveryStatus;
  availableModels: Array<{
    id: string;
    label: string;
    provider: LlmProviderId;
    tier: 'small' | 'large';
    locality: 'cloud' | 'local';
  }>;
  limitationNote: string;
}
