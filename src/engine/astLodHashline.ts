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
 * Multi-language AST-LOD1 skeleton extractor (signatures, types, exports, docstrings, @spec tags).
 */
export function extractAstSkeleton(
  content: string,
  language: SupportedLanguage,
  filePath = 'module'
): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [`# AST-LOD1 Skeleton: ${filePath} (${language})`];

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
    return out.join('\n');
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
    return out.join('\n');
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
    return out.join('\n');
  }

  // TypeScript / JavaScript
  const countBracesOutsideStrings = (src: string): number => {
    const stripped = src
      .replace(/\/\/.*$/, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');
    return (stripped.match(/\{/g)?.length ?? 0) - (stripped.match(/\}/g)?.length ?? 0);
  };
  const methodStartRe =
    /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+|override\s+|get\s+|set\s+)*(?:constructor|[A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>=]+>)?\s*\(/;

  let inInterfaceOrTypeBlock = false;
  let blockBraceDepth = 0;
  let classDepth = 0;
  let inMultiLineSig = false;
  let sigParenDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inMultiLineSig) {
      const hash = shortLineHash(line);
      sigParenDepth += (trimmed.match(/\(/g)?.length ?? 0) - (trimmed.match(/\)/g)?.length ?? 0);
      const endsSig = sigParenDepth <= 0 && (trimmed.endsWith('{') || trimmed.endsWith('{}') || trimmed.endsWith(';'));
      const renderedLine =
        endsSig && trimmed.endsWith('{') && !trimmed.endsWith('{}')
          ? `${line} /* ... */ }`
          : line;
      out.push(`L${i + 1}#${hash}: ${renderedLine}`);
      if (classDepth > 0) {
        classDepth = Math.max(0, classDepth + countBracesOutsideStrings(line));
      }
      if (endsSig) {
        inMultiLineSig = false;
        sigParenDepth = 0;
      }
      continue;
    }

    const isClassHeader =
      trimmed.startsWith('export class ') ||
      trimmed.startsWith('export abstract class ') ||
      trimmed.startsWith('class ') ||
      trimmed.startsWith('abstract class ');

    const isInterfaceOrTypeHeader =
      trimmed.startsWith('export interface ') ||
      trimmed.startsWith('interface ') ||
      (trimmed.startsWith('export type ') && trimmed.includes('{'));

    const isTopLevelDecl =
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export interface ') ||
      trimmed.startsWith('export type ') ||
      trimmed.startsWith('export enum ') ||
      isClassHeader ||
      trimmed.startsWith('export async function ') ||
      trimmed.startsWith('export function ') ||
      trimmed.startsWith('export const ') ||
      trimmed.startsWith('interface ') ||
      trimmed.includes('@spec:');

    if (isInterfaceOrTypeHeader) {
      const hash = shortLineHash(line);
      out.push(`L${i + 1}#${hash}: ${line}`);
      inInterfaceOrTypeBlock = true;
      blockBraceDepth = countBracesOutsideStrings(line);
      if (blockBraceDepth <= 0) {
        inInterfaceOrTypeBlock = false;
      }
      continue;
    } else if (inInterfaceOrTypeBlock) {
      blockBraceDepth += countBracesOutsideStrings(line);
      if (trimmed && !trimmed.startsWith('//')) {
        const hash = shortLineHash(line);
        out.push(`L${i + 1}#${hash}: ${line}`);
      }
      if (blockBraceDepth <= 0) {
        inInterfaceOrTypeBlock = false;
      }
      continue;
    }

    if (isClassHeader) {
      const hash = shortLineHash(line);
      out.push(`L${i + 1}#${hash}: ${line}`);
      classDepth += countBracesOutsideStrings(line);
      continue;
    }

    const isTopLevelMethodSig =
      classDepth === 1 &&
      methodStartRe.test(trimmed) &&
      !/^(?:if|for|while|switch|catch|return|throw|new)\b/.test(trimmed);

    const isStandaloneSig =
      !isTopLevelDecl &&
      classDepth === 0 &&
      /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+)*(?:constructor|[A-Za-z0-9_]+)\s*(?:<[^>{]+>)?\s*\([^;]*\)\s*(?::\s*[^\{;]+)?\s*\{?$/.test(
        trimmed
      ) &&
      !/^(?:if|for|while|switch|catch|return|throw|new)\b/.test(trimmed);

    if (isTopLevelMethodSig) {
      const hash = shortLineHash(line);
      const pDelta = (trimmed.match(/\(/g)?.length ?? 0) - (trimmed.match(/\)/g)?.length ?? 0);
      if (pDelta > 0 || (!trimmed.endsWith('{') && !trimmed.endsWith('{}') && !trimmed.endsWith(';'))) {
        inMultiLineSig = true;
        sigParenDepth = pDelta;
        out.push(`L${i + 1}#${hash}: ${line}`);
      } else {
        const folded =
          trimmed.endsWith('{') && !trimmed.endsWith('{}') ? `${line} /* ... */ }` : line;
        out.push(`L${i + 1}#${hash}: ${folded}`);
      }
      classDepth = Math.max(0, classDepth + countBracesOutsideStrings(line));
      continue;
    }

    if (classDepth > 0) {
      classDepth = Math.max(0, classDepth + countBracesOutsideStrings(line));
      if (trimmed.includes('@spec:')) {
        const hash = shortLineHash(line);
        out.push(`L${i + 1}#${hash}: ${line}`);
      }
      continue;
    }

    if (isTopLevelDecl || isStandaloneSig) {
      const hash = shortLineHash(line);
      const folded = trimmed.endsWith('{') ? `${line} /* ... */ }` : line;
      out.push(`L${i + 1}#${hash}: ${folded}`);
    }
  }
  return out.join('\n');
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
