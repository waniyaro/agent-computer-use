import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolProfile } from './types.js';

export const MINIMAL_TOOLS_SET: ReadonlySet<string> = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'launch_app',
  'kill_app',
  // Custom proxy tools:
  'ensure_app_running',
  'task_journal_append',
  'task_journal_read',
  'task_journal_list',
  // Vision & coordinate engine tools:
  'visual_click',
  'press_hotkey',
  'get_window_screenshot',
]);

export function filterToolsByProfile(tools: Tool[], profile: ToolProfile): Tool[] {
  if (profile === 'full') {
    return tools;
  }
  return tools.filter((tool) => MINIMAL_TOOLS_SET.has(tool.name));
}

export function isToolAllowedInProfile(toolName: string, profile: ToolProfile): boolean {
  if (profile === 'full') {
    return true;
  }
  return MINIMAL_TOOLS_SET.has(toolName);
}
