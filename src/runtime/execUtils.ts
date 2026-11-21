import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function hasExecutable(bin: string): boolean {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

export interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Splits a command string into argv tokens without using a shell.
 */
export function splitCommandArgs(cmd: string): { bin: string; args: string[] } {
  const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ''));
  if (clean.length === 0) {
    throw new Error('Empty command');
  }
  return { bin: clean[0], args: clean.slice(1) };
}

export function runSafeCommand(
  bin: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<CommandOutput> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const started = Date.now();

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Command aborted'));
      return;
    }

    const binDir = path.resolve(process.cwd(), 'node_modules', '.bin');
    const currentPath = process.env.PATH || '';
    const nextPath = currentPath.split(path.delimiter).includes(binDir)
      ? currentPath
      : `${binDir}${path.delimiter}${currentPath}`;

    const child = spawn(bin, args, {
      cwd,
      shell: false,
      env: { ...process.env, PATH: nextPath },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGTERM');
      clearTimeout(timer);
      reject(new Error('Command aborted by caller'));
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        combined: `${stdout}\n${stderr}\n${err.message}`.trim(),
        durationMs: Date.now() - started,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const exitCode = typeof code === 'number' ? code : 1;
      resolve({
        exitCode,
        stdout,
        stderr,
        combined: [stdout, stderr].filter(Boolean).join('\n').trim(),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
