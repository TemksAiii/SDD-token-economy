import { estimateTokens, shortBlockHash } from './tokens';

export interface OpenSpecBundle {
  changeId: string;
  proposalMd: string;
  specsMd: Record<string, string>;
  designMd: string;
  tasksMd: string;
}

export interface RequirementNode {
  id: string;
  domain: string;
  title: string;
  body: string;
  tokens: number;
}

export interface DesignSectionNode {
  id: string;
  title: string;
  linkedReqs: string[];
  body: string;
  tokens: number;
}

export interface TaskNode {
  id: string;
  title: string;
  completed: boolean;
  linkedReqs: string[];
  linkedDesigns: string[];
  targetFiles: string[];
  rawLine: string;
}

export interface TraceabilityGraph {
  changeId: string;
  requirements: RequirementNode[];
  designSections: DesignSectionNode[];
  tasks: TaskNode[];
  edges: Array<{ from: string; to: string; kind: 'REQ->DES' | 'DES->TSK' | 'REQ->TSK' }>;
  totalMonolithicTokens: number;
}

export interface StateCapsule {
  changeId: string;
  completedTasks: string[];
  exportedContracts: Array<{ file: string; symbol: string; reqs: string[] }>;
  activeConstraints: string[];
  hash: string;
  tokens: number;
}

export interface TaskSliceResult {
  task: TaskNode;
  proposalSummary: string;
  requirements: RequirementNode[];
  designSections: DesignSectionNode[];
  stateCapsule: StateCapsule;
  compiledPromptBundle: string;
  monolithicTokens: number;
  slicedTokens: number;
  reductionPct: number;
}

function extractIds(text: string, prefix: 'REQ' | 'DES' | 'TSK'): string[] {
  const re = new RegExp(`\\b${prefix}-\\d{2,3}\\b`, 'g');
  const matches = text.match(re) ?? [];
  return Array.from(new Set(matches));
}

