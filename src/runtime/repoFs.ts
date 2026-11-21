import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OpenSpecBundle } from '../engine/specSlicer';
import { detectStackFromManifest } from '../engine/portability';
import { extractAstSkeleton, SupportedLanguage } from '../engine/astLodHashline';
import { TestRunnerKind } from '../engine/outputCompressor';
import { GateSourceFile } from '../engine/preReviewGate';
import { resolveConfinedPath, sanitizeIdSegment, WORKSPACE_ROOT } from './pathGuard';
import { hasExecutable } from './execUtils';

export interface GitContextInfo {
  isGitRepo: boolean;
  gitRoot: string | null;
  absGitRoot: string | null;
  repoSubpath: string;
  headCommit: string | null;
  isolationCapability: 'git_worktree' | 'snapshot_copy';
}

export interface DetectedRepoInfo {
  repoPath: string; // workspace-relative
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
  gitRoot: string | null;
  repoSubpath: string;
  isolationCapability: 'git_worktree' | 'snapshot_copy';
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.spectrim-runs',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.playwright-cli',
]);

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java']);

export function inspectGitContext(absRepo: string): GitContextInfo {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: absRepo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') {
      return {
        isGitRepo: false,
        gitRoot: null,
        absGitRoot: null,
        repoSubpath: '',
        headCommit: null,
        isolationCapability: 'snapshot_copy',
      };
    }

    const rawTop = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: absRepo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const absGitRoot = fs.realpathSync(path.resolve(rawTop));
    const realAbsRepo = fs.realpathSync(absRepo);

    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: absGitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!headCommit) {
      return {
        isGitRepo: false,
        gitRoot: null,
        absGitRoot: null,
        repoSubpath: '',
        headCommit: null,
        isolationCapability: 'snapshot_copy',
      };
    }

    const repoSubpath = path.relative(absGitRoot, realAbsRepo).replace(/\\/g, '/');
    const relRoot = path.relative(WORKSPACE_ROOT, absGitRoot).replace(/\\/g, '/');
    const displayGitRoot = relRoot === '' ? '.' : relRoot.startsWith('..') ? path.basename(absGitRoot) : relRoot;

    return {
      isGitRepo: true,
      gitRoot: displayGitRoot,
      absGitRoot,
      repoSubpath: repoSubpath === '.' ? '' : repoSubpath,
      headCommit,
      isolationCapability: 'git_worktree',
    };
  } catch {
    return {
      isGitRepo: false,
      gitRoot: null,
      absGitRoot: null,
      repoSubpath: '',
      headCommit: null,
      isolationCapability: 'snapshot_copy',
    };
  }
}

