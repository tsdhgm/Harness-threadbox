import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface ClipboardOptions {
  /** writes to the terminal (for OSC 52) */
  write: (s: string) => void;
  /** spawn external clipboard tools (wl-copy, xclip, pbcopy, clip.exe, tmux) */
  allowExternal: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface CopyResult {
  /** human-readable list of the methods that succeeded, e.g. "wl-copy, OSC 52" */
  methods: string[];
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (env['WSL_DISTRO_NAME'] || env['WSL_INTEROP']) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** External tools to try, most specific first. The first one that exits 0 wins. */
export function clipboardCommands(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Array<{ name: string; cmd: string; args: string[] }> {
  const c: Array<{ name: string; cmd: string; args: string[] }> = [];
  if (platform === 'darwin') c.push({ name: 'pbcopy', cmd: 'pbcopy', args: [] });
  if (platform === 'win32') c.push({ name: 'clip', cmd: 'clip', args: [] });
  if (env['WAYLAND_DISPLAY']) c.push({ name: 'wl-copy', cmd: 'wl-copy', args: [] });
  if (env['DISPLAY']) {
    c.push({ name: 'xclip', cmd: 'xclip', args: ['-selection', 'clipboard'] });
    c.push({ name: 'xsel', cmd: 'xsel', args: ['--clipboard', '--input'] });
  }
  if (platform === 'linux' && isWsl(env)) c.push({ name: 'clip.exe', cmd: 'clip.exe', args: [] });
  // tmux buffer (paste with prefix+]); -w also forwards to the outer terminal's clipboard (tmux ≥ 3.2)
  if (env['TMUX']) c.push({ name: 'tmux buffer', cmd: 'tmux', args: ['load-buffer', '-w', '-'] });
  return c;
}

function runWithStdin(cmd: string, args: string[], input: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

/** OSC 52: ask the terminal emulator itself to set the clipboard (works over SSH; some terminals must opt in). */
export function osc52(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${b64}\x07`;
}

/**
 * Copy `text` to the clipboard by every means available: the first working external
 * tool, plus OSC 52 to the terminal. Never throws; the result lists what succeeded.
 */
export async function copyToClipboard(text: string, opts: ClipboardOptions): Promise<CopyResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const methods: string[] = [];
  if (opts.allowExternal) {
    for (const c of clipboardCommands(env, platform)) {
      if (await runWithStdin(c.cmd, c.args, text)) {
        methods.push(c.name);
        break;
      }
    }
  }
  opts.write(osc52(text));
  methods.push('OSC 52');
  return { methods };
}