export function parseOpenSpecBundle(bundle: OpenSpecBundle): TraceabilityGraph {
  const requirements: RequirementNode[] = [];
  for (const [domain, md] of Object.entries(bundle.specsMd)) {
    const sections = md.split(/(?=^###\s+\[?REQ-\d+)/m);
    for (const sec of sections) {
      const headerMatch = sec.match(/^###\s+\[?(REQ-\d{2,3})\]?[:\s-]*(.+)$/m);
      if (headerMatch) {
        const id = headerMatch[1];
        const title = headerMatch[2].trim();
        const body = sec.trim();
        requirements.push({
          id,
          domain,
          title,
          body,
          tokens: estimateTokens(body),
        });
      }
    }
  }

  const designSections: DesignSectionNode[] = [];
  const designChunks = bundle.designMd.split(/(?=^##\s+\[?DES-\d+)/m);
  for (const chunk of designChunks) {
    const headerMatch = chunk.match(/^##\s+\[?(DES-\d{2,3})\]?[:\s-]*(.+)$/m);
    if (headerMatch) {
      const id = headerMatch[1];
      const title = headerMatch[2].trim();
      const body = chunk.trim();
      designSections.push({
        id,
        title,
        linkedReqs: extractIds(body, 'REQ'),
        body,
        tokens: estimateTokens(body),
      });
    }
  }

  const tasks: TaskNode[] = [];
  const taskLines = bundle.tasksMd.split(/\r?\n/);
  for (const line of taskLines) {
    const m = line.match(/^-\s+\[([ xX])\]\s+\[?(TSK-\d{2,3})\]?[:\s-]*(.+)$/);
    if (m) {
      const completed = m[1].toLowerCase() === 'x';
      const id = m[2];
      const rest = m[3];
      const linkedReqs = extractIds(rest, 'REQ');
      const linkedDesigns = extractIds(rest, 'DES');
      const fileMatches = rest.match(/`([^`]+\.[a-zA-Z0-9]+)`/g) ?? [];
      const targetFiles = fileMatches.map((f) => f.replace(/`/g, ''));
      const cleanTitle = rest
        .replace(/\((?:REQ|DES)-[^)]+\)/g, '')
        .replace(/\[(?:REQ|DES)-\d+\]/g, '')
        .trim();

      tasks.push({
        id,
        title: cleanTitle,
        completed,
        linkedReqs,
        linkedDesigns,
        targetFiles,
        rawLine: line,
      });
    }
  }

  const edges: TraceabilityGraph['edges'] = [];
  for (const des of designSections) {
    for (const reqId of des.linkedReqs) {
      edges.push({ from: reqId, to: des.id, kind: 'REQ->DES' });
    }
  }
  for (const tsk of tasks) {
    for (const desId of tsk.linkedDesigns) {
      edges.push({ from: desId, to: tsk.id, kind: 'DES->TSK' });
    }
    for (const reqId of tsk.linkedReqs) {
      edges.push({ from: reqId, to: tsk.id, kind: 'REQ->TSK' });
    }
  }

  const allSpecText = [
    bundle.proposalMd,
    ...Object.values(bundle.specsMd),
    bundle.designMd,
    bundle.tasksMd,
  ].join('\n\n');

  return {
    changeId: bundle.changeId,
    requirements,
    designSections,
    tasks,
    edges,
    totalMonolithicTokens: estimateTokens(allSpecText),
  };
}

export function buildStateCapsule(
  graph: TraceabilityGraph,
  completedTaskIds: string[],
  knownContracts: Array<{ taskId: string; file: string; symbol: string; reqs: string[] }>
): StateCapsule {
  const completedSet = new Set(completedTaskIds);
  const exportedContracts = knownContracts
    .filter((c) => completedSet.has(c.taskId))
    .map(({ file, symbol, reqs }) => ({ file, symbol, reqs }));

  const activeConstraints = [
    'Preserve 100% REQ coverage & @spec:REQ-XX test markers',
    'Use Hashline range patches (start#hash..end#hash) for edits',
    'No model routing; strictly task-scoped micro-session',
  ];

  const payload = JSON.stringify({
    changeId: graph.changeId,
    completedTasks: completedTaskIds,
    exportedContracts,
    activeConstraints,
  });

  return {
    changeId: graph.changeId,
    completedTasks: completedTaskIds,
    exportedContracts,
    activeConstraints,
    hash: shortBlockHash(payload),
    tokens: estimateTokens(payload),
  };
}

export function sliceSpecForTask(
  bundle: OpenSpecBundle,
  taskId: string,
  completedTaskIds: string[],
  knownContracts: Array<{ taskId: string; file: string; symbol: string; reqs: string[] }> = []
): TaskSliceResult {
  const graph = parseOpenSpecBundle(bundle);
  const task = graph.tasks.find((t) => t.id === taskId) ?? graph.tasks[0];
  if (!task) {
    throw new Error(`Task ${taskId} not found in tasks.md`);
  }

  const reqIdSet = new Set(task.linkedReqs);
  const desIdSet = new Set(task.linkedDesigns);

  // Fallback: pull designs linked to the task's REQs only when task has no explicit DES links
  if (desIdSet.size === 0) {
    for (const des of graph.designSections) {
      if (des.linkedReqs.some((r) => reqIdSet.has(r))) {
        desIdSet.add(des.id);
      }
    }
  }

  const slicedReqs = graph.requirements.filter((r) => reqIdSet.has(r.id));
  const slicedDesigns = graph.designSections.filter((d) => desIdSet.has(d.id));

  // Extract concise 3-line summary from proposal.md (Goal + Scope)
  const proposalLines = bundle.proposalMd
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.startsWith('## '))
    .slice(0, 3);
  const proposalSummary = proposalLines.join(' ');

  const stateCapsule = buildStateCapsule(graph, completedTaskIds, knownContracts);

  // Prefix-stable prompt ordering (Static Proposal Summary -> Task Spec -> State Capsule)
  const compiledParts = [
    `[STATIC_PROPOSAL_GLOSSARY]\nChange: ${bundle.changeId}\n${proposalSummary}`,
    `[TASK_TARGET]\n${task.id}: ${task.title}\nTarget files: ${task.targetFiles.join(', ') || 'auto'}`,
    `[SLICED_REQUIREMENTS (${slicedReqs.length}/${graph.requirements.length})]\n${slicedReqs
      .map((r) => r.body)
      .join('\n\n')}`,
    `[SLICED_DESIGN (${slicedDesigns.length}/${graph.designSections.length})]\n${slicedDesigns
      .map((d) => d.body)
      .join('\n\n')}`,
    `[STATE_CAPSULE @${stateCapsule.hash}]\n${JSON.stringify(
      {
        completed: stateCapsule.completedTasks,
        contracts: stateCapsule.exportedContracts,
      },
      null,
      2
    )}`,
  ];

  const compiledPromptBundle = compiledParts.join('\n\n');
  const slicedTokens = estimateTokens(compiledPromptBundle);
  const monolithicTokens = graph.totalMonolithicTokens;
  const reductionPct =
    monolithicTokens > 0
      ? Number((((monolithicTokens - slicedTokens) / monolithicTokens) * 100).toFixed(1))
      : 0;

  return {
    task,
    proposalSummary,
    requirements: slicedReqs,
    designSections: slicedDesigns,
    stateCapsule,
    compiledPromptBundle,
    monolithicTokens,
    slicedTokens,
    reductionPct,
  };
}
