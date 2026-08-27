import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceGitConfig } from '../config/schema.js';

export interface GitWorkspaceSource {
  path: string;
  repository: string;
  commit: string;
}

export async function acquireGitWorkspace(source: WorkspaceGitConfig, timeoutMs = 300_000): Promise<GitWorkspaceSource> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-git-'));
  try {
    await runGit(path, ['init', '--quiet'], timeoutMs);
    await runGit(path, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', source.repository, source.commit], timeoutMs);
    await runGit(path, ['checkout', '--quiet', '--detach', '--force', source.commit], timeoutMs);
    const head = (await runGit(path, ['rev-parse', '--verify', 'HEAD'], timeoutMs)).trim().toLowerCase();
    if (head !== source.commit) {
      throw new Error(`Git source checkout resolved to ${head}, expected ${source.commit}`);
    }
    for (const remote of (await runGit(path, ['remote'], timeoutMs)).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
      await runGit(path, ['remote', 'remove', remote], timeoutMs);
    }
    return { path, repository: source.repository, commit: source.commit };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupGitWorkspace(source: GitWorkspaceSource | undefined): Promise<void> {
  if (source) await rm(source.path, { recursive: true, force: true });
}

async function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`git ${args[0]} failed with exit code ${code ?? 'unknown'}: ${stderr.trim() || stdout.trim() || 'no output'}`));
    });
  });
}