export function computeRepoSnapshotHash(absRepo: string): string {
  const hash = crypto.createHash('sha256');
  const filePaths: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        filePaths.push(path.relative(absRepo, full).replace(/\\/g, '/'));
      }
    }
  };

  walk(absRepo);
  filePaths.sort();
  for (const rel of filePaths) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(absRepo, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function copyRepoSnapshot(absRepo: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const copyWalk = (srcDir: string, dstDir: string) => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        copyWalk(srcPath, dstPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };
  copyWalk(absRepo, destDir);
}

export function detectRepoOnDisk(repoInputPath: string): DetectedRepoInfo {
  const absRepo = resolveConfinedPath(repoInputPath);
  if (!fs.existsSync(absRepo) || !fs.statSync(absRepo).isDirectory()) {
    throw new Error(`Repository directory not found: ${repoInputPath}`);
  }

  const manifestCandidates = [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
  ];

  let foundManifest = 'package.json';
  let manifestContent = '{}';
  for (const candidate of manifestCandidates) {
    const p = path.join(absRepo, candidate);
    if (fs.existsSync(p)) {
      foundManifest = candidate;
      manifestContent = fs.readFileSync(p, 'utf8');
      break;
    }
  }

  const stack = detectStackFromManifest(foundManifest, manifestContent);
  let testCommand = stack.testCommand;
  let testRunnerKind = stack.testRunnerKind;
  let lintCommand = stack.lintCommand;

  if (stack.language === 'python') {
    if (testCommand.startsWith('pytest') && !hasExecutable('pytest')) {
      testCommand = 'python3 -m unittest discover -s tests -v';
      testRunnerKind = 'unittest';
    }
    if (lintCommand.startsWith('ruff') && !hasExecutable('ruff')) {
      lintCommand = 'python3 -m compileall -q src';
    }
  }

  const changesDir = path.join(absRepo, 'openspec', 'changes');
  let changes: string[] = [];
  if (fs.existsSync(changesDir) && fs.statSync(changesDir).isDirectory()) {
    changes = fs
      .readdirSync(changesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  const files = collectRepoFiles(absRepo);
  const relRepo = path.relative(WORKSPACE_ROOT, absRepo) || '.';
  const gitCtx = inspectGitContext(absRepo);

  return {
    repoPath: relRepo,
    repoName: path.basename(absRepo),
    manifestFile: foundManifest,
    language: stack.language,
    packageManager: stack.packageManager,
    testCommand,
    testRunnerKind,
    lintCommand,
    specMarkerSyntax: stack.specMarkerSyntax,
    changes,
    sourceFileCount: files.length,
    isGitRepo: gitCtx.isGitRepo,
    gitRoot: gitCtx.gitRoot,
    repoSubpath: gitCtx.repoSubpath,
    isolationCapability: gitCtx.isolationCapability,
  };
}

export function listWorkspaceBenchmarkRepos(): DetectedRepoInfo[] {
  const benchRoot = path.join(WORKSPACE_ROOT, 'benchmarks');
  const results: DetectedRepoInfo[] = [];
  if (fs.existsSync(benchRoot)) {
    const entries = fs.readdirSync(benchRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          results.push(detectRepoOnDisk(path.join('benchmarks', entry.name)));
        } catch {
          // Skip invalid directories
        }
      }
    }
  }
  const order = ['orders-ts', 'orders-py', 'edge-go', 'billing-java'];
  return results.sort((a, b) => {
    const ia = order.indexOf(a.repoName);
    const ib = order.indexOf(b.repoName);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    }
    return a.repoName.localeCompare(b.repoName);
  });
}

export function readOpenSpecBundleFromDisk(
  repoInputPath: string,
  changeId: string
): OpenSpecBundle {
  const absRepo = resolveConfinedPath(repoInputPath);
  const safeChange = sanitizeIdSegment(changeId, 'changeId');
  const changeDir = resolveConfinedPath(
    path.join(absRepo, 'openspec', 'changes', safeChange),
    absRepo
  );

  if (!fs.existsSync(changeDir)) {
    throw new Error(`OpenSpec change not found: ${repoInputPath}/openspec/changes/${safeChange}`);
  }

  const readOpt = (rel: string): string => {
    const p = resolveConfinedPath(path.join(changeDir, rel), changeDir);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };

  const proposalMd = readOpt('proposal.md');
  const designMd = readOpt('design.md');
  const tasksMd = readOpt('tasks.md');

  const specsMd: Record<string, string> = {};
  const specsDir = path.join(changeDir, 'specs');
  if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
    for (const domainEntry of fs.readdirSync(specsDir, { withFileTypes: true })) {
      if (domainEntry.isDirectory()) {
        const specPath = path.join(specsDir, domainEntry.name, 'spec.md');
        if (fs.existsSync(specPath)) {
          specsMd[domainEntry.name] = fs.readFileSync(specPath, 'utf8');
        }
      } else if (domainEntry.isFile() && domainEntry.name.endsWith('.md')) {
        specsMd[domainEntry.name.replace(/\.md$/, '')] = fs.readFileSync(
          path.join(specsDir, domainEntry.name),
          'utf8'
        );
      }
    }
  }

  return {
    changeId: safeChange,
    proposalMd,
    specsMd,
    designMd,
    tasksMd,
  };
}

