/**
 * Deterministic token estimation & short content hashing utilities.
 * Calibrated for mixed code + Cyrillic/English markdown (~3.6 chars/token average).
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Count words/identifiers, punctuation clusters, and Cyrillic/Unicode runs
  const chunks = trimmed.match(/[A-Za-z0-9_]+|[\u0400-\u04FF]+|\s+|[^\sA-Za-z0-9_\u0400-\u04FF]+/g);
  if (!chunks) return Math.ceil(trimmed.length / 3.6);
  let count = 0;
  for (const chunk of chunks) {
    if (/^\s+$/.test(chunk)) {
      if (chunk.includes('\n')) count += 0.35;
      continue;
    }
    if (/^[\u0400-\u04FF]+$/.test(chunk)) {
      // Cyrillic words tokenize slightly denser (~2.4 chars/token)
      count += Math.max(1, Math.ceil(chunk.length / 2.6));
    } else if (/^[A-Za-z0-9_]+$/.test(chunk)) {
      count += Math.max(1, Math.ceil(chunk.length / 4.2));
    } else {
      count += Math.max(1, Math.ceil(chunk.length / 2.2));
    }
  }
  return Math.max(1, Math.round(count));
}

/**
 * Computes a deterministic 3-character hex hash for a single source line.
 */
export function shortLineHash(line: string): string {
  const normalized = line.replace(/\r$/, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 0xfff).toString(16).padStart(3, '0');
}

/**
 * Computes an 8-char hex fingerprint for a whole file or block (ETag style).
 */
export function shortBlockHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(4, '0').slice(0, 4);
  const part2 = (h2 >>> 0).toString(16).padStart(4, '0').slice(0, 4);
  return `${part1}${part2}`;
}
