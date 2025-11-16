#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  closeSync,
  openSync,
  Dirent,
  mkdirSync,
} from 'fs';
import * as os from 'os';
import * as path from 'path';

interface ToolDefinition {
  image: string;
  command?: string[];
  description?: string;
  workdir?: string;
  env?: Record<string, string>;
  shareHome?: boolean;
  homeReadOnly?: boolean;
  writablePaths?: string[];
}

interface ToolMap {
  [name: string]: ToolDefinition;
}

interface CliOptions {
  toolName?: string;
  toolArgs: string[];
  dryRun: boolean;
  imageOverride?: string;
  shareHome: boolean;
  helpRequested: boolean;
}

const BUILT_IN_TOOLS: ToolMap = {
  codex: {
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    command: ['codex'],
    description: 'Launches the Codex CLI inside a devcontainers base image',
    shareHome: false,
    writablePaths: ['~/.codex'],
  },
  claude: {
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    command: ['claude'],
    description: 'Runs Claude Code inside a container and mounts your workspace',
  },
};

const CONFIG_PATH = process.env.DEVCON_TOOLS_FILE
  || path.join(os.homedir(), '.config', 'devcon', 'tools.json');
const WORKSPACE_TARGET = '/workspace';
const HOME_READONLY_DEFAULT = parseBooleanEnv(process.env.DEVCON_HOME_READONLY);
const SHARE_HOME_DEFAULT = parseBooleanEnv(process.env.DEVCON_SHARE_HOME);

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function resolveUserPath(input: string, homeDir: string): string {
  if (!input) {
    throw new Error('Writable path entries must not be empty.');
  }
  if (input === '~') {
    return homeDir;
  }
  if (input.startsWith('~/')) {
    return path.join(homeDir, input.substring(2));
  }
  return path.resolve(input);
}

function ensurePathWithinHome(target: string, homeDir: string): void {
  const normalizedHome = path.resolve(homeDir);
  const normalizedTarget = path.resolve(target);
  if (
    normalizedTarget !== normalizedHome
    && !normalizedTarget.startsWith(`${normalizedHome}${path.sep}`)
  ) {
    throw new Error(`Writable path ${target} must live within the mounted home directory (${homeDir}).`);
  }
}

function detectPathType(target: string): SensitivePath['type'] {
  const stats = statSync(target);
  if (stats.isDirectory()) {
    return 'dir';
  }
  if (stats.isFile()) {
    return 'file';
  }
  throw new Error(`Writable path ${target} must be a file or directory.`);
}

function ensureWritablePath(target: string): SensitivePath['type'] {
  if (existsSync(target)) {
    return detectPathType(target);
  }

  mkdirSync(target, { recursive: true });
  return 'dir';
}

function loadCustomTools(): ToolMap {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const data = require(CONFIG_PATH) as ToolMap;
    return data;
  } catch (error) {
    console.warn(`Failed to load custom tools from ${CONFIG_PATH}:`, error);
    return {};
  }
}

function readTools(): ToolMap {
  return { ...BUILT_IN_TOOLS, ...loadCustomTools() };
}

function parseArgs(argv: string[]): CliOptions {
  const toolArgs: string[] = [];
  const positional: string[] = [];
  let dryRun = false;
  let imageOverride: string | undefined;
  let shareHome = SHARE_HOME_DEFAULT;
  let forward = false;
  let helpRequested = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (forward) {
      toolArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      forward = true;
      continue;
    }

    if (arg === '--help' || arg === '-h' || arg === '--list') {
      helpRequested = true;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--no-home') {
      shareHome = false;
      continue;
    }

    if (arg === '--home') {
      shareHome = true;
      continue;
    }

    if (arg.startsWith('--image=')) {
      imageOverride = arg.substring('--image='.length);
      continue;
    }

    if (arg === '--image') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--image flag requires an argument, e.g. --image alpine:latest');
      }
      imageOverride = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      toolArgs.push(arg);
      continue;
    }

    positional.push(arg);
  }

  const toolName = positional.shift();
  for (const extra of positional) {
    toolArgs.push(extra);
  }

  return { toolName, toolArgs, dryRun, imageOverride, shareHome, helpRequested };
}

interface SensitivePath {
  hostPath: string;
  containerPath: string;
  type: 'file' | 'dir';
}

function discoverSensitivePaths(cwd: string, targetBase: string): SensitivePath[] {
  const sensitive: SensitivePath[] = [];

  let rootEntries: Dirent[] = [];
  try {
    rootEntries = readdirSync(cwd, { withFileTypes: true });
  } catch (error) {
    console.warn('Unable to inspect workspace for sensitive files:', error);
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    if (entry.name.startsWith('.env')) {
      sensitive.push({
        hostPath: path.join(cwd, entry.name),
        containerPath: path.join(targetBase, entry.name),
        type: 'file',
      });
    }
  }

  const gitPaths = ['.git/config', '.git/credentials', '.git-credentials', '.git/HEAD', '.git/index'];
  for (const relPath of gitPaths) {
    const hostPath = path.join(cwd, relPath);
    if (existsSync(hostPath)) {
      const stats = statSync(hostPath);
      sensitive.push({
        hostPath,
        containerPath: path.join(targetBase, relPath),
        type: stats.isDirectory() ? 'dir' : 'file',
      });
    }
  }

  return sensitive;
}

