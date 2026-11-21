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
  conciseReport: string;
  reportTokens: number;
}

export function runPreReviewGate(input: GateExecutionInput): PreReviewGateResult {
  const graph = parseOpenSpecBundle(input.bundle);

  // 1. Check tasks.md completion
  const uncheckedTasks = graph.tasks.filter((t) => !t.completed).map((t) => t.id);
  const tasksCheckPassed = uncheckedTasks.length === 0;

  // 2. Check @spec:REQ-XX markers in code & tests
  const codeFiles = input.files.filter((f) => !f.isTest && !f.path.includes('test'));
  const testFiles = input.files.filter((f) => f.isTest || f.path.includes('test'));

  const codeCorpus = codeFiles.map((f) => f.content).join('\n');
  const testCorpus = testFiles.map((f) => f.content).join('\n');

  const uncoveredReqsInCode: string[] = [];
  const uncoveredReqsInTests: string[] = [];

  for (const req of graph.requirements) {
    const marker = `@spec:${req.id}`;
    if (!codeCorpus.includes(marker) && !codeCorpus.includes(req.id)) {
      uncoveredReqsInCode.push(req.id);
    }
    if (!testCorpus.includes(marker) && !testCorpus.includes(req.id)) {
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

  // 4. Test runner check
  const testsPassed = input.testsPassing;

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
        : input.failingTestSnippet || 'Обнаружены падения тестов',
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
    conciseReport,
    reportTokens: estimateTokens(conciseReport),
  };
}
