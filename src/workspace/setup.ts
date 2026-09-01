import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DockerConfig, WorkspaceConfig } from '../config/schema.js';
import { runInDocker } from '../docker/runner.js';
import { redactFile, redactJson, type Redaction } from '../redaction.js';

export interface SetupWorkspaceInput {
  image: string;
  workspaceDir: string;
  workspace: WorkspaceConfig;
  configDir: string;
  docker: DockerConfig;
  runDir: string;
  caseId: string;
  agentName: string;
  redactions: readonly Redaction[];
}

export async function setupWorkspace(input: SetupWorkspaceInput): Promise<void> {
  const commands = input.workspace.setup ?? [];
  if (commands.length === 0) return;

  const setupRoot = join(input.runDir, 'workspace-setup');
  await mkdir(setupRoot, { recursive: true });

  for (const [index, command] of commands.entries()) {
    const commandNumber = String(index + 1).padStart(2, '0');
    const commandDir = join(setupRoot, commandNumber);
    await mkdir(commandDir, { recursive: true });

    const result = await runInDocker({
      image: input.image,
      workspaceDir: input.workspaceDir,
      workspaceTarget: input.workspace.containerPath,
      configDir: input.configDir,
      configTarget: input.docker.configRoot,
      home: input.docker.home,
      argv: [command.command, ...command.args],
      workdir: command.cwd ?? input.workspace.containerPath,
      envNames: [],
      network: command.network ?? { mode: 'none' },
      configMounts: [],
      caseId: `${input.caseId}-workspace-setup-${commandNumber}`,
      agentName: input.agentName,
      timeoutMs: command.timeoutMs ?? input.docker.timeoutMs,
      stdoutFile: join(commandDir, 'stdout.log'),
      stderrFile: join(commandDir, 'stderr.log'),
    });

    await redactFile(result.stdoutPath, input.redactions);
    await redactFile(result.stderrPath, input.redactions);
    await writeFile(
      join(commandDir, 'command.redacted.json'),
      `${JSON.stringify(redactJson(result.commandMetadata, input.redactions), null, 2)}\n`,
    );
    await writeFile(
      join(commandDir, 'result.json'),
      `${JSON.stringify({
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        errorMessage: result.errorMessage,
      }, null, 2)}\n`,
    );

    if (result.exitCode !== 0 || result.timedOut || result.errorMessage) {
      const reason = result.timedOut
        ? `timed out after ${command.timeoutMs ?? input.docker.timeoutMs}ms`
        : result.errorMessage ?? `exited with code ${result.exitCode ?? 'unknown'}`;
      throw new Error(`Workspace setup command ${index + 1} (${command.command}) ${reason}; see workspace-setup/${commandNumber}`);
    }
  }
}