function createPlaceholder(type: 'file' | 'dir', cleanup: string[]): string {
  const base = mkdtempSync(path.join(os.tmpdir(), 'devcon-hide-'));
  cleanup.push(base);

  if (type === 'dir') {
    return base;
  }

  const filePath = path.join(base, 'placeholder');
  closeSync(openSync(filePath, 'w'));
  return filePath;
}

function ensureDockerAvailable(): void {
  const result = spawnSync('docker', ['version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error('Docker is required but was not found. Please install Docker and ensure it is in your PATH.');
  }
}

function printHelp(tools: ToolMap): void {
  console.log('Usage: devcon <tool> [-- tool args]\n');
  console.log('Flags:');
  console.log('  --dry-run     Print the docker command without executing it');
  console.log('  --home        Share your host home directory with the container (disabled by default)');
  console.log('  --no-home     Do not share your host home directory with the container');
  console.log('  --image=IMG   Override the docker image for this run');
  console.log('  --help        Show this message');
  console.log('\nTools:');
  for (const [name, tool] of Object.entries(tools)) {
    console.log(`  ${name.padEnd(10)} ${tool.description ?? ''}`.trimEnd());
  }
}

function buildDockerArgs(options: {
  cwd: string;
  toolName: string;
  tool: ToolDefinition;
  toolArgs: string[];
  imageOverride?: string;
  shareHome: boolean;
}): { command: string; args: string[]; cleanup: () => void } {
  const dockerArgs: string[] = ['run', '--rm', '-it'];
  const cleanupTargets: string[] = [];
  const writablePaths = options.tool.writablePaths ?? [];
  const homeDir = os.homedir();
  const shareHome = options.shareHome;
  const homeReadOnly = shareHome ? (options.tool.homeReadOnly ?? HOME_READONLY_DEFAULT) : false;
  const shouldMountWritable = writablePaths.length > 0 && (!shareHome || homeReadOnly);
  let homeEnvSet = false;

  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    dockerArgs.push('-u', `${process.getuid()}:${process.getgid()}`);
  }

  const workspaceTarget = options.tool.workdir ?? WORKSPACE_TARGET;
  dockerArgs.push('--mount', `type=bind,source=${options.cwd},target=${workspaceTarget}`);
  dockerArgs.push('-w', workspaceTarget);
  dockerArgs.push('-e', `DEVCON_WORKSPACE=${workspaceTarget}`);
  dockerArgs.push('-e', `DEVCON_TOOL=${options.toolName}`);

  if (shareHome && homeDir && existsSync(homeDir)) {
    const normalizedHome = path.resolve(homeDir);
    const mountSpec = homeReadOnly
      ? `type=bind,source=${normalizedHome},target=${normalizedHome},readonly`
      : `type=bind,source=${normalizedHome},target=${normalizedHome}`;
    dockerArgs.push('--mount', mountSpec);
    dockerArgs.push('-e', `HOME=${normalizedHome}`);
    homeEnvSet = true;
  }

  if (!homeEnvSet && homeDir) {
    dockerArgs.push('-e', `HOME=${homeDir}`);
  }

  if (shouldMountWritable) {
    if (!homeDir) {
      throw new Error('Unable to determine home directory for writable path overrides.');
    }
    for (const rawPath of writablePaths) {
      const resolved = resolveUserPath(rawPath, homeDir);
      ensurePathWithinHome(resolved, homeDir);
      ensureWritablePath(resolved);
      dockerArgs.push('--mount', `type=bind,source=${resolved},target=${resolved}`);
    }
  } else if (shareHome && writablePaths.length > 0 && !homeReadOnly) {
    console.warn('Writable paths were provided but the home directory is not mounted read-only. Ignoring writablePaths.');
  }

  const sensitivePaths = discoverSensitivePaths(options.cwd, workspaceTarget);
  for (const sensitive of sensitivePaths) {
    const placeholder = createPlaceholder(sensitive.type, cleanupTargets);
    const spec = `type=bind,source=${placeholder},target=${sensitive.containerPath},readonly`;
    dockerArgs.push('--mount', spec);
  }

  const env = options.tool.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }

  const image = options.imageOverride ?? options.tool.image;
  dockerArgs.push(image);

  const toolCommand = options.tool.command ?? [];
  const commandArgs = [...toolCommand, ...options.toolArgs];
  dockerArgs.push(...commandArgs);

  const cleanup = (): void => {
    for (const target of cleanupTargets) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to clean temporary artifact', target, error);
      }
    }
  };

  return { command: 'docker', args: dockerArgs, cleanup };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  const tools = readTools();

  if (options.helpRequested) {
    printHelp(tools);
    return;
  }

  if (!options.toolName) {
    console.error('No tool specified.');
    printHelp(tools);
    process.exitCode = 1;
    return;
  }

  const tool = tools[options.toolName];
  if (!tool) {
    console.error(`Unknown tool "${options.toolName}".`);
    printHelp(tools);
    process.exitCode = 1;
    return;
  }

  ensureDockerAvailable();

  const { command, args, cleanup } = buildDockerArgs({
    cwd: process.cwd(),
    toolName: options.toolName,
    tool,
    toolArgs: options.toolArgs,
    imageOverride: options.imageOverride,
    shareHome: options.shareHome && tool.shareHome !== false,
  });

  if (options.dryRun) {
    console.log([command, ...args].join(' '));
    cleanup();
    return;
  }

  const child = spawn(command, args, { stdio: 'inherit' });
  const terminate = (): void => {
    child.kill('SIGINT');
  };

  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);

  child.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 1);
  });

  child.on('error', (error) => {
    cleanup();
    console.error('Failed to start docker:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
