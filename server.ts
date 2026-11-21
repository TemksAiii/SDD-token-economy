import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createServer as createViteServer } from 'vite';
import {
  buildKvCacheLayout,
  runLocalSimulation,
} from './src/engine/abModelSimulation';
import { parseOpenSpecBundle, sliceSpecForTask } from './src/engine/specSlicer';
import {
  applyHashlinePatch,
  LodLevel,
  renderAstLodView,
  SupportedLanguage,
} from './src/engine/astLodHashline';
import {
  compressGitDiff,
  compressTestLog,
  TestRunnerKind,
} from './src/engine/outputCompressor';
import { runPreReviewGate } from './src/engine/preReviewGate';
import { generateJuryDeliverables } from './src/engine/juryDeliverables';
import { AbRunReport } from './src/engine/provenance';
import {
  collectRepoFiles,
  detectRepoOnDisk,
  getRealRepoPortabilityDetails,
  listRepoFilesMeta,
  listWorkspaceBenchmarkRepos,
  readOpenSpecBundleFromDisk,
  readRepoFile,
} from './src/runtime/repoFs';
import { runLocalPreReviewGate } from './src/runtime/localGateRunner';
import { getProviderStatus } from './src/runtime/llmProvider';
import {
  BenchmarkProgressEvent,
  listSavedRuns,
  loadSavedRun,
  runRealAbWorktreeBenchmark,
} from './src/runtime/abWorktreeRunner';
import { resolveConfinedPath } from './src/runtime/pathGuard';

const PORT = 3000;

interface ActiveRunJob {
  jobId: string;
  controller: AbortController;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  events: BenchmarkProgressEvent[];
  report?: AbRunReport;
  error?: string;
  subscribers: Set<express.Response>;
}

const activeJobs = new Map<string, ActiveRunJob>();

