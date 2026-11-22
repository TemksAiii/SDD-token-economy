import { parse, type ParserPlugin } from '@babel/parser';
import { estimateTokens, shortLineHash } from './tokens';

export type SupportedLanguage = 'typescript' | 'python' | 'go' | 'java';
export type LodLevel = 'LOD0' | 'LOD1' | 'LOD2';

export interface HashedLine {
  lineNumber: number;
  hash: string;
  content: string;
  formatted: string;
}

export interface HashlinePatchRequest {
  startLine: number;
  startHash: string;
  endLine: number;
  endHash: string;
  replacement: string;
}

export interface HashlinePatchResult {
  ok: boolean;
  updatedContent: string;
  formattedPreview: string;
  error?: string;
  naiveRewriteTokens: number;
  hashlinePatchTokens: number;
  savedOutputTokens: number;
}

export interface AstLodView {
  level: LodLevel;
  filePath: string;
  language: SupportedLanguage;
  rendered: string;
  rawTokens: number;
  lodTokens: number;
  reductionPct: number;
}

export function formatWithHashlines(content: string): {
  lines: HashedLine[];
  formatted: string;
} {
  const rawLines = content.split(/\r?\n/);
  const lines: HashedLine[] = rawLines.map((line, idx) => {
    const lineNumber = idx + 1;
    const hash = shortLineHash(line);
    return {
      lineNumber,
      hash,
      content: line,
      formatted: `L${lineNumber}#${hash}: ${line}`,
    };
  });

  return {
    lines,
    formatted: lines.map((l) => l.formatted).join('\n'),
  };
}

/**
 * Deterministic Hash-Anchored Line Patcher.
 * Prevents str_replace mismatch retries by verifying exact start/end line hashes.
 */
export function applyHashlinePatch(
  content: string,
  patch: HashlinePatchRequest
): HashlinePatchResult {
  const rawLines = content.split(/\r?\n/);
  const { startLine, startHash, endLine, endHash, replacement } = patch;

  const patchInstructionText = `PATCH L${startLine}#${startHash}..L${endLine}#${endHash}\n${replacement}`;
  const hashlinePatchTokens = estimateTokens(patchInstructionText);
  const oldSlice = rawLines.slice(Math.max(0, startLine - 1), endLine).join('\n');
  const naiveRewriteTokens = estimateTokens(
    `OLD:\n${oldSlice}\nNEW:\n${replacement}`
  );

  if (startLine < 1 || endLine > rawLines.length || startLine > endLine) {
    return {
      ok: false,
      updatedContent: content,
      formattedPreview: formatWithHashlines(content).formatted,
      error: `Range out of bounds: L${startLine}..L${endLine} (file has ${rawLines.length} lines).`,
      naiveRewriteTokens,
      hashlinePatchTokens,
      savedOutputTokens: 0,
    };
  }

  const actualStartHash = shortLineHash(rawLines[startLine - 1]);
  const actualEndHash = shortLineHash(rawLines[endLine - 1]);

  if (actualStartHash !== startHash) {
    return {
      ok: false,
      updatedContent: content,
      formattedPreview: formatWithHashlines(content).formatted,
      error: `Anchor mismatch at L${startLine}: expected #${startHash}, found #${actualStartHash}. Re-read range before patching.`,
      naiveRewriteTokens,
      hashlinePatchTokens,
      savedOutputTokens: 0,
    };
  }

  if (actualEndHash !== endHash) {
    return {
      ok: false,
      updatedContent: content,
      formattedPreview: formatWithHashlines(content).formatted,
      error: `Anchor mismatch at L${endLine}: expected #${endHash}, found #${actualEndHash}. Re-read range before patching.`,
      naiveRewriteTokens,
      hashlinePatchTokens,
      savedOutputTokens: 0,
    };
  }

  const replacementLines = replacement === '' ? [] : replacement.split(/\r?\n/);
  const nextLines = [
    ...rawLines.slice(0, startLine - 1),
    ...replacementLines,
    ...rawLines.slice(endLine),
  ];
  const updatedContent = nextLines.join('\n');

  return {
    ok: true,
    updatedContent,
    formattedPreview: formatWithHashlines(updatedContent).formatted,
    naiveRewriteTokens,
    hashlinePatchTokens,
    savedOutputTokens: Math.max(0, naiveRewriteTokens - hashlinePatchTokens),
  };
}

