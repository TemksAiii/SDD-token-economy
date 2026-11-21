import { OpenSpecBundle, parseOpenSpecBundle } from './specSlicer';
import { estimateTokens } from './tokens';

export interface GateSourceFile {
  path: string;
  content: string;
  isTest?: boolean;
}

export interface GateExecutionInput {
  bundle: OpenSpecBundle;
  files: GateSourceFile[];
  testsPassing: boolean;
  failingTestSnippet?: string;
  lintErrors: string[];
  verifySubstance?: boolean;
}

export interface GateCheckItem {
  id: string;
  name: string;
  passed: boolean;
  details: string;
  tokensUsed: 0;
}

export interface PreReviewGateResult {
  passed: boolean;
  gateTokens: 0;
  avoidedReviewIterations: number;
  estimatedTokensSaved: number;
  checks: GateCheckItem[];
  uncoveredReqsInCode: string[];
  uncoveredReqsInTests: string[];
  uncheckedTasks: string[];
  consistencyErrors: string[];
  substanceErrors: string[];
  conciseReport: string;
  reportTokens: number;
}

function isTestFilePath(filePath: string): boolean {
  return (
    filePath.startsWith('tests/') ||
    filePath.includes('/tests/') ||
    filePath.includes('/test/') ||
    /\.test\.[a-z]+$|^test_.*\.py$|_test\.go$|Test\.java$/.test(filePath)
  );
}

/**
 * Verifies that test files covering @spec:REQ-XX actually import local source modules,
 * define real test cases, and use substantive assertions (not empty stubs).
 */