function sendSse(res: express.Response, eventName: string, payload: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'spectrim-sdd-workbench' });
  });

  // Provider readiness + real disk repositories + saved runs
  app.get('/api/status', (_req, res) => {
    try {
      res.json({
        provider: getProviderStatus(),
        repos: listWorkspaceBenchmarkRepos(),
        savedRuns: listSavedRuns(),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to inspect workspace status',
      });
    }
  });

  // Local mathematical simulation (strictly tagged provenance: 'simulated')
  app.post('/api/simulation', (req, res) => {
    try {
      const cfg = req.body ?? {};
      const report = runLocalSimulation(cfg);
      const deliverables = generateJuryDeliverables(report);
      const kvCacheLayout = buildKvCacheLayout(
        cfg.enableDeltaReviewAndCache !== false
      );
      res.json({ report, deliverables, kvCacheLayout });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Simulation failed',
      });
    }
  });

  // Real disk portability scan across all benchmark repositories
  app.get('/api/fs/portability', (_req, res) => {
    try {
      const repos = listWorkspaceBenchmarkRepos();
      const details = repos.map((r) => getRealRepoPortabilityDetails(r.repoPath));
      res.json({ repos: details, provenance: 'measured_local' });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Portability scan failed',
      });
    }
  });

  // Real disk OpenSpec repository inspection
  app.get('/api/fs/inspect', (req, res) => {
    try {
      const repoPath = String(req.query.repo || 'benchmarks/orders-ts');
      const repo = detectRepoOnDisk(repoPath);
      const changeId = String(
        req.query.change || repo.changes[0] || 'add-rate-limit-and-audit'
      );
      const bundle = readOpenSpecBundleFromDisk(repoPath, changeId);
      const graph = parseOpenSpecBundle(bundle);
      const files = listRepoFilesMeta(repoPath);
      res.json({
        repo,
        bundle,
        graph,
        files,
        provenance: 'measured_local',
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to inspect repository',
      });
    }
  });

  // Task-scoped OpenSpec slicing on real disk bundle
  app.post('/api/fs/slice', (req, res) => {
    try {
      const {
        repoPath = 'benchmarks/orders-ts',
        changeId = 'add-rate-limit-and-audit',
        taskId = 'TSK-01',
        completedTaskIds,
      } = req.body ?? {};
      const bundle = readOpenSpecBundleFromDisk(repoPath, changeId);
      const graph = parseOpenSpecBundle(bundle);
      const idx = graph.tasks.findIndex((t) => t.id === taskId);
      const derivedCompleted = Array.isArray(completedTaskIds)
        ? completedTaskIds
        : graph.tasks.slice(0, Math.max(0, idx)).map((t) => t.id);

      const contracts = graph.tasks.slice(0, Math.max(0, idx)).map((t) => ({
        taskId: t.id,
        file: t.targetFiles[0] || 'src/',
        symbol: t.title.slice(0, 60),
        reqs: t.linkedReqs,
      }));

      const slice = sliceSpecForTask(bundle, taskId, derivedCompleted, contracts);
      res.json({ graph, slice, provenance: 'measured_local' });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Slice failed',
      });
    }
  });

  // Real AST-LOD & Hashline reading from disk repository
  app.post('/api/fs/ast-lod', (req, res) => {
    try {
      const {
        repoPath = 'benchmarks/orders-ts',
        filePath,
        content,
        language,
        level = 'LOD1',
      } = req.body ?? {};
      const repo = detectRepoOnDisk(repoPath);
      const filesMeta = listRepoFilesMeta(repoPath);
      const resolvedFilePath =
        typeof filePath === 'string' && filePath.length > 0
          ? filePath
          : filesMeta.find((f) => !f.isTest)?.path || filesMeta[0]?.path || '';

      const actualContent =
        typeof content === 'string'
          ? content
          : resolvedFilePath
          ? readRepoFile(repoPath, resolvedFilePath)
          : '';

      const view = renderAstLodView(
        resolvedFilePath,
        actualContent,
        (language || repo.language) as SupportedLanguage,
        level as LodLevel,
        filesMeta.map((f) => f.path)
      );

      res.json({
        filePath: resolvedFilePath,
        language: language || repo.language,
        rawContent: actualContent,
        view,
        files: filesMeta,
        provenance: 'measured_local',
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'AST-LOD inspection failed',
      });
    }
  });

  // Hashline patch validator (in-memory verification without mutating benchmark git HEAD)
  app.post('/api/hashline-patch', (req, res) => {
    try {
      const { content, patch } = req.body ?? {};
      if (typeof content !== 'string' || !patch) {
        return res.status(400).json({ error: 'Missing content or patch payload' });
      }
      const result = applyHashlinePatch(content, patch);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Patch failed',
      });
    }
  });

  // Deterministic test log / git diff compressor
  app.post('/api/compress', (req, res) => {
    try {
      const {
        kind = 'test_log',
        raw = '',
        runner = 'pytest',
        unchangedHashes = {},
      } = req.body ?? {};
      const result =
        kind === 'git_diff'
          ? compressGitDiff(raw, unchangedHashes)
          : compressTestLog(raw, runner as TestRunnerKind);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Compress failed',
      });
    }
  });

  // Real Zero-Token Pre-Review Gate running actual test + lint commands on disk
  app.post('/api/fs/gate', async (req, res) => {
    try {
      const {
        repoPath = 'benchmarks/orders-ts',
        changeId = 'add-rate-limit-and-audit',
        injectDefects = {},
      } = req.body ?? {};

      const hasSimulatedDefects = Boolean(
        injectDefects?.missingReqTest ||
          injectDefects?.uncheckedTask ||
          injectDefects?.failingTest ||
          injectDefects?.lintError ||
          injectDefects?.brokenDesignRef
      );

      if (!hasSimulatedDefects) {
        const realGate = await runLocalPreReviewGate(repoPath, changeId);
        return res.json({
          ...realGate,
          defectsInjected: false,
        });
      }

      // If sandbox defect injection toggles are enabled, run real disk checks first,
      // then apply the requested in-memory defect perturbation transparently.
      const absRepo = resolveConfinedPath(repoPath);
      const realBaseline = await runLocalPreReviewGate(repoPath, changeId);
      let bundle = readOpenSpecBundleFromDisk(repoPath, changeId);
      let files = collectRepoFiles(absRepo);

      if (injectDefects.uncheckedTask) {
        bundle = {
          ...bundle,
          tasksMd: bundle.tasksMd.replace(/^- \[x\] /m, '- [ ] '),
        };
      }
      if (injectDefects.brokenDesignRef) {
        bundle = {
          ...bundle,
          designMd: `${bundle.designMd}\n\nLinked requirements: REQ-99\n`,
        };
      }
      if (injectDefects.missingReqTest) {
        files = files.map((f) =>
          f.isTest
            ? { ...f, content: f.content.replace(/@spec:REQ-\d+/g, '') }
            : f
        );
      }

      const gate = runPreReviewGate({
        bundle,
        files,
        testsPassing: !injectDefects.failingTest && realBaseline.testExitCode === 0,
        failingTestSnippet: injectDefects.failingTest
          ? 'Simulated assertion failure injected via Sandbox defect toggle'
          : realBaseline.testExitCode === 0
          ? undefined
          : realBaseline.compressedTestLog.compressed,
        lintErrors: injectDefects.lintError
          ? ['Simulated lint violation injected via Sandbox defect toggle']
          : realBaseline.lintExitCode === 0
          ? []
          : [realBaseline.rawLintOutput.slice(0, 300)],
      });

      return res.json({
        ...realBaseline,
        gate,
        defectsInjected: true,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Local Pre-Review Gate failed',
      });
    }
  });

  // Saved A/B benchmark runs from .spectrim-runs/
  app.get('/api/runs', (_req, res) => {
    try {
      res.json({ runs: listSavedRuns() });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to list saved runs',
      });
    }
  });

  app.get('/api/runs/:runId', (req, res) => {
    try {
      const report = loadSavedRun(req.params.runId);
      const deliverables = generateJuryDeliverables(report);
      res.json({ report, deliverables });
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : 'Run not found',
      });
    }
  });

  // Start real isolated git worktree A/B benchmark with AbortController + SSE progress
  app.post('/api/runs/start', (req, res) => {
    try {
      const {
        repoPath = 'benchmarks/orders-ts',
        changeId = 'add-idempotency-and-webhooks',
        provider,
        model,
        maxReviewIters = 3,
      } = req.body ?? {};

      const status = getProviderStatus();
      if (status.defaultProvider === 'none') {
        return res.status(400).json({
          code: 'PROVIDER_NOT_CONFIGURED',
          error: status.limitationNote,
        });
      }

      // Validate repository & OpenSpec change upfront before spawning background run
      const repoInfo = detectRepoOnDisk(repoPath);
      if (!repoInfo.isGitRepo) {
        return res.status(400).json({
          error: `Репозиторий ${repoInfo.repoPath} не является git-репозиторием; git worktree невозможен.`,
        });
      }
      readOpenSpecBundleFromDisk(repoPath, changeId);

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const controller = new AbortController();
      const job: ActiveRunJob = {
        jobId,
        controller,
        status: 'running',
        events: [],
        subscribers: new Set(),
      };
      activeJobs.set(jobId, job);

      void runRealAbWorktreeBenchmark({
        repoPath,
        changeId,
        provider,
        model,
        maxReviewIters,
        signal: controller.signal,
        onProgress: (ev) => {
          job.events.push(ev);
          for (const sub of job.subscribers) {
            sendSse(sub, 'progress', ev);
          }
        },
      })
        .then((report) => {
          job.status = 'completed';
          job.report = report;
          const deliverables = generateJuryDeliverables(report);
          for (const sub of job.subscribers) {
            sendSse(sub, 'completed', { report, deliverables });
            sub.end();
          }
          job.subscribers.clear();
        })
        .catch((err) => {
          const aborted = controller.signal.aborted;
          job.status = aborted ? 'cancelled' : 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          for (const sub of job.subscribers) {
            sendSse(sub, aborted ? 'cancelled' : 'error', { error: job.error });
            sub.end();
          }
          job.subscribers.clear();
        });

      return res.status(202).json({ jobId });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to start benchmark',
      });
    }
  });

  app.get('/api/runs/jobs/:jobId/stream', (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Benchmark job not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    for (const ev of job.events) {
      sendSse(res, 'progress', ev);
    }

    if (job.status === 'completed' && job.report) {
      sendSse(res, 'completed', {
        report: job.report,
        deliverables: generateJuryDeliverables(job.report),
      });
      return res.end();
    }
    if (job.status === 'cancelled') {
      sendSse(res, 'cancelled', { error: job.error || 'Cancelled by user' });
      return res.end();
    }
    if (job.status === 'failed') {
      sendSse(res, 'error', { error: job.error || 'Benchmark failed' });
      return res.end();
    }

    job.subscribers.add(res);
    req.on('close', () => {
      job.subscribers.delete(res);
    });
  });

  app.post('/api/runs/jobs/:jobId/cancel', (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Benchmark job not found' });
    }
    job.controller.abort();
    return res.json({ status: 'cancelling', jobId: job.jobId });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SpecTrim SDD Workbench listening on http://localhost:${PORT}`);
  });
}

startServer();
