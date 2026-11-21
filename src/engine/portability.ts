import { extractAstSkeleton, SupportedLanguage } from './astLodHashline';
import { estimateTokens } from './tokens';

export interface RepoManifestProbe {
  id: string;
  name: string;
  manifestFile: string;
  manifestContent: string;
  detectedLanguage: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  lintCommand: string;
  specMarkerSyntax: string;
  sampleFilePath: string;
  sampleSourceCode: string;
}

export interface PortabilityDetectionResult {
  repoId: string;
  name: string;
  manifestFile: string;
  detectedLanguage: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  lintCommand: string;
  specMarkerSyntax: string;
  astSkeletonPreview: string;
  rawTokens: number;
  skeletonTokens: number;
  astReductionPct: number;
  zeroCodeRewriteRequired: true;
}

export function detectStackFromManifest(
  manifestFile: string,
  manifestContent: string
): {
  language: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  lintCommand: string;
  specMarkerSyntax: string;
} {
  if (manifestFile.endsWith('pyproject.toml')) {
    const hasRuff = manifestContent.includes('ruff');
    const hasPytest = manifestContent.includes('pytest');
    return {
      language: 'python',
      packageManager: manifestContent.includes('uv') ? 'uv' : 'pip / poetry',
      testCommand: hasPytest ? 'pytest -q --tb=short' : 'python -m unittest',
      lintCommand: hasRuff ? 'ruff check . && mypy src' : 'flake8 .',
      specMarkerSyntax: '# @spec:REQ-XX',
    };
  }

  if (manifestFile.endsWith('go.mod')) {
    return {
      language: 'go',
      packageManager: 'go modules',
      testCommand: 'go test ./... -v',
      lintCommand: 'go vet ./... && golangci-lint run',
      specMarkerSyntax: '// @spec:REQ-XX',
    };
  }

  // Default Node / TypeScript package.json
  const hasVitest = manifestContent.includes('vitest');
  const hasJest = manifestContent.includes('jest');
  return {
    language: 'typescript',
    packageManager: manifestContent.includes('pnpm') ? 'pnpm' : 'npm',
    testCommand: hasVitest
      ? 'npx vitest run'
      : hasJest
      ? 'npx jest --ci'
      : 'node --test',
    lintCommand: 'npx tsc --noEmit && npx eslint src',
    specMarkerSyntax: '// @spec:REQ-XX',
  };
}

export function analyzeRepoPortability(
  probe: RepoManifestProbe
): PortabilityDetectionResult {
  const detected = detectStackFromManifest(probe.manifestFile, probe.manifestContent);
  const astSkeletonPreview = extractAstSkeleton(
    probe.sampleSourceCode,
    detected.language,
    probe.sampleFilePath
  );
  const rawTokens = estimateTokens(probe.sampleSourceCode);
  const skeletonTokens = estimateTokens(astSkeletonPreview);
  const astReductionPct =
    rawTokens > 0
      ? Number((((rawTokens - skeletonTokens) / rawTokens) * 100).toFixed(1))
      : 0;

  return {
    repoId: probe.id,
    name: probe.name,
    manifestFile: probe.manifestFile,
    detectedLanguage: detected.language,
    packageManager: detected.packageManager,
    testCommand: detected.testCommand,
    lintCommand: detected.lintCommand,
    specMarkerSyntax: detected.specMarkerSyntax,
    astSkeletonPreview,
    rawTokens,
    skeletonTokens,
    astReductionPct,
    zeroCodeRewriteRequired: true,
  };
}