/**
 * Fold executable bodies while keeping module declarations, class members and
 * source anchors. Other stacks use a line-based outline.
 */
function extractTypeScriptSkeleton(
  content: string,
  filePath: string,
  lines: string[],
  heading: string
): string {
  const plugins: ParserPlugin[] = [];
  if (!/\.[cm]?jsx?$/.test(filePath)) plugins.push('typescript');
  if (/\.[jt]sx$/.test(filePath)) plugins.push('jsx');

  try {
    const ast = parse(content, { sourceType: 'unambiguous', plugins });
    const foldedBodies: Array<{ start: number; end: number; text: string }> = [];
    const fold = (node: { type: string; start?: number | null; end?: number | null } | null | undefined) => {
      if (node?.start == null || node.end == null) return;
      foldedBodies.push({
        start: node.start,
        end: node.end,
        text: node.type === 'BlockStatement' || node.type === 'StaticBlock'
          ? '{ /* ... */ }'
          : '/* ... */',
      });
    };

    for (const statement of ast.program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ||
        statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
      if (!declaration) continue;
      switch (declaration.type) {
        case 'FunctionDeclaration':
          fold(declaration.body);
          break;
        case 'ClassDeclaration':
        case 'ClassExpression':
          for (const member of declaration.body.body) {
            if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
              fold(member.body);
            } else if (member.type === 'StaticBlock') {
              fold(member);
            } else if (
              (member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') &&
              (member.value?.type === 'ArrowFunctionExpression' || member.value?.type === 'FunctionExpression')
            ) {
              fold(member.value.body);
            }
          }
          break;
        case 'VariableDeclaration':
          for (const { init } of declaration.declarations) {
            if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
              fold(init.body);
            }
          }
          break;
        case 'ArrowFunctionExpression':
        case 'FunctionExpression':
          fold(declaration.body);
          break;
      }
    }

    if (foldedBodies.length === 0) return formatWithHashlines(content).formatted;
    const lineOffsets = [0];
    for (const match of content.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    const visible = new Map<number, string>();
    const appendSource = (start: number, end: number) => {
      let line = lineOffsets.findIndex((offset, i) => offset <= start &&
        (lineOffsets[i + 1] ?? Infinity) > start);
      while (start < end) {
        const next = Math.min(end, lineOffsets[line + 1] ?? end);
        const segment = content.slice(start, next).replace(/\r?\n$/, '');
        visible.set(line, (visible.get(line) ?? '') + segment);
        start = next;
        line++;
      }
    };
    let cursor = 0;
    for (const body of foldedBodies) {
      appendSource(cursor, body.start);
      const bodyLine = lineOffsets.findIndex((offset, i) => offset <= body.start &&
        (lineOffsets[i + 1] ?? Infinity) > body.start);
      visible.set(bodyLine, (visible.get(bodyLine) ?? '') + body.text);
      cursor = body.end;
    }
    appendSource(cursor, content.length);
    for (const comment of ast.comments ?? []) {
      if (comment.value.includes('@spec:') && comment.loc &&
        !visible.has(comment.loc.start.line - 1)) {
        for (let line = comment.loc.start.line - 1; line < comment.loc.end.line; line++) {
          visible.set(line, lines[line]);
        }
      }
    }
    return [heading, ...Array.from(visible.entries())
      .sort(([a], [b]) => a - b)
      .filter(([, line]) => line.trim())
      .map(([line, rendered]) => `L${line + 1}#${shortLineHash(lines[line])}: ${rendered}`)]
      .join('\n');
  } catch {
    return formatWithHashlines(content).formatted;
  }
}

