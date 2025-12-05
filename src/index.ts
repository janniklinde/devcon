#!/usr/bin/env node
import { spawn, spawnSync, SpawnOptionsWithoutStdio } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  closeSync,
  openSync,
  writeFileSync,
  readFileSync,
  Dirent,
  mkdirSync,
} from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

interface ToolDefinition {
  image: string;
  command?: string[];
  description?: string;
  workdir?: string;
  env?: Record<string, string>;
  shareHome?: boolean;
  homeReadOnly?: boolean;
  writablePaths?: string[];
  autoBuild?: AutoBuildConfig;
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

interface AutoBuildConfig {
  dockerfile: string;
  tag: string;
  description?: string;
}

const CONFIG_PATH = process.env.DEVCON_TOOLS_FILE
  || path.join(os.homedir(), '.config', 'devcon', 'tools.json');
const SENSITIVE_CONFIG_PATH = path.join(os.homedir(), '.config', 'devcon', 'sensitive.json');
const SKIP_SCAN_CONFIG_PATH = path.join(os.homedir(), '.config', 'devcon', 'skip-scan.json');
const WORKSPACE_TARGET = '/workspace';
const HOME_READONLY_DEFAULT = parseBooleanEnv(process.env.DEVCON_HOME_READONLY);
const SHARE_HOME_DEFAULT = parseBooleanEnv(process.env.DEVCON_SHARE_HOME);
const DEFAULT_IMAGE_TAG = 'devcon:latest';
const DEFAULT_IMAGE_DOCKERFILE = path.resolve(__dirname, '..', 'docker', 'devcon', 'Dockerfile');
const DEFAULT_AUTO_BUILD: AutoBuildConfig = {
  dockerfile: DEFAULT_IMAGE_DOCKERFILE,
  tag: DEFAULT_IMAGE_TAG,
  description: 'Builds the devcon base image with Codex CLI and Claude Code preinstalled.',
};
const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '.git',
  '.git-credentials',
];
const DEFAULT_SKIP_SCAN_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'tmp',
  'temp',
  '.venv',
  'venv',
  'target',
  'out',
  '.yarn',
  '.pnpm-store',
  'coverage',
];

const BUILT_IN_TOOLS: ToolMap = {
  codex: {
    image: DEFAULT_IMAGE_TAG,
    command: ['codex'],
    description: 'Launches the Codex CLI inside a devcontainers base image',
    writablePaths: ['~/.codex'],
    autoBuild: DEFAULT_AUTO_BUILD,
  },
  claude: {
    image: DEFAULT_IMAGE_TAG,
    command: ['claude'],
    description: 'Runs Claude Code inside a container and mounts your workspace',
    autoBuild: DEFAULT_AUTO_BUILD,
  },
};

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
  const merged: ToolMap = { ...BUILT_IN_TOOLS };
  const custom = loadCustomTools();
  for (const [name, tool] of Object.entries(custom)) {
    const base = merged[name] ?? {};
    merged[name] = { ...base, ...tool };
  }

  return merged;
}

function loadSkipDirs(): string[] {
  if (!existsSync(SKIP_SCAN_CONFIG_PATH)) {
    return [];
  }

  try {
    const contents = readFileSync(SKIP_SCAN_CONFIG_PATH, 'utf8');
    const data = JSON.parse(contents) as SkipScanConfig;
    if (!data || !Array.isArray(data.skipDirs)) {
      console.warn(`Skip-scan config at ${SKIP_SCAN_CONFIG_PATH} is malformed; expected { "skipDirs": [] }.`);
      return [];
    }
    return data.skipDirs.filter((entry) => typeof entry === 'string') as string[];
  } catch (error) {
    console.warn(`Failed to load skip-scan config from ${SKIP_SCAN_CONFIG_PATH}:`, error);
    return [];
  }
}

