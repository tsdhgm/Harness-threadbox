import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Claude Code encodes the realpath of cwd by replacing every char outside [A-Za-z0-9-] with '-'. */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
}

export function claudeRootDir(override?: string): string {
  if (override) return path.resolve(override);
  const env = process.env['CLAUDE_CONFIG_DIR'];
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), '.claude');
}

export function projectsDir(root: string): string {
  return path.join(root, 'projects');
}

export function sessionsRegistryDir(root: string): string {
  return path.join(root, 'sessions');
}

export async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function projectDirFor(root: string, workspacePath: string): Promise<string> {
  const rp = await realpathOr(workspacePath);
  return path.join(projectsDir(root), encodeProjectPath(rp));
}

export function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/, '');
}

export function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') && !name.startsWith('agent-');
}
