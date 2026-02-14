#!/usr/bin/env node
import { spawn, spawnSync, SpawnOptionsWithoutStdio } from 'child_process';
import { createHash } from 'crypto';
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
import { createServer, IncomingMessage, ServerResponse, request } from 'http';
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
  allowGit: boolean;
  tempGit: boolean;
  exportPatchPath?: string;
  apiMode: boolean;
  apiPort: number;
  apiHost: string;
}

interface AutoBuildConfig {
  dockerfile: string;
  tag: string;
  description?: string;
}

interface ApiEvent {
  id: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface ApiStatus {
  state: 'starting' | 'busy' | 'ready' | 'exited' | 'error';
  tool: string;
  pid: number | null;
  containerId?: string;
  exitCode: number | null;
  signal: string | null;
  readyConfidence: number;
  spawnCommand?: string;
  lastErrorMessage?: string;
  recentOutputTail?: string;
}

const CONFIG_PATH = process.env.DEVCON_TOOLS_FILE
  || path.join(os.homedir(), '.config', 'devcon', 'tools.json');
const SENSITIVE_CONFIG_PATH = path.join(os.homedir(), '.config', 'devcon', 'sensitive.json');
const SKIP_SCAN_CONFIG_PATH = path.join(os.homedir(), '.config', 'devcon', 'skip-scan.json');
const WORKSPACE_TARGET = '/workspace';
const API_DEFAULT_PORT = parseIntegerEnv(process.env.DEVCON_API_PORT, 3784);
const API_DEFAULT_HOST = process.env.DEVCON_API_HOST || '127.0.0.1';
const API_TTY_COLUMNS = 120;
const API_TTY_ROWS = 40;
const READY_QUIET_WINDOW_MS = 1200;
const READY_MIN_INPUT_QUIET_MS = 400;
const READY_POLL_INTERVAL_MS = 200;
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
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

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
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
  let allowGit = false;
  let tempGit = false;
  let exportPatchPath: string | undefined;
  let apiMode = false;
  let apiPort = API_DEFAULT_PORT;
  let apiHost = API_DEFAULT_HOST;
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

    if (arg === '--api' || arg === '-api') {
      apiMode = true;
      continue;
    }

    if (arg.startsWith('--api-port=')) {
      const parsed = Number.parseInt(arg.substring('--api-port='.length), 10);
      if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error('--api-port must be a valid TCP port between 1 and 65535.');
      }
      apiPort = parsed;
      continue;
    }

    if (arg === '--api-port') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--api-port requires a value, e.g. --api-port 3784');
      }
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error('--api-port must be a valid TCP port between 1 and 65535.');
      }
      apiPort = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--api-host=')) {
      const value = arg.substring('--api-host='.length).trim();
      if (!value) {
        throw new Error('--api-host requires a non-empty hostname or IP.');
      }
      apiHost = value;
      continue;
    }

    if (arg === '--api-host') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--api-host requires a value, e.g. --api-host 127.0.0.1');
      }
      apiHost = next.trim();
      if (!apiHost) {
        throw new Error('--api-host requires a non-empty hostname or IP.');
      }
      i += 1;
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

    if (arg === '--with-git') {
      allowGit = true;
      continue;
    }

    if (arg === '--temp-git') {
      tempGit = true;
      continue;
    }

    if (arg === '--export-patch') {
      exportPatchPath = '';
      continue;
    }

    if (arg.startsWith('--export-patch=')) {
      exportPatchPath = arg.substring('--export-patch='.length);
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

  return {
    toolName,
    toolArgs,
    dryRun,
    imageOverride,
    shareHome,
    helpRequested,
    allowGit,
    tempGit,
    exportPatchPath,
    apiMode,
    apiPort,
    apiHost,
  };
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join('/');
}

function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:@]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
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

