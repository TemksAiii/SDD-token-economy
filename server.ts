import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { runAbBenchmark } from './src/engine/abBenchmark';
import { sliceSpecForTask, parseOpenSpecBundle } from './src/engine/specSlicer';
import {
  applyHashlinePatch,
  renderAstLodView,
  SupportedLanguage,
  LodLevel,
} from './src/engine/astLodHashline';
import { compressGitDiff, compressTestLog, TestRunnerKind } from './src/engine/outputCompressor';
import { runPreReviewGate } from './src/engine/preReviewGate';
import { analyzeRepoPortability } from './src/engine/portability';
import { generateJuryDeliverables } from './src/engine/juryDeliverables';
import {
  DEMO_GATE_FILES,
  DEMO_KNOWN_CONTRACTS,
  DEMO_OPENSPEC_BUNDLE,
  DEMO_REPO_PROBES,
} from './src/data/demoWorkspace';

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'spectrim-sdd-workbench' });
  });

  app.post('/api/benchmark', (req, res) => {
    try {
      const benchmark = runAbBenchmark(req.body ?? {});
      const deliverables = generateJuryDeliverables(benchmark);
      res.json({ benchmark, deliverables });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Benchmark failed' });
    }
  });

  app.post('/api/slice', (req, res) => {
    try {
      const {
        taskId = 'TSK-07',
        completedTaskIds = ['TSK-01', 'TSK-02', 'TSK-03', 'TSK-04', 'TSK-05', 'TSK-06'],
        bundle = DEMO_OPENSPEC_BUNDLE,
      } = req.body ?? {};
      const graph = parseOpenSpecBundle(bundle);
      const slice = sliceSpecForTask(bundle, taskId, completedTaskIds, DEMO_KNOWN_CONTRACTS);
      res.json({ graph, slice });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Slice failed' });
    }
  });

  app.post('/api/ast-lod', (req, res) => {
    try {
      const {
        filePath = 'src/middleware/rate_limiter.py',
        content = '',
        language = 'python',
        level = 'LOD1',
        repoTreePaths = [],
      } = req.body ?? {};
      const view = renderAstLodView(
        filePath,
        content,
        language as SupportedLanguage,
        level as LodLevel,
        repoTreePaths
      );
      res.json(view);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'AST-LOD failed' });
    }
  });

  app.post('/api/hashline-patch', (req, res) => {
    try {
      const { content, patch } = req.body ?? {};
      if (typeof content !== 'string' || !patch) {
        return res.status(400).json({ error: 'Missing content or patch payload' });
      }
      const result = applyHashlinePatch(content, patch);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Patch failed' });
    }
  });

  app.post('/api/compress', (req, res) => {
    try {
      const { kind = 'test_log', raw = '', runner = 'pytest', unchangedHashes = {} } = req.body ?? {};
      const result =
        kind === 'git_diff'
          ? compressGitDiff(raw, unchangedHashes)
          : compressTestLog(raw, runner as TestRunnerKind);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Compress failed' });
    }
  });

  app.post('/api/gate', (req, res) => {
    try {
      const {
        missingReqTest = false,
        uncheckedTask = false,
        failingTest = false,
        lintError = false,
        brokenDesignRef = false,
      } = req.body ?? {};

      let bundle = { ...DEMO_OPENSPEC_BUNDLE };
      if (uncheckedTask) {
        bundle = {
          ...bundle,
          tasksMd: bundle.tasksMd.replace('- [x] [TSK-07]', '- [ ] [TSK-07]'),
        };
      }
      if (brokenDesignRef) {
        bundle = {
          ...bundle,
          designMd: bundle.designMd.replace('Linked requirements: REQ-09', 'Linked requirements: REQ-99'),
        };
      }

      const files = DEMO_GATE_FILES.map((f) => {
        if (missingReqTest && f.isTest) {
          return { ...f, content: f.content.replace('@spec:REQ-07', '') };
        }
        return f;
      });

      const gate = runPreReviewGate({
        bundle,
        files,
        testsPassing: !failingTest,
        failingTestSnippet: failingTest
          ? 'FAILED tests/test_rate_limit_audit.py::test_spool_fallback_on_sink_error - AssertionError: assert False'
          : undefined,
        lintErrors: lintError
          ? ['src/audit/audit_logger.py:42:5: F401 unused import json']
          : [],
      });

      res.json(gate);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Gate check failed' });
    }
  });

  app.get('/api/portability', (_req, res) => {
    const probes = DEMO_REPO_PROBES.map((probe) => ({
      probe,
      analysis: analyzeRepoPortability(probe),
    }));
    res.json({ probes });
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
