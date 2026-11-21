import path from 'node:path';

export const WORKSPACE_ROOT = path.resolve(process.cwd());
export const RUNS_ROOT = path.resolve(WORKSPACE_ROOT, '.spectrim-runs');

/**
 * Confinement check: ensures a user/caller-supplied relative or absolute path
 * stays strictly inside allowedBaseDir (preventing path traversal).
 */
export function resolveConfinedPath(
  inputPath: string,
  allowedBaseDir = WORKSPACE_ROOT
): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }
  const normalizedBase = path.resolve(allowedBaseDir);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(normalizedBase, inputPath);

  if (
    resolved !== normalizedBase &&
    !resolved.startsWith(normalizedBase + path.sep)
  ) {
    throw new Error(`Access denied: path "${inputPath}" escapes workspace root`);
  }
  return resolved;
}

export function sanitizeIdSegment(segment: string, label = 'identifier'): string {
  if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment.includes('..')) {
    throw new Error(`Invalid ${label}: "${segment}"`);
  }
  return segment;
}