function discoverSensitivePaths(cwd: string, targetBase: string, options: { allowGit: boolean }): SensitivePath[] {
  const patterns = compileSensitivePatterns(getEffectiveSensitivePatterns())
    .filter((pattern) => (options.allowGit ? pattern.raw !== '.git' : true));
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

function prepareTempGitRepo(workspaceTarget: string): { hostDir: string; containerDir: string } {
  ensureHostGitAvailable();
  const hostDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-temp-git-'));
  const init = spawnSync('git', ['init', '--bare', hostDir], { stdio: 'ignore' });
  if (init.status !== 0) {
    throw new Error('Failed to initialize temporary git repository.');
  }
  spawnSync('git', ['--git-dir', hostDir, 'config', 'user.name', 'devcon-bot'], { stdio: 'ignore' });
  spawnSync('git', ['--git-dir', hostDir, 'config', 'user.email', 'devcon@example.com'], { stdio: 'ignore' });
  spawnSync('git', ['--git-dir', hostDir, 'config', 'init.defaultBranch', 'main'], { stdio: 'ignore' });
  return { hostDir, containerDir: '/tmp/devcon/gitdir' };
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

function ensureHostGitAvailable(): void {
  const result = spawnSync('git', ['version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error('Git is required for --temp-git but was not found on the host. Please install Git.');
  }
}

function exportTempGitPatch(gitDir: string, workTree: string, desiredPath?: string): void {
  ensureHostGitAvailable();
  const patchDir = desiredPath && !desiredPath.endsWith('.patch')
    ? desiredPath
    : desiredPath
      ? path.dirname(desiredPath)
      : workTree;
  if (!existsSync(patchDir)) {
    mkdirSync(patchDir, { recursive: true });
  }
  const patchPath = desiredPath && desiredPath.endsWith('.patch')
    ? desiredPath
    : path.join(patchDir, `${Date.now()}.patch`);

  const gitArgs = ['--git-dir', gitDir, '--work-tree', workTree];

  // Ensure a HEAD exists; if not, try to create the baseline commit.
  const headCheck = spawnSync('git', [...gitArgs, 'rev-parse', 'HEAD'], { stdio: 'ignore' });
  if (headCheck.status !== 0) {
    const addBaseline = spawnSync('git', [...gitArgs, 'add', '-A'], { stdio: 'ignore' });
    if (addBaseline.status !== 0) {
      console.warn('Failed to stage baseline for temp git repo; skipping patch export.');
      return;
    }
    const commitBaseline = spawnSync('git', [...gitArgs, 'commit', '-m', 'devcon baseline'], { stdio: 'ignore' });
    if (commitBaseline.status !== 0) {
      console.warn('Failed to create baseline commit for temp git repo; skipping patch export.');
      return;
    }
  }

  // Snapshot any remaining worktree changes into a temp commit for export.
  const status = spawnSync('git', [...gitArgs, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.status === 0 && status.stdout.trim().length > 0) {
    spawnSync('git', [...gitArgs, 'add', '-A'], { stdio: 'ignore' });
    const snap = spawnSync('git', [...gitArgs, 'commit', '-m', 'devcon export snapshot'], { stdio: 'ignore' });
    if (snap.status !== 0) {
      console.warn('Failed to snapshot working tree before export; skipping patch export.');
      return;
    }
  }

  const revList = spawnSync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' });
  if (revList.status !== 0 || !revList.stdout.trim()) {
    console.warn('No commits found in temp git repo; skipping patch export.');
    return;
  }
  const rootCommit = revList.stdout.trim().split('\n')[0];
  const head = spawnSync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0 || !head.stdout.trim()) {
    console.warn('Unable to resolve HEAD for temp git repo; skipping patch export.');
    return;
  }
  const headCommit = head.stdout.trim();
  if (headCommit === rootCommit) {
    console.log('Only baseline commit exists; no changes to export.');
    return;
  }

  const format = spawnSync('git', ['--git-dir', gitDir, '--work-tree', workTree, 'format-patch', `${rootCommit}..HEAD`, '--stdout'], { encoding: 'utf8' });
  if (format.status !== 0) {
    console.warn('Failed to generate patch from temp git repo.');
    return;
  }
  writeFileSync(patchPath, format.stdout, 'utf8');
  console.log(`Exported temp-git patch to ${patchPath}`);
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

function stripAnsiSequences(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

class ConsoleSnapshotTracker {
  private history: string[] = [];

  private currentLine = '';

  feed(rawChunk: string): string {
    const chunk = stripAnsiSequences(rawChunk);
    for (const char of chunk) {
      if (char === '\r') {
        this.currentLine = '';
        continue;
      }
      if (char === '\n') {
        this.history.push(this.currentLine);
        if (this.history.length > 120) {
          this.history.shift();
        }
        this.currentLine = '';
        continue;
      }
      if (char === '\b' || char === '\x7f') {
        this.currentLine = this.currentLine.slice(0, -1);
        continue;
      }
      if (char < ' ' && char !== '\t') {
        continue;
      }
      this.currentLine += char;
      if (this.currentLine.length > 500) {
        this.currentLine = this.currentLine.slice(-500);
      }
    }

    return this.getHash();
  }

  getHash(): string {
    const snapshot = [...this.history.slice(-80), this.currentLine].join('\n');
    return createHash('sha1').update(snapshot).digest('hex');
  }
}

interface ReadyTransition {
  state: 'busy' | 'ready';
  reason: string;
  confidence: number;
  quietMs: number;
  visualStableMs: number;
  inputQuietMs: number;
}

class OutputStabilityDetector {
  private readonly tracker = new ConsoleSnapshotTracker();

  private readonly onTransition: (transition: ReadyTransition) => void;

  private lastHash = this.tracker.getHash();

  private lastOutputAt = Date.now();

  private lastVisualChangeAt = Date.now();

  private lastInputAt = Date.now();

  private state: 'busy' | 'ready' = 'busy';

  private timer: NodeJS.Timeout | null = null;

  constructor(onTransition: (transition: ReadyTransition) => void) {
    this.onTransition = onTransition;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.tick(), READY_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  noteInput(): void {
    this.lastInputAt = Date.now();
    this.toBusy('input');
  }

  feedOutput(rawChunk: string): void {
    const now = Date.now();
    this.lastOutputAt = now;
    const nextHash = this.tracker.feed(rawChunk);
    if (nextHash !== this.lastHash) {
      this.lastHash = nextHash;
      this.lastVisualChangeAt = now;
    }
    this.toBusy('output');
  }

  private toBusy(reason: string): void {
    if (this.state === 'busy') {
      return;
    }
    this.state = 'busy';
    const now = Date.now();
    this.onTransition({
      state: 'busy',
      reason,
      confidence: 0.1,
      quietMs: now - this.lastOutputAt,
      visualStableMs: now - this.lastVisualChangeAt,
      inputQuietMs: now - this.lastInputAt,
    });
  }

  private tick(): void {
    if (this.state === 'ready') {
      return;
    }
    const now = Date.now();
    const quietMs = now - this.lastOutputAt;
    const visualStableMs = now - this.lastVisualChangeAt;
    const inputQuietMs = now - this.lastInputAt;

    if (
      quietMs < READY_QUIET_WINDOW_MS
      || visualStableMs < READY_QUIET_WINDOW_MS
      || inputQuietMs < READY_MIN_INPUT_QUIET_MS
    ) {
      return;
    }

    this.state = 'ready';
    this.onTransition({
      state: 'ready',
      reason: 'screen-stable',
      confidence: this.calculateConfidence(quietMs, visualStableMs, inputQuietMs),
      quietMs,
      visualStableMs,
      inputQuietMs,
    });
  }

  private calculateConfidence(quietMs: number, visualStableMs: number, inputQuietMs: number): number {
    let score = 0.65;
    if (quietMs >= READY_QUIET_WINDOW_MS * 2) {
      score += 0.15;
    }
    if (visualStableMs >= READY_QUIET_WINDOW_MS * 2) {
      score += 0.1;
    }
    if (inputQuietMs >= READY_MIN_INPUT_QUIET_MS * 3) {
      score += 0.05;
    }
    if (quietMs >= READY_QUIET_WINDOW_MS * 3) {
      score += 0.05;
    }
    return Math.min(0.99, Number(score.toFixed(2)));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) {
      throw new Error('Request body too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function formatSse(event: ApiEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function buildDetachedDockerRunArgs(args: string[]): string[] | null {
  if (args.length === 0 || args[0] !== 'run') {
    return null;
  }

  const detachedArgs: string[] = ['run', '-d', '-i', '-t'];
  for (const token of args.slice(1)) {
    if (
      token === '--rm'
      || token === '--detach'
      || token === '--interactive'
      || token === '--tty'
    ) {
      continue;
    }

    if (/^-[A-Za-z]+$/.test(token)) {
      const filtered = token
        .slice(1)
        .split('')
        .filter((ch) => ch !== 'd' && ch !== 'i' && ch !== 't');
      if (filtered.length === 0) {
        continue;
      }
      detachedArgs.push(`-${filtered.join('')}`);
      continue;
    }

    detachedArgs.push(token);
  }

  return detachedArgs;
}

function removeContainerIfExists(containerId: string): void {
  spawnSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
}

function resizeContainerTty(containerId: string, cols: number, rows: number): void {
  const resize = spawnSync(
    'docker',
    ['container', 'resize', '--height', String(rows), '--width', String(cols), containerId],
    { stdio: 'ignore' },
  );
  if (resize.status !== 0) {
    // Non-fatal: some Docker backends may reject resize in detached/bridge setups.
    console.warn(`Warning: failed to set container TTY size to ${cols}x${rows}.`);
  }
}

function resolveDockerSocketPath(): string {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost && dockerHost.startsWith('unix://')) {
    return dockerHost.slice('unix://'.length);
  }
  return '/var/run/docker.sock';
}

interface DockerAttachStream {
  write: (data: string | Buffer) => boolean;
  close: () => void;
  onData: (handler: (chunk: Buffer) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  onClose: (handler: () => void) => void;
}

interface PromptExecCapabilities {
  config: boolean;
  sandbox: boolean;
  approval: boolean;
  reasoningEffort: boolean;
  model: boolean;
}

async function openDockerAttachStream(containerId: string): Promise<DockerAttachStream> {
  const socketPath = resolveDockerSocketPath();
  const pathWithQuery = `/v1.41/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=1`;

  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      method: 'POST',
      path: pathWithQuery,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
    });

    req.once('upgrade', (_res, socket, head) => {
      if (head && head.length > 0) {
        socket.unshift(head);
      }
      resolve({
        write: (data: string | Buffer) => socket.write(data),
        close: () => socket.end(),
        onData: (handler: (chunk: Buffer) => void) => socket.on('data', handler),
        onError: (handler: (error: Error) => void) => socket.on('error', handler),
        onClose: (handler: () => void) => socket.on('close', handler),
      });
    });

    req.once('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        reject(new Error(`Docker attach failed (${res.statusCode ?? 'unknown'}): ${payload || 'no body'}`));
      });
    });

    req.once('error', (error) => reject(error));
    req.end();
  });
}

function detectPromptExecCapabilities(
  containerId: string,
  promptExecCommand: string[],
): PromptExecCapabilities {
  const defaults: PromptExecCapabilities = {
    config: true,
    sandbox: true,
    approval: false,
    reasoningEffort: false,
    model: false,
  };
  if (promptExecCommand.length === 0) {
    return defaults;
  }

  const probe = spawnSync(
    'docker',
    ['exec', '-i', containerId, ...promptExecCommand, '--help'],
    { encoding: 'utf8' },
  );
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  return {
    config: output.includes('--config'),
    sandbox: output.includes('--sandbox'),
    approval: output.includes('--approval'),
    reasoningEffort: output.includes('--reasoning-effort'),
    model: output.includes('--model'),
  };
}

async function runApiModeSession(options: {
  toolName: string;
  command: string;
  args: string[];
  cwd: string;
  apiHost: string;
  apiPort: number;
  promptExecCommand?: string[];
  tempGit: boolean;
  tempGitDir?: string;
  exportPatchPath?: string;
  cleanup: () => void;
}): Promise<void> {
  const commandDescription = [options.command, ...options.args].map(shellQuote).join(' ');
  const detachedDockerArgs = options.command === 'docker'
    ? buildDetachedDockerRunArgs(options.args)
    : null;
  if (!detachedDockerArgs) {
    options.cleanup();
    throw new Error('API mode currently supports docker-backed tool sessions only.');
  }

  const launch = spawnSync('docker', detachedDockerArgs, { encoding: 'utf8' });
  if (launch.status !== 0) {
    const details = `${launch.stdout || ''}${launch.stderr || ''}`.trim();
    options.cleanup();
    throw new Error(`Failed to start detached docker session. ${details}`);
  }

  const containerId = (launch.stdout || '').trim().split('\n')[0]?.trim();
  if (!containerId) {
    options.cleanup();
    throw new Error('Failed to start detached docker session: no container id returned.');
  }
  resizeContainerTty(containerId, API_TTY_COLUMNS, API_TTY_ROWS);

  const promptExecMode = Array.isArray(options.promptExecCommand) && options.promptExecCommand.length > 0;
  const promptExecCapabilities = promptExecMode
    ? detectPromptExecCapabilities(containerId, options.promptExecCommand as string[])
    : undefined;
  let attachStream: DockerAttachStream | undefined;
  if (!promptExecMode) {
    try {
      attachStream = await openDockerAttachStream(containerId);
    } catch (error) {
      options.cleanup();
      removeContainerIfExists(containerId);
      throw new Error(`Failed to attach to container stdin/stdout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const waitChild = spawn('docker', ['wait', containerId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let waitStdout = '';
  let running = true;
  let attachClosed = false;
  let promptInFlight = false;

  const sendSignal = (signal: NodeJS.Signals): boolean => {
    const kill = spawnSync('docker', ['kill', '--signal', signal, containerId], { stdio: 'ignore' });
    return kill.status === 0;
  };

  const status: ApiStatus = {
    state: 'starting',
    tool: options.toolName,
    pid: waitChild.pid ?? null,
    containerId,
    exitCode: null,
    signal: null,
    readyConfidence: 0,
    spawnCommand: commandDescription,
    lastErrorMessage: undefined,
    recentOutputTail: '',
  };

  let recentOutputTail = '';
  const appendRecentOutput = (chunk: string): void => {
    const next = `${recentOutputTail}${chunk}`;
    recentOutputTail = next.length > 6000 ? next.slice(next.length - 6000) : next;
    status.recentOutputTail = recentOutputTail;
  };

  let sequence = 0;
  let cleanedUp = false;
  let shuttingDown = false;
  const clients = new Set<ServerResponse>();
  const history: ApiEvent[] = [];

  const publish = (
    type: string,
    payload: Record<string, unknown>,
    retain: boolean = true,
  ): void => {
    const event: ApiEvent = {
      id: sequence += 1,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    if (retain) {
      history.push(event);
      if (history.length > 100) {
        history.shift();
      }
    }
    const message = formatSse(event);
    for (const client of clients) {
      client.write(message);
    }
  };

  const detector = new OutputStabilityDetector((transition) => {
    if (promptExecMode) {
      return;
    }
    status.state = transition.state;
    status.readyConfidence = transition.confidence;
    publish(transition.state, {
      ...transition,
      status: { ...status },
    });
  });
  if (!promptExecMode) {
    detector.start();
  }

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    running = false;
    if (attachStream && !attachClosed) {
      attachStream.close();
    }
    if (waitChild.exitCode === null) {
      waitChild.kill('SIGTERM');
    }
    removeContainerIfExists(containerId);
    options.cleanup();
  };

  const finalizeTempPatch = (): void => {
    if (options.tempGit && options.tempGitDir && options.exportPatchPath !== undefined) {
      try {
        exportTempGitPatch(options.tempGitDir, options.cwd, options.exportPatchPath || undefined);
      } catch (error) {
        publish('warning', {
          message: `Failed to export patch from temp git repo: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
  };

  status.state = promptExecMode ? 'ready' : 'busy';
  status.readyConfidence = promptExecMode ? 1 : 0;
  publish('starting', {
    status: { ...status },
    pid: waitChild.pid ?? null,
    containerId,
    command: commandDescription,
    promptExecCapabilities: promptExecCapabilities ?? null,
  });
  if (!promptExecMode) {
    publish('busy', {
      reason: 'startup',
      confidence: 0,
      status: { ...status },
    });
  } else {
    publish('ready', {
      reason: 'prompt-exec-mode',
      confidence: 1,
      status: { ...status },
    });
  }

  if (!waitChild.stdout || !waitChild.stderr || (!promptExecMode && !attachStream)) {
    cleanup();
    throw new Error('Failed to initialize API wait streams.');
  }

  if (attachStream) {
    attachStream.onData((chunk: Buffer) => {
      const text = chunk.toString('utf8');
      appendRecentOutput(text);
      detector.feedOutput(text);
      publish('output', { stream: 'attach', text }, false);
    });

    attachStream.onError((error: Error) => {
      if (!running || status.state === 'exited') {
        return;
      }
      status.lastErrorMessage = error.message;
      publish('warning', {
        message: `Attach stream error: ${error.message}`,
      });
    });

    attachStream.onClose(() => {
      attachClosed = true;
      if (!running || status.state === 'exited') {
        return;
      }
      publish('warning', {
        message: 'Attach stream closed while container is still running.',
      });
    });
  }

  waitChild.stdout.on('data', (chunk: Buffer) => {
    waitStdout += chunk.toString('utf8');
  });

  waitChild.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    appendRecentOutput(text);
    publish('output', { stream: 'wait-stderr', text }, false);
  });

  waitChild.on('exit', () => {
    if (!running || status.state === 'exited' || status.state === 'error') {
      return;
    }
    running = false;
    if (!promptExecMode) {
      detector.stop();
    }
    status.state = 'exited';
    const parsedCode = Number.parseInt(waitStdout.trim().split('\n')[0] || '', 10);
    status.exitCode = Number.isNaN(parsedCode) ? null : parsedCode;
    status.signal = null;
    status.pid = null;
    status.readyConfidence = 1;
    publish('exit', {
      status: { ...status },
      code: status.exitCode,
      signal: null,
      recentOutputTail,
    });
    finalizeTempPatch();
    cleanup();
  });

  waitChild.on('error', (error) => {
    if (status.state === 'exited') {
      return;
    }
    if (!promptExecMode) {
      detector.stop();
    }
    status.state = 'error';
    status.readyConfidence = 0;
    status.lastErrorMessage = error instanceof Error ? error.message : String(error);
    publish('error', {
      status: { ...status },
      message: status.lastErrorMessage,
    });
    cleanup();
  });

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const method = req.method || 'GET';
      const parsed = new URL(req.url || '/', 'http://localhost');

      if (method === 'GET' && parsed.pathname === '/status') {
        sendJson(res, 200, {
          status,
          apiHost: options.apiHost,
          apiPort: options.apiPort,
          recentOutputTail,
        });
        return;
      }

      if (method === 'GET' && parsed.pathname === '/events') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write('\n');
        for (const event of history) {
          res.write(formatSse(event));
        }
        clients.add(res);
        req.on('close', () => {
          clients.delete(res);
        });
        return;
      }

      if (method === 'POST' && parsed.pathname === '/input') {
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const appendNewline = body.appendNewline === true;
        const sandbox = typeof body.sandbox === 'string' ? body.sandbox.trim() : '';
        const approval = typeof body.approval === 'string' ? body.approval.trim() : '';
        const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!text) {
          sendJson(res, 400, { error: 'Body must include a non-empty string field: text' });
          return;
        }
        if (!running || status.state === 'exited' || status.state === 'error') {
          sendJson(res, 409, {
            error: 'Session is not accepting input.',
            status,
            recentOutputTail,
          });
          return;
        }
        const payload = appendNewline ? `${text}\n` : text;
        if (promptExecMode) {
          if (promptInFlight) {
            sendJson(res, 409, { error: 'Another prompt is still running.' });
            return;
          }
          promptInFlight = true;
          status.state = 'busy';
          status.readyConfidence = 0.1;
          publish('busy', {
            reason: 'prompt-exec-start',
            confidence: 0.1,
            status: { ...status },
          });
          const effectiveSandbox = sandbox || 'danger-full-access';
          const ignoredOptions: string[] = [];
          const execPromptArgs = [...options.promptExecCommand as string[]];
          const configOverrides: string[] = [];
          if (promptExecCapabilities?.sandbox) {
            execPromptArgs.push('--sandbox', effectiveSandbox);
          } else {
            ignoredOptions.push('sandbox');
          }
          if (approval) {
            if (promptExecCapabilities?.approval) {
              execPromptArgs.push('--approval', approval);
            } else if (promptExecCapabilities?.config) {
              configOverrides.push(`approval_policy="${approval}"`);
            } else {
              ignoredOptions.push('approval');
            }
          }
          if (reasoningEffort) {
            if (promptExecCapabilities?.reasoningEffort) {
              execPromptArgs.push('--reasoning-effort', reasoningEffort);
            } else if (promptExecCapabilities?.config) {
              configOverrides.push(`model_reasoning_effort="${reasoningEffort}"`);
            } else {
              ignoredOptions.push('reasoningEffort');
            }
          }
          if (model) {
            if (promptExecCapabilities?.model) {
              execPromptArgs.push('--model', model);
            } else {
              ignoredOptions.push('model');
            }
          }
          for (const override of configOverrides) {
            execPromptArgs.push('--config', override);
          }
          if (ignoredOptions.length > 0) {
            publish('warning', {
              message: `Ignored unsupported codex exec options: ${ignoredOptions.join(', ')}`,
              ignoredOptions,
              capabilities: promptExecCapabilities,
            });
          }
          const execArgs = ['exec', '-i', containerId, ...execPromptArgs, text];
          const execChild = spawn('docker', execArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          execChild.stdout?.on('data', (chunk: Buffer) => {
            const out = chunk.toString('utf8');
            appendRecentOutput(out);
            publish('output', { stream: 'prompt-stdout', text: out }, false);
          });
          execChild.stderr?.on('data', (chunk: Buffer) => {
            const out = chunk.toString('utf8');
            appendRecentOutput(out);
            publish('output', { stream: 'prompt-stderr', text: out }, false);
          });
          execChild.on('exit', (code) => {
            promptInFlight = false;
            if (!running || status.state === 'exited' || status.state === 'error') {
              return;
            }
            publish('prompt-exit', {
              code: code ?? null,
              status: { ...status },
            });
            status.state = 'ready';
            status.readyConfidence = code === 0 ? 0.95 : 0.6;
            publish('ready', {
              reason: 'prompt-exec-complete',
              confidence: status.readyConfidence,
              status: { ...status },
            });
          });
          execChild.on('error', (error) => {
            promptInFlight = false;
            if (!running || status.state === 'exited') {
              return;
            }
            status.state = 'error';
            status.readyConfidence = 0;
            status.lastErrorMessage = error instanceof Error ? error.message : String(error);
            publish('error', {
              status: { ...status },
              message: status.lastErrorMessage,
            });
          });
          publish('input', {
            bytes: Buffer.byteLength(payload),
            mode: 'prompt-exec',
            sandbox: effectiveSandbox,
            approval: approval || null,
            reasoningEffort: reasoningEffort || null,
            model: model || null,
            configOverrides,
            ignoredOptions,
            capabilities: promptExecCapabilities,
          }, false);
          sendJson(res, 202, {
            accepted: true,
            bytes: Buffer.byteLength(payload),
            mode: 'prompt-exec',
            sandbox: effectiveSandbox,
            approval: approval || null,
            reasoningEffort: reasoningEffort || null,
            model: model || null,
            configOverrides,
            ignoredOptions,
            capabilities: promptExecCapabilities,
          });
          return;
        }

        const wrote = attachStream?.write(payload) ?? false;
        if (!wrote) {
          sendJson(res, 409, {
            error: 'Failed to write input to attached session stream.',
            status,
            recentOutputTail,
          });
          return;
        }
        detector.noteInput();
        publish('input', {
          bytes: Buffer.byteLength(payload),
          mode: 'attach',
        }, false);
        sendJson(res, 202, {
          accepted: true,
          bytes: Buffer.byteLength(payload),
          mode: 'attach',
        });
        return;
      }

      if (method === 'POST' && parsed.pathname === '/signal') {
        const body = await readJsonBody(req);
        const signal = (typeof body.signal === 'string' ? body.signal : 'SIGINT') as NodeJS.Signals;
        if (!running || status.state === 'exited') {
          sendJson(res, 409, { error: 'Session has already exited.' });
          return;
        }
        const ok = sendSignal(signal);
        if (!ok) {
          sendJson(res, 500, { error: `Failed to deliver signal ${signal}.` });
          return;
        }
        publish('signal', { signal });
        sendJson(res, 202, { accepted: true, signal });
        return;
      }

      if (method === 'POST' && parsed.pathname === '/shutdown') {
        sendJson(res, 202, { accepted: true });
        if (status.state !== 'exited') {
          sendSignal('SIGTERM');
        }
        shuttingDown = true;
        for (const client of clients) {
          client.end();
        }
        clients.clear();
        server.close();
        return;
      }

      sendJson(res, 404, { error: `Unknown endpoint ${method} ${parsed.pathname}` });
    };

    handle().catch((error) => {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      client.write(': keepalive\n\n');
    }
  }, 15000);

  const shutdownFromSignal = (): void => {
    if (status.state !== 'exited') {
      sendSignal('SIGINT');
    }
    shuttingDown = true;
    for (const client of clients) {
      client.end();
    }
    clients.clear();
    server.close();
  };

  process.on('SIGINT', shutdownFromSignal);
  process.on('SIGTERM', shutdownFromSignal);

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      clearInterval(heartbeat);
      process.off('SIGINT', shutdownFromSignal);
      process.off('SIGTERM', shutdownFromSignal);
      reject(error);
    });

    server.listen(options.apiPort, options.apiHost, () => {
      publish('api-ready', {
        status: { ...status },
        apiHost: options.apiHost,
        apiPort: options.apiPort,
      });
      console.log(`API mode enabled at http://${options.apiHost}:${options.apiPort}`);
      console.log('Endpoints: GET /status, GET /events, POST /input, POST /signal, POST /shutdown');
    });

    server.once('close', () => {
      clearInterval(heartbeat);
      process.off('SIGINT', shutdownFromSignal);
      process.off('SIGTERM', shutdownFromSignal);
      if (!shuttingDown && status.state !== 'exited') {
        sendSignal('SIGTERM');
      }
      resolve();
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

async function ensureImageAvailable(
  image: string,
  autoBuild?: AutoBuildConfig,
  options: { allowNonInteractiveBuild?: boolean } = {},
): Promise<void> {
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
    if (options.allowNonInteractiveBuild) {
      console.warn(`Auto-building missing image "${image}" in non-interactive mode.`);
      await runDockerBuild(autoBuild);
      return;
    }
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
  console.log('  devcon [-api] <tool> [-- tool args]');
  console.log('  devcon update [tool ...]');
  console.log('  devcon rebuild [tool ...]');
  console.log('  devcon sensitive <list|add|remove> [pattern]');
  console.log('  devcon skip-scan <list|add|remove> [dir]\n');
  console.log('Flags:');
  console.log('  --dry-run     Print the docker command without executing it');
  console.log('  --home        Share your host home directory with the container (disabled by default)');
  console.log('  --no-home     Do not share your host home directory with the container');
  console.log('  --image=IMG   Override the docker image for this run');
  console.log('  --with-git    Unmask .git and inject a sandboxed git user inside the container');
  console.log('  --temp-git    Mask host .git but provide a temporary git repo/worktree inside the container');
  console.log('  --export-patch[=PATH] Export changes from temp-git repo after run (defaults to .devcon/drafts/<ts>.patch)');
  console.log(`  -api, --api   Enable API mode (HTTP control plane, defaults to ${API_DEFAULT_HOST}:${API_DEFAULT_PORT})`);
  console.log('  --api-host    Host/interface to bind API server');
  console.log('  --api-port    TCP port for API mode');
  console.log('  --help        Show this message');
  console.log('\nCommands:');
  console.log('  update        Refresh Docker images for one or more tools (pull base, rerun npm install)');
  console.log('  rebuild       Fully rebuild Docker images for one or more tools (no cache)');
  console.log('  sensitive     List/add/remove sensitive-path patterns that get masked in containers');
  console.log('  skip-scan     List/add/remove directory names skipped during sensitive-pattern scanning');
  console.log('  run           Launch an interactive container shell (default image)');
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
  allowGit: boolean;
  tempGit: boolean;
  interactiveTerminal: boolean;
}): { command: string; args: string[]; cleanup: () => void; tempGitDir?: string } {
  const dockerArgs: string[] = options.interactiveTerminal
    ? ['run', '--rm', '-it']
    : ['run', '--rm', '-i'];
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
  const sensitivePaths = discoverSensitivePaths(options.cwd, workspaceTarget, { allowGit: options.allowGit });
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

  let initScriptPath: string | undefined;

  let tempGitDir: string | undefined;

  if (options.tempGit) {
    const temp = prepareTempGitRepo(workspaceTarget);
    tempGitDir = temp.hostDir;
    cleanupTargets.push(temp.hostDir);
    dockerArgs.push('--mount', `type=bind,source=${temp.hostDir},target=${temp.containerDir}`);
    dockerArgs.push('-e', `GIT_DIR=${temp.containerDir}`);
    dockerArgs.push('-e', `GIT_WORK_TREE=${workspaceTarget}`);
    console.log('Temporary git repo enabled: host .git remains masked.');

    const initDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-temp-git-init-'));
    cleanupTargets.push(initDir);
    initScriptPath = path.join(initDir, 'init.sh');
    const initScript = `#!/bin/bash
set -e
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git add -A >/dev/null 2>&1 || true
  git commit -m "devcon baseline" >/dev/null 2>&1 || true
fi
`;
    writeFileSync(initScriptPath, initScript, { encoding: 'utf8', mode: 0o755 });
    dockerArgs.push('--mount', `type=bind,source=${initScriptPath},target=/tmp/devcon/init.sh,readonly`);
  }

  if (options.allowGit) {
    const gitCfgDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-gitcfg-'));
    cleanupTargets.push(gitCfgDir);
    const gitCfgPath = path.join(gitCfgDir, 'config');
    const gitConfigContents = '[user]\n\tname = devcon-bot\n\temail = devcon@example.com\n';
    writeFileSync(gitCfgPath, gitConfigContents, 'utf8');
    dockerArgs.push('--mount', `type=bind,source=${gitCfgPath},target=/tmp/devcon/gitconfig,readonly`);
    dockerArgs.push('-e', 'GIT_CONFIG_GLOBAL=/tmp/devcon/gitconfig');
    console.log('Git access enabled: .git unmasked and sandboxed identity configured (devcon-bot).');
  }

  dockerArgs.push(options.image);

  const toolCommand = options.tool.command ?? [];
  const commandArgs = [...toolCommand, ...options.toolArgs];

  if (initScriptPath) {
    const commandString = commandArgs.length > 0
      ? commandArgs.map(shellQuote).join(' ')
      : '/bin/bash';
    dockerArgs.push('/bin/bash', '-lc', `source /tmp/devcon/init.sh && exec ${commandString}`);
  } else {
    dockerArgs.push(...commandArgs);
  }

  const cleanup = (): void => {
    for (const target of cleanupTargets) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (error) {
        console.warn('Failed to clean temporary artifact', target, error);
      }
    }
  };

  return { command: 'docker', args: dockerArgs, cleanup, tempGitDir };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  const tools = readTools();

  if (options.helpRequested) {
    printHelp(tools);
    return;
  }

  if (options.allowGit && options.tempGit) {
    throw new Error('Use either --with-git or --temp-git, not both.');
  }

  if (options.exportPatchPath !== undefined && !options.tempGit) {
    throw new Error('--export-patch requires --temp-git so the host repository stays masked.');
  }

  if (!options.toolName) {
    console.error('No tool specified.');
    printHelp(tools);
    process.exitCode = 1;
    return;
  }

  if (
    options.apiMode
    && ['update', 'rebuild', 'sensitive', 'skip-scan'].includes(options.toolName)
  ) {
    throw new Error('API mode is only supported for tool sessions (e.g. "devcon -api codex" or "devcon -api run").');
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

  if (options.toolName === 'run') {
    ensureDockerAvailable();
    const image = options.imageOverride ?? DEFAULT_IMAGE_TAG;
    await ensureImageAvailable(
      image,
      image === DEFAULT_IMAGE_TAG ? DEFAULT_AUTO_BUILD : undefined,
      { allowNonInteractiveBuild: options.apiMode },
    );

    const toolDef: ToolDefinition = {
      image,
      command: options.toolArgs.length === 0 ? ['/bin/bash'] : [],
      description: 'Interactive shell',
    };

    const { command, args, cleanup, tempGitDir } = buildDockerArgs({
      cwd,
      toolName: options.toolName,
      tool: toolDef,
      toolArgs: options.toolArgs,
      shareHome: options.shareHome,
      image,
      allowGit: options.allowGit,
      tempGit: options.tempGit,
      interactiveTerminal: true,
    });

    if (options.dryRun) {
      console.log([command, ...args].join(' '));
      cleanup();
      return;
    }

    if (options.apiMode) {
      await runApiModeSession({
        toolName: options.toolName,
        command,
        args,
        cwd,
        apiHost: options.apiHost,
        apiPort: options.apiPort,
        tempGit: options.tempGit,
        tempGitDir,
        exportPatchPath: options.exportPatchPath,
        cleanup,
      });
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
    return;
  }

  if (!tool) {
    console.error(`Unknown tool "${options.toolName}".`);
    printHelp(tools);
    process.exitCode = 1;
    return;
  }

  ensureDockerAvailable();

  console.log(`Preparing to launch tool "${options.toolName}" using image "${tool.image}"...`);

  let apiPromptExecCommand: string[] | undefined;
  let effectiveTool = tool;
  if (options.apiMode && options.toolName === 'codex') {
    // Codex TUI crashes in detached/bridged terminal mode; use per-request exec instead.
    effectiveTool = {
      ...tool,
      command: ['/bin/sh', '-lc', 'while true; do sleep 3600; done'],
    };
    apiPromptExecCommand = ['codex', 'exec'];
  }

  const image = options.imageOverride ?? tool.image;
  await ensureImageAvailable(
    image,
    options.imageOverride ? undefined : tool.autoBuild,
    { allowNonInteractiveBuild: options.apiMode },
  );

  const { command, args, cleanup, tempGitDir } = buildDockerArgs({
    cwd,
    toolName: options.toolName,
    tool: effectiveTool,
    toolArgs: options.toolArgs,
    shareHome: options.shareHome && effectiveTool.shareHome !== false,
    image,
    allowGit: options.allowGit,
    tempGit: options.tempGit,
    interactiveTerminal: true,
  });

  if (options.dryRun) {
    console.log([command, ...args].join(' '));
    cleanup();
    return;
  }

  if (options.apiMode) {
    await runApiModeSession({
      toolName: options.toolName,
      command,
      args,
      cwd,
      apiHost: options.apiHost,
      apiPort: options.apiPort,
      promptExecCommand: apiPromptExecCommand,
      tempGit: options.tempGit,
      tempGitDir,
      exportPatchPath: options.exportPatchPath,
      cleanup,
    });
    return;
  }

  const child = spawn(command, args, { stdio: 'inherit' });
  const terminate = (): void => {
    child.kill('SIGINT');
  };

  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);

  child.on('exit', (code) => {
    if (options.tempGit && tempGitDir && options.exportPatchPath !== undefined) {
      try {
        exportTempGitPatch(tempGitDir, cwd, options.exportPatchPath || undefined);
      } catch (error) {
        console.warn('Failed to export patch from temp git repo:', error instanceof Error ? error.message : error);
      }
    }
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