function saveSkipDirs(skipDirs: string[]): void {
  const dir = path.dirname(SKIP_SCAN_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const unique = Array.from(new Set(skipDirs));
  const payload = JSON.stringify({ skipDirs: unique }, null, 2);
  console.log(`Writing skip-scan config to ${SKIP_SCAN_CONFIG_PATH}`);
  writeFileSync(SKIP_SCAN_CONFIG_PATH, `${payload}\n`, 'utf8');
}

function loadSensitivePatterns(): string[] {
  if (!existsSync(SENSITIVE_CONFIG_PATH)) {
    return [];
  }

  try {
    const contents = readFileSync(SENSITIVE_CONFIG_PATH, 'utf8');
    const data = JSON.parse(contents) as { patterns?: unknown };
    if (!data || !Array.isArray(data.patterns)) {
      console.warn(`Sensitive config at ${SENSITIVE_CONFIG_PATH} is malformed; expected { "patterns": [] }.`);
      return [];
    }
    return data.patterns.filter((entry) => typeof entry === 'string') as string[];
  } catch (error) {
    console.warn(`Failed to load sensitive config from ${SENSITIVE_CONFIG_PATH}:`, error);
    return [];
  }
}

function saveSensitivePatterns(patterns: string[]): void {
  const dir = path.dirname(SENSITIVE_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const unique = Array.from(new Set(patterns));
  const payload = JSON.stringify({ patterns: unique }, null, 2);
  // eslint-disable-next-line no-console
  console.log(`Writing sensitive config to ${SENSITIVE_CONFIG_PATH}`);
  writeFileSync(SENSITIVE_CONFIG_PATH, `${payload}\n`, 'utf8');
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

function toPosixPath(input: string): string {
  return input.split(path.sep).join('/');
}

function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

function escapeRegexExceptGlobs(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function compileSensitivePatterns(rawPatterns: string[]): SensitivePattern[] {
  const seen = new Set<string>();
  const compiled: SensitivePattern[] = [];

  for (const raw of rawPatterns) {
    if (!raw || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    const normalized = toPosixPath(raw.replace(/^\.\//, ''));
    const escaped = escapeRegexExceptGlobs(normalized);
    const withGlob = escaped
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    try {
      compiled.push({
        raw,
        regex: new RegExp(`^${withGlob}$`),
        hasGlob: isGlobPattern(raw),
      });
    } catch (error) {
      console.warn(`Skipping invalid sensitive pattern "${raw}":`, error);
    }
  }

  return compiled;
}

function getEffectiveSensitivePatterns(): string[] {
  return [...DEFAULT_SENSITIVE_PATTERNS, ...loadSensitivePatterns()];
}

function getEffectiveSkipDirs(): Set<string> {
  return new Set([...DEFAULT_SKIP_SCAN_DIRS, ...loadSkipDirs()]);
}

function addMatch(
  matches: Map<string, SensitiveMatch>,
  relPath: string,
  type: SensitiveMatch['type'],
): void {
  const normalized = toPosixPath(relPath);
  if (!matches.has(normalized)) {
    matches.set(normalized, { relPath: normalized, type });
  }
}

function findSensitiveMatches(cwd: string, patterns: SensitivePattern[], skipDirs: Set<string>): SensitiveMatch[] {
  const matches = new Map<string, SensitiveMatch>();
  const globPatterns = patterns.filter((p) => p.hasGlob);
  const directPatterns = patterns.filter((p) => !p.hasGlob);

  for (const pattern of directPatterns) {
    const absPath = path.resolve(cwd, pattern.raw);
    if (!existsSync(absPath)) {
      continue;
    }
    const rel = path.relative(cwd, absPath);
    const stats = statSync(absPath);
    addMatch(matches, rel, stats.isDirectory() ? 'dir' : 'file');
  }

  if (globPatterns.length === 0) {
    return [...matches.values()];
  }

  const stack: string[] = [cwd];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      console.warn('Unable to inspect workspace for sensitive files:', error);
      continue;
    }

    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      const rel = path.relative(cwd, absPath);
      const normalized = toPosixPath(rel);
      const isDir = entry.isDirectory();
      const matched = globPatterns.some((p) => p.regex.test(normalized));
      if (matched) {
        addMatch(matches, rel, isDir ? 'dir' : 'file');
      }
      if (isDir && !matched && !skipDirs.has(entry.name)) {
        stack.push(absPath);
      }
    }
  }

  return [...matches.values()];
}

interface SensitivePath {
  hostPath: string;
  containerPath: string;
  type: 'file' | 'dir';
}

interface SensitiveMatch {
  relPath: string;
  type: 'file' | 'dir';
}

interface SensitivePattern {
  raw: string;
  regex: RegExp;
  hasGlob: boolean;
}

interface SkipScanConfig {
  skipDirs: string[];
}

function getCurrentWorkingDirectory(): string {
  try {
    return process.cwd();
  } catch (error) {
    throw new Error('The current working directory is not accessible. Ensure it exists before running devcon.');
  }
}

function discoverSensitivePaths(cwd: string, targetBase: string): SensitivePath[] {
  const patterns = compileSensitivePatterns(getEffectiveSensitivePatterns());
  const matches = findSensitiveMatches(cwd, patterns, getEffectiveSkipDirs());
  return matches.map((match) => ({
    hostPath: path.join(cwd, match.relPath),
    containerPath: path.join(targetBase, match.relPath),
    type: match.type,
  }));
}

function printSensitiveList(cwd: string): void {
  const defaults = DEFAULT_SENSITIVE_PATTERNS;
  const custom = loadSensitivePatterns();
  const effective = compileSensitivePatterns([...defaults, ...custom]);
  const matches = findSensitiveMatches(cwd, effective, getEffectiveSkipDirs());

  console.log('Default sensitive patterns:');
  for (const pattern of defaults) {
    console.log(`  - ${pattern}`);
  }

  console.log(`\nCustom sensitive patterns (${SENSITIVE_CONFIG_PATH}):`);
  if (custom.length === 0) {
    console.log('  (none)');
  } else {
    for (const pattern of custom) {
      console.log(`  - ${pattern}`);
    }
  }

  console.log('\nMatches in this workspace:');
  if (matches.length === 0) {
    console.log('  (no matching files or directories found)');
  } else {
    for (const match of matches) {
      console.log(`  - ${match.relPath} (${match.type})`);
    }
  }
}

function handleSensitiveCommand(args: string[], cwd: string): void {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'list') {
    printSensitiveList(cwd);
    return;
  }

  if (subcommand === 'add') {
    const pattern = args[1];
    if (!pattern) {
      throw new Error('Please provide a pattern to add, e.g. "devcon sensitive add secrets/**".');
    }
    const current = loadSensitivePatterns();
    if (current.includes(pattern)) {
      console.log(`Pattern "${pattern}" is already in ${SENSITIVE_CONFIG_PATH}`);
      return;
    }
    saveSensitivePatterns([...current, pattern]);
    console.log(`Added sensitive pattern "${pattern}"`);
    return;
  }

  if (subcommand === 'remove') {
    const pattern = args[1];
    if (!pattern) {
      throw new Error('Please provide a pattern to remove, e.g. "devcon sensitive remove secrets/**".');
    }
    const current = loadSensitivePatterns();
    if (!current.includes(pattern)) {
      console.log(`Pattern "${pattern}" was not found in ${SENSITIVE_CONFIG_PATH}`);
      return;
    }
    saveSensitivePatterns(current.filter((entry) => entry !== pattern));
    console.log(`Removed sensitive pattern "${pattern}"`);
    return;
  }

  throw new Error(`Unknown "sensitive" subcommand "${subcommand}". Use list, add, or remove.`);
}

function handleSkipScanCommand(args: string[]): void {
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'list') {
    const defaults = DEFAULT_SKIP_SCAN_DIRS;
    const custom = loadSkipDirs();
    console.log('Default skip-scan directories:');
    for (const entry of defaults) {
      console.log(`  - ${entry}`);
    }
    console.log(`\nCustom skip-scan directories (${SKIP_SCAN_CONFIG_PATH}):`);
    if (custom.length === 0) {
      console.log('  (none)');
    } else {
      for (const entry of custom) {
        console.log(`  - ${entry}`);
      }
    }
    return;
  }

  if (subcommand === 'add') {
    const entry = args[1];
    if (!entry) {
      throw new Error('Please provide a directory name to add, e.g. "devcon skip-scan add .cache".');
    }
    const current = loadSkipDirs();
    if (current.includes(entry)) {
      console.log(`Skip directory "${entry}" is already in ${SKIP_SCAN_CONFIG_PATH}`);
      return;
    }
    saveSkipDirs([...current, entry]);
    console.log(`Added skip directory "${entry}"`);
    return;
  }

  if (subcommand === 'remove') {
    const entry = args[1];
    if (!entry) {
      throw new Error('Please provide a directory name to remove, e.g. "devcon skip-scan remove .cache".');
    }
    const current = loadSkipDirs();
    if (!current.includes(entry)) {
      console.log(`Skip directory "${entry}" was not found in ${SKIP_SCAN_CONFIG_PATH}`);
      return;
    }
    saveSkipDirs(current.filter((item) => item !== entry));
    console.log(`Removed skip directory "${entry}"`);
    return;
  }

  throw new Error(`Unknown "skip-scan" subcommand "${subcommand}". Use list, add, or remove.`);
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

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
      }
    });

    child.on('error', (error) => reject(error));
  });
}

