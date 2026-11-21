import { extractAstSkeleton, SupportedLanguage } from './astLodHashline';
import { TestRunnerKind } from './outputCompressor';
import { estimateTokens } from './tokens';

export interface RepoManifestProbe {
  id: string;
  name: string;
  manifestFile: string;
  manifestContent: string;
  detectedLanguage: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  testRunnerKind: TestRunnerKind;
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
  testRunnerKind: TestRunnerKind;
  lintCommand: string;
  specMarkerSyntax: string;
  astSkeletonPreview: string;
  rawTokens: number;
  skeletonTokens: number;
  astReductionPct: number;
  zeroCodeRewriteRequired: true;
  provenance: 'measured_local';
}

export function detectStackFromManifest(
  manifestFile: string,
  manifestContent: string
): {
  language: SupportedLanguage;
  packageManager: string;
  testCommand: string;
  testRunnerKind: TestRunnerKind;
  lintCommand: string;
  specMarkerSyntax: string;
} {
  const lowerFile = manifestFile.toLowerCase();

  if (
    lowerFile.endsWith('pyproject.toml') ||
    lowerFile.endsWith('requirements.txt') ||
    lowerFile.endsWith('setup.py')
  ) {
    const hasRuff = manifestContent.includes('ruff');
    const hasPytestDep =
      /["']pytest["'=<>!\[]|^\s*pytest\b/m.test(manifestContent) ||
      manifestContent.includes('dependencies') && manifestContent.includes('"pytest');
    return {
      language: 'python',
      packageManager: manifestContent.includes('uv')
        ? 'uv'
        : manifestContent.includes('poetry')
        ? 'poetry'
        : 'pip / python3',
      testCommand: hasPytestDep ? 'pytest -q --tb=short' : 'python3 -m unittest discover -s tests -v',
      testRunnerKind: hasPytestDep ? 'pytest' : 'unittest',
      lintCommand: hasRuff ? 'ruff check .' : 'python3 -m compileall -q src',
      specMarkerSyntax: '# @spec:REQ-XX',
    };
  }

  if (lowerFile.endsWith('go.mod')) {
    return {
      language: 'go',
      packageManager: 'go modules',
      testCommand: 'go test ./... -v',
      testRunnerKind: 'go_test',
      lintCommand: 'go vet ./...',
      specMarkerSyntax: '// @spec:REQ-XX',
    };
  }

  if (
    lowerFile.endsWith('pom.xml') ||
    lowerFile.endsWith('build.gradle') ||
    lowerFile.endsWith('build.gradle.kts')
  ) {
    const isGradle = lowerFile.includes('gradle');
    return {
      language: 'java',
      packageManager: isGradle ? 'gradle' : 'maven',
      testCommand: isGradle ? './gradlew test' : 'mvn -q test',
      testRunnerKind: 'junit',
      lintCommand: isGradle ? './gradlew checkstyleMain' : 'mvn -q compile',
      specMarkerSyntax: '// @spec:REQ-XX',
    };
  }

  // Node.js / TypeScript package.json
  let pkg: {
    scripts?: Record<string, string>;
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(manifestContent);
  } catch {
    pkg = {};
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const pm = pkg.packageManager?.startsWith('pnpm')
    ? 'pnpm'
    : pkg.packageManager?.startsWith('bun')
    ? 'bun'
    : 'npm';

  const testScript = pkg.scripts?.test ?? '';
  const lintScript = pkg.scripts?.lint ?? '';

  let testCommand = 'npx tsx --test tests/*.test.ts';
  let testRunnerKind: TestRunnerKind = 'node_test';

  if (testScript) {
    testCommand = testScript;
    if (testScript.includes('vitest')) testRunnerKind = 'vitest';
    else if (testScript.includes('jest')) testRunnerKind = 'vitest';
    else testRunnerKind = 'node_test';
  } else if ('vitest' in allDeps) {
    testCommand = 'npx vitest run';
    testRunnerKind = 'vitest';
  } else if ('jest' in allDeps) {
    testCommand = 'npx jest --ci';
    testRunnerKind = 'vitest';
  }

  const lintCommand = lintScript || 'npx tsc --noEmit';

  return {
    language: 'typescript',
    packageManager: pm,
    testCommand,
    testRunnerKind,
    lintCommand,
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
    testRunnerKind: detected.testRunnerKind,
    lintCommand: detected.lintCommand,
    specMarkerSyntax: detected.specMarkerSyntax,
    astSkeletonPreview,
    rawTokens,
    skeletonTokens,
    astReductionPct,
    zeroCodeRewriteRequired: true,
    provenance: 'measured_local',
  };
}