export function extractAstSkeleton(
  content: string,
  language: SupportedLanguage,
  filePath = 'module'
): string {
  const lines = content.split(/\r?\n/);
  const heading = `# LOD1 ${language === 'typescript' ? 'AST skeleton' : 'outline'}: ${filePath} (${language})`;
  const out: string[] = [heading];

  if (language === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('from ') ||
        trimmed.startsWith('@') ||
        trimmed.startsWith('class ') ||
        trimmed.startsWith('def ') ||
        trimmed.startsWith('async def ') ||
        trimmed.includes('@spec:')
      ) {
        const hash = shortLineHash(line);
        out.push(`L${i + 1}#${hash}: ${line}${trimmed.endsWith(':') ? ' ...' : ''}`);
        // Include single-line docstring if immediately following def/class
        if (
          (trimmed.startsWith('class ') ||
            trimmed.startsWith('def ') ||
            trimmed.startsWith('async def ')) &&
          i + 1 < lines.length &&
          lines[i + 1].trim().startsWith('"""')
        ) {
          out.push(`L${i + 2}#${shortLineHash(lines[i + 1])}: ${lines[i + 1]}`);
          i++;
        }
      }
    }
    return out.length > 1 ? out.join('\n') : formatWithHashlines(content).formatted;
  }

  if (language === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (
        trimmed.startsWith('package ') ||
        trimmed.startsWith('type ') ||
        trimmed.startsWith('func ') ||
        trimmed.includes('@spec:')
      ) {
        const hash = shortLineHash(line);
        out.push(
          `L${i + 1}#${hash}: ${line.replace(/\{\s*$/, '{ ... }')}`
        );
      }
    }
    return out.length > 1 ? out.join('\n') : formatWithHashlines(content).formatted;
  }

  if (language === 'java') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (
        trimmed.startsWith('package ') ||
        trimmed.startsWith('import ') ||
        trimmed.startsWith('@') ||
        /^(public|protected|private)?\s*(abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+/.test(trimmed) ||
        /^(public|protected|private)\s+(static\s+|synchronized\s+|final\s+)*[\w<>\[\], ?]+\s+\w+\s*\(/.test(trimmed) ||
        trimmed.includes('@spec:')
      ) {
        const hash = shortLineHash(line);
        out.push(`L${i + 1}#${hash}: ${line.replace(/\{\s*$/, '{ ... }')}`);
      }
    }
    return out.length > 1 ? out.join('\n') : formatWithHashlines(content).formatted;
  }

  if (language === 'typescript') {
    return extractTypeScriptSkeleton(content, filePath, lines, heading);
  }
  return formatWithHashlines(content).formatted;
}

export function renderAstLodView(
  filePath: string,
  content: string,
  language: SupportedLanguage,
  level: LodLevel,
  repoTreePaths: string[] = []
): AstLodView {
  const rawTokens = estimateTokens(content);
  let rendered = '';

  if (level === 'LOD0') {
    rendered = formatWithHashlines(content).formatted;
  } else if (level === 'LOD1') {
    rendered = extractAstSkeleton(content, language, filePath);
  } else {
    const treeList = repoTreePaths.length > 0 ? repoTreePaths : [filePath];
    const symbols = content
      .split(/\r?\n/)
      .map((l) => {
        const m = l.match(/(?:export\s+(?:async\s+)?function|export\s+class|export\s+interface|def|class|func)\s+([A-Za-z0-9_]+)/);
        return m ? m[1] : null;
      })
      .filter((s): s is string => Boolean(s));

    rendered = [
      `# AST-LOD2 Repository Map`,
      ...treeList.map((p) => (p === filePath ? `- ${p}  [exports: ${symbols.join(', ') || 'module'}]` : `- ${p}`)),
    ].join('\n');
  }

  const lodTokens = estimateTokens(rendered);
  const reductionPct =
    rawTokens > 0 ? Number((((rawTokens - lodTokens) / rawTokens) * 100).toFixed(1)) : 0;

  return {
    level,
    filePath,
    language,
    rendered,
    rawTokens,
    lodTokens,
    reductionPct,
  };
}