async function runDockerBuild(
  spec: AutoBuildConfig,
  options: { refresh?: boolean; noCache?: boolean; pull?: boolean } = {},
): Promise<void> {
  const dockerfileDir = path.dirname(spec.dockerfile);
  const dockerfileName = path.basename(spec.dockerfile);
  const args = ['build', '-f', dockerfileName, '-t', spec.tag];

  if (options.refresh || options.pull) {
    args.push('--pull');
  }

  if (options.noCache) {
    args.push('--no-cache');
  }

  if (options.refresh) {
    args.push(
      '--build-arg',
      `DEVCON_UPDATE_TOKEN=${Date.now()}`,
    );
  }

  args.push('.');
  console.log(`Building Docker image "${spec.tag}" using ${spec.dockerfile} ...`);
  await runCommand('docker', args, { cwd: dockerfileDir });
}

async function handleUpdateCommand(
  targetToolNames: string[],
  tools: ToolMap,
  dryRun: boolean,
): Promise<void> {
  const requested = targetToolNames.length > 0 ? targetToolNames : Object.keys(tools);
  if (requested.length === 0) {
    console.warn('No tools are available to update.');
    return;
  }

  const specs = new Map<string, { spec: AutoBuildConfig; toolNames: string[] }>();
  for (const name of requested) {
    const tool = tools[name];
    if (!tool) {
      throw new Error(`Unknown tool "${name}" specified for update.`);
    }
    if (!tool.autoBuild) {
      console.warn(`Tool "${name}" does not have an auto-build configuration and will be skipped.`);
      continue;
    }
    const resolvedDockerfile = path.resolve(tool.autoBuild.dockerfile);
    const specKey = `${resolvedDockerfile}::${tool.autoBuild.tag}`;
    const entry = specs.get(specKey);
    if (entry) {
      entry.toolNames.push(name);
    } else {
      specs.set(specKey, {
        spec: { ...tool.autoBuild, dockerfile: resolvedDockerfile },
        toolNames: [name],
      });
    }
  }

  if (specs.size === 0) {
    console.warn('No auto-buildable tools were selected for update.');
    return;
  }

  for (const { spec, toolNames } of specs.values()) {
    const descriptor = `image "${spec.tag}" for tool(s): ${toolNames.join(', ')}`;
    if (dryRun) {
      console.log(`[dry-run] Would rebuild ${descriptor} using ${spec.dockerfile}`);
      continue;
    }
    console.log(`Rebuilding ${descriptor}`);
    await runDockerBuild(spec, { refresh: true });
  }
}

