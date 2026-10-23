import type { SessionIndexEntry } from '../core/types.js';
import type { RenderOptions, ToolsMode } from '../render/transcript.js';
import { type ParsedArgs, flagBool, flagNum, flagStr, useColor } from './args.js';

export function renderOptionsFromArgs(args: ParsedArgs, entry: SessionIndexEntry, isTTY: boolean, defaultWidth: number): RenderOptions {
  const toolsRaw = flagStr(args.flags, 'tools');
  const tools: ToolsMode = toolsRaw === 'full' || toolsRaw === 'hidden' || toolsRaw === 'collapsed' ? toolsRaw : 'collapsed';
  return {
    width: flagNum(args.flags, 'width') ?? defaultWidth,
    thinking: flagBool(args.flags, 'thinking'),
    tools,
    hideToolOnly: flagBool(args.flags, 'hide-tool-only'),
    showMeta: flagBool(args.flags, 'show-meta'),
    color: useColor(args.flags, isTTY),
    live: entry.live !== null,
    cwd: entry.project.cwd,
    ascii: flagBool(args.flags, 'ascii') || process.env['HTHREADBOX_ASCII'] === '1',
  };
}
