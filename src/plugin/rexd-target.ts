import { tool, type ToolContext } from '@opencode-ai/plugin';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TARGETS_PATH = resolve(homedir(), '.config/rexd/targets.json');
const DEFAULT_STATE_DIR = '.opencode';
const DEFAULT_STATE_FILE = 'rexd-state.json';

interface TargetConfig {
  transport: 'ssh' | 'http' | 'ws';
  description?: string;
  defaultCwd?: string;
  workspaceRoots?: string[];
  rootPolicy?: { mode: string; extraRoots?: string[] };
  capabilities?: { shell?: boolean; fs?: boolean; pty?: boolean };
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  command?: string;
}

interface ProjectState {
  activeTargetAlias: string | null;
  lastUsedAt: number;
}

const targetsCache = new Map<string, TargetConfig>();

function loadTargets(): Record<string, TargetConfig> {
  if (targetsCache.size > 0) return Object.fromEntries(targetsCache);
  
  if (!existsSync(DEFAULT_TARGETS_PATH)) {
    return {};
  }
  
  try {
    const content = readFileSync(DEFAULT_TARGETS_PATH, 'utf-8');
    const data = JSON.parse(content);
    if (data.targets) {
      for (const [alias, config] of Object.entries(data.targets)) {
        targetsCache.set(alias, config as TargetConfig);
      }
    }
    return data.targets || {};
  } catch {
    return {};
  }
}

function getTarget(alias: string): TargetConfig | null {
  loadTargets();
  return targetsCache.get(alias) || null;
}

function loadState(projectDir: string): ProjectState {
  const stateFile = resolve(projectDir, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE);
  
  if (!existsSync(stateFile)) {
    return { activeTargetAlias: null, lastUsedAt: Date.now() };
  }
  
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return { activeTargetAlias: null, lastUsedAt: Date.now() };
  }
}