async function handleRebuildCommand(
  targetToolNames: string[],
  tools: ToolMap,
  dryRun: boolean,
): Promise<void> {
  const requested = targetToolNames.length > 0 ? targetToolNames : Object.keys(tools);
  if (requested.length === 0) {
    console.warn('No tools are available to rebuild.');
    return;
  }

  const specs = new Map<string, { spec: AutoBuildConfig; toolNames: string[] }>();
  for (const name of requested) {
    const tool = tools[name];
    if (!tool) {
      throw new Error(`Unknown tool "${name}" specified for rebuild.`);
    }
    if (!tool.autoBuild) {
      console.warn(`Tool "${name}" does not have an auto-build configuration and will be skipped.`);
      continue;
    }
    const resolvedDockerfile = path.resolve(tool.autoBuild.dockerfile);
    const specKey = `${resolvedDockerfile}::${tool.autoBuild.tag}`;
    const entry = specs.get(specKey);
    if (entry) {
      entry.toolNames.push(name);
    } else {
      specs.set(specKey, {
        spec: { ...tool.autoBuild, dockerfile: resolvedDockerfile },
        toolNames: [name],
      });
    }
  }

  if (specs.size === 0) {
    console.warn('No auto-buildable tools were selected for rebuild.');
    return;
  }

  for (const { spec, toolNames } of specs.values()) {
    const descriptor = `image "${spec.tag}" for tool(s): ${toolNames.join(', ')}`;
    if (dryRun) {
      console.log(`[dry-run] Would fully rebuild ${descriptor} (no cache) using ${spec.dockerfile}`);
      continue;
    }
    console.log(`Fully rebuilding ${descriptor} (cache disabled)`);
    await runDockerBuild(spec, { noCache: true, pull: true });
  }
}