export function verifyTestSubstance(
  files: GateSourceFile[],
  reqIds: string[],
  targetTestFiles: string[] = []
): string[] {
  const errors: string[] = [];
  const testFiles = files.filter((f) => f.isTest || isTestFilePath(f.path));
  if (testFiles.length === 0) {
    return ['No test files found in repository'];
  }

  const substantiveAssertionRe =
    /\b(?:assert\.(?:equal|deepEqual|strictEqual|notEqual|throws|rejects|doesNotThrow|doesNotReject|match|ok)\(|expect\(|self\.assert(?:Equal|True|False|Raises|In|IsNotNone)|t\.(?:Error|Fatal|Errorf|Fatalf)|assertEquals|assertTrue|assertFalse|assertThrows)\b/;
  const trivialOnlyRe = /^\s*assert(?:\.ok)?\s*\(\s*(?:true|1)\s*\)\s*;?\s*$/;

  const targetTestSet = new Set(targetTestFiles);
  const candidateTests =
    targetTestSet.size > 0
      ? testFiles.filter((f) => targetTestSet.has(f.path))
      : testFiles;

  const reqTestFiles = candidateTests.filter((f) =>
    reqIds.some((reqId) => f.content.includes(`@spec:${reqId}`) || f.content.includes(reqId))
  );

  if (reqIds.length > 0 && reqTestFiles.length === 0) {
    errors.push(
      targetTestSet.size > 0
        ? `Target test file(s) (${Array.from(targetTestSet).join(', ')}) missing or do not cover any REQ-XX`
        : 'No test file covers any REQ-XX from the OpenSpec change'
    );
    return errors;
  }

  for (const tf of reqTestFiles) {
    const lines = tf.content.split(/\r?\n/);
    const hasLocalImport =
      /from\s+['"]\.\.?\/.*src\/|from\s+src\.|import\s+src\./.test(tf.content) ||
      /from\s+['"]\.\.?\//.test(tf.content);
    const hasTestBlock =
      /\b(?:test|it)\s*\(|def\s+test_|func\s+Test|@Test\b/.test(tf.content);
    const substantiveLines = lines.filter(
      (l) => substantiveAssertionRe.test(l) && !trivialOnlyRe.test(l)
    );

    if (!hasLocalImport) {
      errors.push(`${tf.path}: missing import of implementation module under src/`);
    }
    if (!hasTestBlock) {
      errors.push(`${tf.path}: missing test(...) / def test_... block`);
    }
    if (substantiveLines.length === 0) {
      errors.push(`${tf.path}: contains no substantive assertions verifying implementation behavior`);
    }
  }

  return errors;
}

export function runPreReviewGate(input: GateExecutionInput): PreReviewGateResult {
  const graph = parseOpenSpecBundle(input.bundle);

  // 1. Check tasks.md completion
  const uncheckedTasks = graph.tasks.filter((t) => !t.completed).map((t) => t.id);
  const tasksCheckPassed = uncheckedTasks.length === 0;

  // 2. Check @spec:REQ-XX markers in code & tests (scoped to task target files when declared)
  const codeFiles = input.files.filter((f) => !f.isTest && !isTestFilePath(f.path));
  const testFiles = input.files.filter((f) => f.isTest || isTestFilePath(f.path));

  const reqToCodeTargets = new Map<string, Set<string>>();
  const reqToTestTargets = new Map<string, Set<string>>();
  const allTargetTests = new Set<string>();

  for (const t of graph.tasks) {
    for (const target of t.targetFiles) {
      const isTestTarget = isTestFilePath(target);
      if (isTestTarget) allTargetTests.add(target);
      for (const reqId of t.linkedReqs) {
        const map = isTestTarget ? reqToTestTargets : reqToCodeTargets;
        if (!map.has(reqId)) map.set(reqId, new Set());
        map.get(reqId)!.add(target);
      }
    }
  }

  const fullCodeCorpus = codeFiles.map((f) => f.content).join('\n');
  const fullTestCorpus = testFiles.map((f) => f.content).join('\n');

  const uncoveredReqsInCode: string[] = [];
  const uncoveredReqsInTests: string[] = [];

  for (const req of graph.requirements) {
    const marker = `@spec:${req.id}`;

    const declaredCodeTargets = reqToCodeTargets.get(req.id);
    const scopedCodeCorpus =
      declaredCodeTargets && declaredCodeTargets.size > 0
        ? codeFiles
            .filter((f) => declaredCodeTargets.has(f.path))
            .map((f) => f.content)
            .join('\n')
        : fullCodeCorpus;
    if (!scopedCodeCorpus.includes(marker) && !scopedCodeCorpus.includes(req.id)) {
      uncoveredReqsInCode.push(req.id);
    }

    const declaredTestTargets = reqToTestTargets.get(req.id);
    const scopedTestCorpus =
      declaredTestTargets && declaredTestTargets.size > 0
        ? testFiles
            .filter((f) => declaredTestTargets.has(f.path))
            .map((f) => f.content)
            .join('\n')
        : fullTestCorpus;
    if (!scopedTestCorpus.includes(marker) && !scopedTestCorpus.includes(req.id)) {
      uncoveredReqsInTests.push(req.id);
    }
  }

  const coveragePassed =
    uncoveredReqsInCode.length === 0 && uncoveredReqsInTests.length === 0;

  // 3. Check specs <-> design <-> tasks consistency
  const specReqIds = new Set(graph.requirements.map((r) => r.id));
  const designIds = new Set(graph.designSections.map((d) => d.id));
  const consistencyErrors: string[] = [];

  for (const des of graph.designSections) {
    for (const reqId of des.linkedReqs) {
      if (!specReqIds.has(reqId)) {
        consistencyErrors.push(`${des.id} references unknown ${reqId}`);
      }
    }
  }
  for (const tsk of graph.tasks) {
    for (const reqId of tsk.linkedReqs) {
      if (!specReqIds.has(reqId)) {
        consistencyErrors.push(`${tsk.id} references unknown ${reqId}`);
      }
    }
    for (const desId of tsk.linkedDesigns) {
      if (!designIds.has(desId)) {
        consistencyErrors.push(`${tsk.id} references unknown ${desId}`);
      }
    }
  }

  // Ensure every requirement appears in at least one task
  const taskCoveredReqs = new Set(graph.tasks.flatMap((t) => t.linkedReqs));
  for (const reqId of specReqIds) {
    if (!taskCoveredReqs.has(reqId)) {
      consistencyErrors.push(`${reqId} is not mapped to any task in tasks.md`);
    }
  }

  const consistencyPassed = consistencyErrors.length === 0;

  // 4. Test runner check & optional substance check
  const substanceErrors = input.verifySubstance
    ? verifyTestSubstance(
        input.files,
        graph.requirements.map((r) => r.id),
        Array.from(allTargetTests)
      )
    : [];
  const testsPassed = input.testsPassing && substanceErrors.length === 0;

  // 5. Linter / typecheck check
  const lintPassed = input.lintErrors.length === 0;

  const checks: GateCheckItem[] = [
    {
      id: 'tasks_completed',
      name: 'Задачи tasks.md закрыты',
      passed: tasksCheckPassed,
      details: tasksCheckPassed
        ? `${graph.tasks.length}/${graph.tasks.length} задач выполнены`
        : `Не завершены: ${uncheckedTasks.join(', ')}`,
      tokensUsed: 0,
    },
    {
      id: 'req_coverage',
      name: '100% покрытие REQ в коде и тестах',
      passed: coveragePassed,
      details: coveragePassed
        ? `${graph.requirements.length}/${graph.requirements.length} REQ подтверждены @spec:REQ-XX`
        : [
            uncoveredReqsInCode.length
              ? `Нет в коде: ${uncoveredReqsInCode.join(', ')}`
              : '',
            uncoveredReqsInTests.length
              ? `Нет в тестах: ${uncoveredReqsInTests.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('; '),
      tokensUsed: 0,
    },
    {
      id: 'artifact_consistency',
      name: 'Согласованность specs ↔ design ↔ tasks',
      passed: consistencyPassed,
      details: consistencyPassed
        ? `Граф трассировки валиден (${graph.edges.length} связей)`
        : consistencyErrors.join('; '),
      tokensUsed: 0,
    },
    {
      id: 'tests_green',
      name: 'Локальный прогон тестов',
      passed: testsPassed,
      details: testsPassed
        ? '100% unit & integration тестов зелёные'
        : [
            !input.testsPassing ? input.failingTestSnippet || 'Обнаружены падения тестов' : '',
            ...substanceErrors,
          ]
            .filter(Boolean)
            .join('; '),
      tokensUsed: 0,
    },
    {
      id: 'lint_types',
      name: 'Линтер и проверка типов',
      passed: lintPassed,
      details: lintPassed
        ? '0 ошибок типов и линтинга'
        : input.lintErrors.join('; '),
      tokensUsed: 0,
    },
  ];

  const passed = checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);

  // Each failed gate catches deterministic bugs that otherwise cost 1–3 LLM review iterations (~4200 tokens/iter)
  const avoidedReviewIterations = passed ? 2 : Math.min(3, failedChecks.length + 1);
  const estimatedTokensSaved = avoidedReviewIterations * 4250;

  const conciseReport = passed
    ? `[GATE PASS · 0 LLM tokens] All ${checks.length} deterministic checks green. Ready for single-pass semantic LLM review.`
    : [
        `[GATE BLOCKED · 0 LLM tokens] Fix ${failedChecks.length} deterministic issue(s) before LLM review:`,
        ...failedChecks.map((c) => `- ${c.id}: ${c.details}`),
      ].join('\n');

  return {
    passed,
    gateTokens: 0,
    avoidedReviewIterations,
    estimatedTokensSaved,
    checks,
    uncoveredReqsInCode,
    uncoveredReqsInTests,
    uncheckedTasks,
    consistencyErrors,
    substanceErrors,
    conciseReport,
    reportTokens: estimateTokens(conciseReport),
  };
}