export function collectRepoFiles(absRepo: string): GateSourceFile[] {
  const out: GateSourceFile[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTS.has(ext)) continue;
        const rel = path.relative(absRepo, full).replace(/\\/g, '/');
        const isTest =
          rel.startsWith('tests/') ||
          rel.includes('/tests/') ||
          rel.includes('/test/') ||
          /\.test\.[a-z]+$|^test_.*\.py$|_test\.go$|Test\.java$/.test(entry.name);
        out.push({
          path: rel,
          content: fs.readFileSync(full, 'utf8'),
          isTest,
        });
      }
    }
  };

  walk(absRepo);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readRepoFile(repoInputPath: string, relFilePath: string): string {
  const absRepo = resolveConfinedPath(repoInputPath);
  const absFile = resolveConfinedPath(path.join(absRepo, relFilePath), absRepo);
  if (!fs.existsSync(absFile)) {
    throw new Error(`File not found: ${relFilePath}`);
  }
  return fs.readFileSync(absFile, 'utf8');
}

export function writeRepoFileConfined(
  absRepoRoot: string,
  relFilePath: string,
  content: string
): void {
  const absFile = resolveConfinedPath(path.join(absRepoRoot, relFilePath), absRepoRoot);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, content, 'utf8');
}

export interface DiskRepoPortabilityReport {
  repoPath: string;
  repoName: string;
  manifestFile: string;
  manifestContent: string;
  detectedLanguage: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  testRunnerKind: TestRunnerKind;
  lintCommand: string;
  specMarkerSyntax: string;
  changes: string[];
  sourceFileCount: number;
  isGitRepo: boolean;
  sampleFilePath: string;
  sampleSourceCode: string;
  astSkeletonPreview: string;
  rawTokens: number;
  skeletonTokens: number;
  astReductionPct: number;
  provenance: 'measured_local';
}

export function listRepoFilesMeta(
  repoInputPath: string
): Array<{ path: string; isTest: boolean; bytes: number }> {
  const absRepo = resolveConfinedPath(repoInputPath);
  return collectRepoFiles(absRepo).map((f) => ({
    path: f.path,
    isTest: Boolean(f.isTest),
    bytes: Buffer.byteLength(f.content, 'utf8'),
  }));
}

export function getRealRepoPortabilityDetails(
  repoInputPath: string
): DiskRepoPortabilityReport {
  const info = detectRepoOnDisk(repoInputPath);
  const absRepo = resolveConfinedPath(repoInputPath);
  const manifestContent = fs.readFileSync(path.join(absRepo, info.manifestFile), 'utf8');
  const files = collectRepoFiles(absRepo);
  const nonTestFiles = files.filter((f) => !f.isTest);
  // Pick the richest source file (prefer rateLimiter / bucket / orders over tiny __init__.py)
  const chosen =
    nonTestFiles
      .slice()
      .sort((a, b) => b.content.length - a.content.length)[0] ??
    files[0] ?? { path: info.manifestFile, content: manifestContent };

  const astSkeletonPreview = extractAstSkeleton(
    chosen.content,
    info.language,
    chosen.path
  );
  const rawTokens = Math.max(1, Math.ceil(chosen.content.length / 4));
  const skeletonTokens = Math.max(1, Math.ceil(astSkeletonPreview.length / 4));
  const astReductionPct =
    rawTokens > 0
      ? Number((((rawTokens - skeletonTokens) / rawTokens) * 100).toFixed(1))
      : 0;

  return {
    repoPath: info.repoPath,
    repoName: info.repoName,
    manifestFile: info.manifestFile,
    manifestContent,
    detectedLanguage: info.language,
    packageManager: info.packageManager,
    testCommand: info.testCommand,
    testRunnerKind: info.testRunnerKind,
    lintCommand: info.lintCommand,
    specMarkerSyntax: info.specMarkerSyntax,
    changes: info.changes,
    sourceFileCount: info.sourceFileCount,
    isGitRepo: info.isGitRepo,
    sampleFilePath: chosen.path,
    sampleSourceCode: chosen.content,
    astSkeletonPreview,
    rawTokens,
    skeletonTokens,
    astReductionPct,
    provenance: 'measured_local',
  };
}