async function ensureImageAvailable(image: string, autoBuild?: AutoBuildConfig): Promise<void> {
  const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  if (inspect.status === 0) {
    return;
  }

  if (!autoBuild) {
    throw new Error(`Docker image "${image}" was not found. Please build or pull it before continuing.`);
  }

  console.warn(`Docker image "${image}" is missing.`);
  if (autoBuild.description) {
    console.warn(autoBuild.description);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Cannot auto-build image "${image}" because the terminal is not interactive.`);
  }

  const confirmed = await promptYesNo('Build it now? [y/N] ');
  if (!confirmed) {
    throw new Error('Image build cancelled by user.');
  }

  await runDockerBuild(autoBuild);
}

function printHelp(tools: ToolMap): void {
  console.log('Usage:');
  console.log('  devcon <tool> [-- tool args]');
  console.log('  devcon update [tool ...]');
  console.log('  devcon rebuild [tool ...]');
  console.log('  devcon sensitive <list|add|remove> [pattern]');
  console.log('  devcon skip-scan <list|add|remove> [dir]\n');
  console.log('Flags:');
  console.log('  --dry-run     Print the docker command without executing it');
  console.log('  --home        Share your host home directory with the container (disabled by default)');
  console.log('  --no-home     Do not share your host home directory with the container');
  console.log('  --image=IMG   Override the docker image for this run');
  console.log('  --help        Show this message');
  console.log('\nCommands:');
  console.log('  update        Refresh Docker images for one or more tools (pull base, rerun npm install)');
  console.log('  rebuild       Fully rebuild Docker images for one or more tools (no cache)');
  console.log('  sensitive     List/add/remove sensitive-path patterns that get masked in containers');
  console.log('  skip-scan     List/add/remove directory names skipped during sensitive-pattern scanning');
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
  shareHome: boolean;
  image: string;
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

  const scanStart = Date.now();
  console.log('Scanning workspace for sensitive paths...');
  const sensitivePaths = discoverSensitivePaths(options.cwd, workspaceTarget);
  console.log(`Found ${sensitivePaths.length} sensitive path(s) to mask (in ${Date.now() - scanStart}ms)`);
  for (const sensitive of sensitivePaths) {
    const placeholder = createPlaceholder(sensitive.type, cleanupTargets);
    const spec = `type=bind,source=${placeholder},target=${sensitive.containerPath},readonly`;
    dockerArgs.push('--mount', spec);
  }

  const env = options.tool.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }

  dockerArgs.push(options.image);

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

  if (options.toolName === 'update') {
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon update". Specify the desired image in the tool configuration instead.');
    }
    await handleUpdateCommand(options.toolArgs, tools, options.dryRun);
    return;
  }

  if (options.toolName === 'rebuild') {
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon rebuild". Specify the desired image in the tool configuration instead.');
    }
    await handleRebuildCommand(options.toolArgs, tools, options.dryRun);
    return;
  }

  const cwd = getCurrentWorkingDirectory();

  if (options.toolName === 'sensitive') {
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon sensitive". This command only manages sensitive-file patterns.');
    }
    handleSensitiveCommand(options.toolArgs, cwd);
    return;
  }

  if (options.toolName === 'skip-scan') {
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon skip-scan". This command only manages directory scan skips.');
    }
    handleSkipScanCommand(options.toolArgs);
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

  console.log(`Preparing to launch tool "${options.toolName}" using image "${tool.image}"...`);

  const image = options.imageOverride ?? tool.image;
  await ensureImageAvailable(image, options.imageOverride ? undefined : tool.autoBuild);

  const { command, args, cleanup } = buildDockerArgs({
    cwd,
    toolName: options.toolName,
    tool,
    toolArgs: options.toolArgs,
    shareHome: options.shareHome && tool.shareHome !== false,
    image,
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