function saveState(projectDir: string, state: ProjectState): void {
  const stateDir = resolve(projectDir, DEFAULT_STATE_DIR);
  const stateFile = resolve(stateDir, DEFAULT_STATE_FILE);
  
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export default async function RexdTargetPlugin(ctx: { directory: string }) {
  const projectDir = ctx.directory;
  
  return {
    'command.execute.before': async (input: { command: string; arguments: string }, output: { parts: any[] }) => {
      if (!input.command.startsWith('target')) return;
      
      const parts = input.command.split(' ').filter(Boolean);
      const subcommand = parts[1];
      const targetArg = parts[2];
      
      switch (subcommand) {
        case 'list': {
          const targets = loadTargets();
          const list = Object.entries(targets).map(([alias, config]) => {
            const state = loadState(projectDir);
            const active = state.activeTargetAlias === alias;
            const desc = config.description || config.host || 'No description';
            return `  ${active ? '*' : ' '} ${alias}: ${desc}`;
          }).join('\n');
          
          output.parts = [{ type: 'text', content: list ? `Available targets:\n${list}\n\nUse /target use <alias> to select a target.` : 'No targets configured. Create ~/.config/rexd/targets.json' }];
          break;
        }
        
        case 'use': {
          if (!targetArg) {
            output.parts = [{ type: 'text', content: 'Usage: /target use <alias>' }];
            return;
          }
          
          const target = getTarget(targetArg);
          if (!target) {
            output.parts = [{ type: 'text', content: `Target "${targetArg}" not found. Use /target list to see available targets.` }];
            return;
          }
          
          const state = loadState(projectDir);
          state.activeTargetAlias = targetArg;
          state.lastUsedAt = Date.now();
          saveState(projectDir, state);
          
          const roots = target.workspaceRoots?.join(', ') || 'N/A';
          output.parts = [{ type: 'text', content: `Target "${targetArg}" activated.\n\nWorkspace roots: ${roots}\n\nAll file and shell operations will now be routed to the remote machine.` }];
          break;
        }
        
        case 'status': {
          const state = loadState(projectDir);
          const activeTarget = state.activeTargetAlias;
          
          if (!activeTarget) {
            output.parts = [{ type: 'text', content: 'No active target. Use /target use <alias> to select a target.' }];
            return;
          }
          
          const target = getTarget(activeTarget);
          output.parts = [{ type: 'text', content: `Active target: ${activeTarget}\n\nHost: ${target?.host}${target?.user ? `@${target.user}` : ''}` }];
          break;
        }
        
        case 'clear': {
          const state = loadState(projectDir);
          const activeTarget = state.activeTargetAlias;
          
          if (!activeTarget) {
            output.parts = [{ type: 'text', content: 'No active target to clear.' }];
            return;
          }
          
          state.activeTargetAlias = null;
          saveState(projectDir, state);
          
          output.parts = [{ type: 'text', content: `Target "${activeTarget}" deactivated. Operations will now use local execution.` }];
          break;
        }
        
        default: {
          output.parts = [{ type: 'text', content: `Unknown /target command: ${subcommand}\n\nAvailable commands:\n  /target list - Show available targets\n  /target use <alias> - Connect to a target\n  /target status - Show current target\n  /target clear - Disconnect from current target` }];
        }
      }
    },
    
    tool: {
      target: tool({
        description: 'Manage REXD remote targets. Usage: target <list|use|status|clear> [alias]',
        args: {
          action: tool.schema.string().describe('Action: list, use, status, or clear'),
          alias: tool.schema.string().optional().describe('Target alias (for use action)'),
        },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory);
          
          switch (args.action) {
            case 'list': {
              const targets = loadTargets();
              const list = Object.entries(targets).map(([alias, config]) => {
                const active = state.activeTargetAlias === alias;
                const desc = config.description || config.host || 'No description';
                return `  ${active ? '*' : ' '} ${alias}: ${desc}`;
              }).join('\n');
              
              return list ? `Available targets:\n${list}\n\nUse 'target use <alias>' to select a target.` : 'No targets configured.';
            }
            
            case 'use': {
              if (!args.alias) return 'Usage: target use <alias>';
              
              const target = getTarget(args.alias);
              if (!target) return `Target "${args.alias}" not found. Use 'target list' to see available targets.`;
              
              state.activeTargetAlias = args.alias;
              state.lastUsedAt = Date.now();
              saveState(context.directory, state);
              
              return `Target "${args.alias}" activated. All file and shell operations will now be routed to the remote machine.`;
            }
            
            case 'status': {
              if (!state.activeTargetAlias) return 'No active target.';
              const target = getTarget(state.activeTargetAlias);
              return `Active target: ${state.activeTargetAlias}\nHost: ${target?.host}${target?.user ? `@${target.user}` : ''}`;
            }
            
            case 'clear': {
              if (!state.activeTargetAlias) return 'No active target to clear.';
              const wasActive = state.activeTargetAlias;
              state.activeTargetAlias = null;
              saveState(context.directory, state);
              return `Target "${wasActive}" deactivated.`;
            }
            
            default:
              return 'Usage: target <list|use|status|clear> [alias]';
          }
        },
      }),
      
      bash: tool({
        description: 'Execute shell commands. When a REXD target is active, commands run on the remote machine.',
        args: {
          command: tool.schema.string().describe('The shell command to execute'),
        },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory);
          if (!state.activeTargetAlias) {
            return 'No REXD target active. Use /target use <alias> first.';
          }
          
          return `Remote bash would execute: ${args.command} (not implemented yet)`;
        },
      }),
      
      read: tool({
        description: 'Read file contents from the local or remote filesystem.',
        args: {
          filePath: tool.schema.string().describe('Path to the file to read'),
        },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory);
          if (!state.activeTargetAlias) {
            return 'No REXD target active. Use /target use <alias> first.';
          }
          
          return `Remote read: ${args.filePath} (not implemented yet)`;
        },
      }),
      
      write: tool({
        description: 'Write content to a file. Creates the file if it does not exist.',
        args: {
          filePath: tool.schema.string().describe('Path to the file to write'),
          content: tool.schema.string().describe('Content to write to the file'),
        },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory);
          if (!state.activeTargetAlias) {
            return 'No REXD target active. Use /target use <alias> first.';
          }
          
          return `Remote write: ${args.filePath} (not implemented yet)`;
        },
      }),
      
      list: tool({
        description: 'List files and directories in a given path.',
        args: {
          filePath: tool.schema.string().describe('Path to the directory to list'),
        },
        async execute(args, context: ToolContext) {
          const state = loadState(context.directory);
          if (!state.activeTargetAlias) {
            return 'No REXD target active. Use /target use <alias> first.';
          }
          
          return `Remote list: ${args.filePath || '.'} (not implemented yet)`;
        },
      }),
    },
  };
}
