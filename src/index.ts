#!/usr/bin/env node
import { spawn, spawnSync, SpawnOptionsWithoutStdio } from 'child_process';
import { randomBytes } from 'crypto';
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
import {
  bootstrapConsciousPaths,
  ConsciousArchiveStore,
  ArchiveSearchHit,
  ArchiveRecord,
} from './conscious-archive';

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
  forceIpv4: boolean;
  networkHost: boolean;
  conscious: boolean;
  consciousStatePath?: string;
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
const CONSCIOUS_ROOT_PATH = path.join(os.homedir(), '.config', 'devcon', 'conscious');
const CONSCIOUS_CONTAINER_STATE_DIR = '/tmp/devcon/conscious';
const CONSCIOUS_CONTAINER_MCP_SERVER = '/tmp/devcon/conscious-mcp-server.js';
const CONSCIOUS_CONTAINER_ARCHIVE_MODULE = '/tmp/devcon/conscious-archive.js';
const CONSCIOUS_MCP_NAME = 'devcon-archive';
const WORKSPACE_TARGET = '/workspace';
const HOME_READONLY_DEFAULT = parseBooleanEnv(process.env.DEVCON_HOME_READONLY);
const SHARE_HOME_DEFAULT = parseBooleanEnv(process.env.DEVCON_SHARE_HOME);
const DEFAULT_IMAGE_TAG = 'devcon:latest';
const DEFAULT_IMAGE_DOCKERFILE = path.resolve(__dirname, '..', 'docker', 'devcon', 'Dockerfile');
const NETWORK_CHECK_HOST = 'api.openai.com';
const NETWORK_PROBE_TIMEOUT_MS = parsePositiveIntEnv(process.env.DEVCON_NETWORK_PROBE_TIMEOUT_MS, 2500);
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

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
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
  let forceIpv4 = false;
  let networkHost = false;
  let conscious = false;
  let consciousStatePath: string | undefined;
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

    if (arg === '--with-git') {
      allowGit = true;
      continue;
    }

    if (arg === '--temp-git') {
      tempGit = true;
      continue;
    }

    if (arg === '--network-host' || arg === '-network-host') {
      networkHost = true;
      continue;
    }

    if (arg === '--conscious' || arg === '-conscious') {
      conscious = true;
      continue;
    }

    if (arg === '--no-conscious') {
      conscious = false;
      continue;
    }

    if (arg.startsWith('--conscious-path=')) {
      consciousStatePath = arg.substring('--conscious-path='.length);
      conscious = true;
      continue;
    }

    if (arg === '--conscious-path') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--conscious-path flag requires an argument, e.g. --conscious-path ~/.config/devcon/conscious');
      }
      consciousStatePath = next;
      conscious = true;
      i += 1;
      continue;
    }

    if (arg === '--ipv4' || arg === '-ipv4') {
      forceIpv4 = true;
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
    forceIpv4,
    networkHost,
    conscious,
    consciousStatePath,
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

interface GitRepoContext {
  isRepo: boolean;
  repoId: string;
  branch?: string;
  commitSha?: string;
  cleanAtStart: boolean;
}

interface ConsciousRuntime {
  sessionId: string;
  stateDir: string;
  dbPath: string;
  sessionsDir: string;
  repo: GitRepoContext;
  containerStateDir: string;
  containerServerScriptPath: string;
  containerArchiveModulePath: string;
  hostServerScriptPath: string;
  hostArchiveModulePath: string;
  retrievalHostPath: string;
  retrievalContainerPath: string;
  mcpLogHostPath: string;
  mcpLogContainerPath: string;
  captureSource: string;
  seedQuery: string;
}

function getConsciousStateDir(explicitPath: string | undefined, homeDir: string): string {
  if (!explicitPath || explicitPath.trim().length === 0) {
    return CONSCIOUS_ROOT_PATH;
  }
  if (explicitPath === '~') {
    return homeDir;
  }
  if (explicitPath.startsWith('~/')) {
    return path.join(homeDir, explicitPath.slice(2));
  }
  return path.resolve(explicitPath);
}

function generateSessionId(): string {
  return `session_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function getGitRepoContext(cwd: string): GitRepoContext {
  const repoCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== 'true') {
    return {
      isRepo: false,
      repoId: path.resolve(cwd),
      cleanAtStart: false,
    };
  }

  const remoteUrl = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const repoIdCandidate = remoteUrl.status === 0 && remoteUrl.stdout.trim().length > 0
    ? remoteUrl.stdout.trim()
    : repoRoot.status === 0 && repoRoot.stdout.trim().length > 0
      ? repoRoot.stdout.trim()
      : path.resolve(cwd);

  return {
    isRepo: true,
    repoId: repoIdCandidate,
    branch: branch.status === 0 ? branch.stdout.trim() : undefined,
    commitSha: commit.status === 0 ? commit.stdout.trim() : undefined,
    cleanAtStart: status.status === 0 && status.stdout.trim().length === 0,
  };
}

function deriveConsciousQuery(toolArgs: string[], cwd: string): string {
  const joined = toolArgs.join(' ').trim();
  if (joined.length > 0) {
    return joined;
  }
  return `working in ${path.basename(cwd)}`;
}

function formatRetrievalMarkdown(hits: ArchiveSearchHit[]): string {
  if (hits.length === 0) {
    return '# Relevant prior findings\n\nNo prior findings matched this launch context.\n';
  }
  const lines: string[] = ['# Relevant prior findings', ''];
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.summary}`);
    lines.push(`   - id: ${hit.id}`);
    lines.push(`   - confidence: ${hit.confidence.toFixed(2)} | score: ${hit.score.toFixed(2)}`);
    if (hit.tags.length > 0) {
      lines.push(`   - tags: ${hit.tags.join(', ')}`);
    }
    lines.push(`   - problem: ${hit.problem}`);
    lines.push(`   - solution: ${hit.solution}`);
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function getConsciousServerScriptPath(): string {
  const distPath = path.resolve(__dirname, 'conscious-mcp-server.js');
  if (existsSync(distPath)) {
    return distPath;
  }
  throw new Error(`Conscious mode requires ${distPath}. Build devcon first (npm run build).`);
}

function getConsciousArchiveModulePath(): string {
  const distPath = path.resolve(__dirname, 'conscious-archive.js');
  if (existsSync(distPath)) {
    return distPath;
  }
  throw new Error(`Conscious mode requires ${distPath}. Build devcon first (npm run build).`);
}

function prepareConsciousRuntime(
  cwd: string,
  toolArgs: string[],
  explicitStatePath: string | undefined,
): ConsciousRuntime {
  const stateDir = getConsciousStateDir(explicitStatePath, os.homedir());
  const paths = bootstrapConsciousPaths(stateDir);
  const archive = new ConsciousArchiveStore(paths.dbPath);
  archive.ensureInitialized();

  const repo = getGitRepoContext(cwd);
  const seedQuery = deriveConsciousQuery(toolArgs, cwd);
  const retrievalHits = archive.search({
    query: seedQuery,
    repo: repo.repoId,
    topK: 5,
    minConfidence: 0.35,
  });

  const sessionId = generateSessionId();
  const retrievalHostPath = path.join(paths.sessionsDir, `${sessionId}.retrieval.md`);
  writeFileSync(retrievalHostPath, formatRetrievalMarkdown(retrievalHits), 'utf8');
  const mcpLogHostPath = path.join(paths.sessionsDir, `${sessionId}.mcp.log`);

  const metadataPath = path.join(paths.sessionsDir, `${sessionId}.json`);
  const metadata = {
    sessionId,
    createdAt: new Date().toISOString(),
    seedQuery,
    retrievalCount: retrievalHits.length,
    repo: repo.repoId,
    branch: repo.branch,
    commitSha: repo.commitSha,
    cleanAtStart: repo.cleanAtStart,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  return {
    sessionId,
    stateDir: paths.rootDir,
    dbPath: paths.dbPath,
    sessionsDir: paths.sessionsDir,
    repo,
    containerStateDir: CONSCIOUS_CONTAINER_STATE_DIR,
    containerServerScriptPath: CONSCIOUS_CONTAINER_MCP_SERVER,
    containerArchiveModulePath: CONSCIOUS_CONTAINER_ARCHIVE_MODULE,
    hostServerScriptPath: getConsciousServerScriptPath(),
    hostArchiveModulePath: getConsciousArchiveModulePath(),
    retrievalHostPath,
    retrievalContainerPath: path.join(CONSCIOUS_CONTAINER_STATE_DIR, 'sessions', `${sessionId}.retrieval.md`),
    mcpLogHostPath,
    mcpLogContainerPath: path.join(CONSCIOUS_CONTAINER_STATE_DIR, 'sessions', `${sessionId}.mcp.log`),
    captureSource: `devcon:auto:${sessionId}`,
    seedQuery,
  };
}

function parseChangedFiles(statusOutput: string): string[] {
  const files: string[] = [];
  for (const line of statusOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length < 4) {
      continue;
    }
    const pathPart = trimmed.slice(3).trim();
    if (pathPart.length > 0) {
      files.push(pathPart);
    }
  }
  return files;
}

function countDiffHunkLines(diffOutput: string): number {
  let total = 0;
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      total += 1;
    }
  }
  return total;
}

function truncateEvidence(diffOutput: string, maxLines = 80): string[] {
  return diffOutput
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

function inferTagsFromFiles(files: string[]): string[] {
  const tags = new Set<string>();
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext) {
      tags.add(ext.replace('.', ''));
    }
    if (filePath.includes('test')) {
      tags.add('test');
    }
    if (filePath.includes('docker')) {
      tags.add('docker');
    }
    if (filePath.includes('config')) {
      tags.add('config');
    }
  }
  return [...tags].slice(0, 10);
}

function maybeCaptureConsciousLearning(runtime: ConsciousRuntime | undefined, cwd: string, exitCode: number | null): ArchiveRecord | undefined {
  if (!runtime || exitCode !== 0) {
    return undefined;
  }

  if (!runtime.repo.isRepo || !runtime.repo.cleanAtStart) {
    return undefined;
  }

  const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (statusAfter.status !== 0 || statusAfter.stdout.trim().length === 0) {
    return undefined;
  }

  const diff = spawnSync('git', ['diff', '--no-color', '--unified=1'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (diff.status !== 0 || diff.stdout.trim().length === 0) {
    return undefined;
  }

  const changedFiles = parseChangedFiles(statusAfter.stdout);
  const changedLineCount = countDiffHunkLines(diff.stdout);
  if (changedFiles.length === 0 || changedLineCount < 6) {
    return undefined;
  }

  const archive = new ConsciousArchiveStore(runtime.dbPath);
  archive.ensureInitialized();

  const summary = `Session ${runtime.sessionId} changed ${changedFiles.length} file(s) and ${changedLineCount} diff line(s).`;
  const problem = `Similar task context: ${runtime.seedQuery}`;
  const solution = `Inspect changes in ${changedFiles.slice(0, 5).join(', ')} and reuse the same edit pattern.`;
  const evidence = truncateEvidence(diff.stdout);
  const tags = inferTagsFromFiles(changedFiles);
  return archive.write({
    repo: runtime.repo.repoId,
    branch: runtime.repo.branch,
    commitSha: runtime.repo.commitSha,
    summary,
    problem,
    solution,
    evidence,
    tags,
    confidence: 0.45,
    ttlDays: 120,
    source: runtime.captureSource,
  });
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

type NetworkProbeResult = 'reachable' | 'unreachable' | 'unsupported';

function probeContainerHostResolution(image: string, useHostNetwork: boolean): NetworkProbeResult {
  const networkArgs = useHostNetwork ? ['--network', 'host'] : [];
  const probeScript = `if command -v getent >/dev/null 2>&1; then getent hosts ${NETWORK_CHECK_HOST} >/dev/null 2>&1; elif command -v nslookup >/dev/null 2>&1; then nslookup ${NETWORK_CHECK_HOST} >/dev/null 2>&1; else exit 42; fi`;
  const probe = spawnSync(
    'docker',
    ['run', '--rm', ...networkArgs, '--entrypoint', '/bin/sh', image, '-lc', probeScript],
    { stdio: 'ignore', timeout: NETWORK_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      return 'unreachable';
    }
    return 'unsupported';
  }
  if (probe.status === 0) {
    return 'reachable';
  }
  if (probe.status === 42) {
    return 'unsupported';
  }
  if (probe.status === 126 || probe.status === 127) {
    return 'unsupported';
  }
  return 'unreachable';
}

async function maybeEnableHostNetwork(
  image: string,
  networkHostRequested: boolean,
  dryRun: boolean,
): Promise<boolean> {
  if (networkHostRequested || dryRun) {
    return networkHostRequested;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return networkHostRequested;
  }

  const bridgeProbe = probeContainerHostResolution(image, false);
  if (bridgeProbe === 'reachable' || bridgeProbe === 'unsupported') {
    return networkHostRequested;
  }

  const hostProbe = probeContainerHostResolution(image, true);
  if (hostProbe !== 'reachable') {
    return networkHostRequested;
  }

  console.warn(`Container could not resolve "${NETWORK_CHECK_HOST}" on Docker bridge networking.`);
  console.warn('Host networking works and may avoid VPN/Docker DNS conflicts.');
  const switchToHost = await promptYesNo('Switch this run to --network-host? [y/N] ');
  return switchToHost;
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
  console.log('  --with-git    Unmask .git and inject a sandboxed git user inside the container');
  console.log('  --temp-git    Mask host .git but provide a temporary git repo/worktree inside the container');
  console.log('  --export-patch[=PATH] Export changes from temp-git repo after run (defaults to .devcon/drafts/<ts>.patch)');
  console.log('  --network-host, -network-host Use host networking (helps with VPNs that block Docker bridge DNS/NAT)');
  console.log('  --ipv4, -ipv4 Force IPv4-only networking by disabling IPv6 inside the container');
  console.log('  --conscious, -conscious Enable persistent archive memory and auto-mount MCP tools');
  console.log('  --conscious-path PATH Override where conscious state is stored (default: ~/.config/devcon/conscious)');
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
  forceIpv4: boolean;
  networkHost: boolean;
  conscious?: ConsciousRuntime;
}): { command: string; args: string[]; cleanup: () => void; tempGitDir?: string } {
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

  if (options.networkHost) {
    dockerArgs.push('--network', 'host');
    console.log('Host network mode enabled: container will use host DNS/routing stack.');
  }

  if (options.forceIpv4 && !options.networkHost) {
    dockerArgs.push('--sysctl', 'net.ipv6.conf.all.disable_ipv6=1');
    dockerArgs.push('--sysctl', 'net.ipv6.conf.default.disable_ipv6=1');
    console.log('IPv4-only mode enabled: IPv6 disabled inside container networking.');
  } else if (options.forceIpv4 && options.networkHost) {
    console.warn('Ignoring --ipv4 in --network-host mode: the container shares host network settings.');
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
  const initScriptLines: string[] = [];
  const postRunCleanupLines: string[] = [];
  let tempGitDir: string | undefined;

  if (options.tempGit) {
    const temp = prepareTempGitRepo(workspaceTarget);
    tempGitDir = temp.hostDir;
    cleanupTargets.push(temp.hostDir);
    dockerArgs.push('--mount', `type=bind,source=${temp.hostDir},target=${temp.containerDir}`);
    dockerArgs.push('-e', `GIT_DIR=${temp.containerDir}`);
    dockerArgs.push('-e', `GIT_WORK_TREE=${workspaceTarget}`);
    console.log('Temporary git repo enabled: host .git remains masked.');

    initScriptLines.push(
      'if ! git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  git add -A >/dev/null 2>&1 || true',
      '  git commit -m "devcon baseline" >/dev/null 2>&1 || true',
      'fi',
    );
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

  if (options.conscious) {
    dockerArgs.push('--mount', `type=bind,source=${options.conscious.stateDir},target=${options.conscious.containerStateDir}`);
    dockerArgs.push('--mount', `type=bind,source=${options.conscious.hostServerScriptPath},target=${options.conscious.containerServerScriptPath},readonly`);
    dockerArgs.push('--mount', `type=bind,source=${options.conscious.hostArchiveModulePath},target=${options.conscious.containerArchiveModulePath},readonly`);
    dockerArgs.push('-e', 'DEVCON_CONSCIOUS=1');
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_STATE_DIR=${options.conscious.containerStateDir}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_REPO=${options.conscious.repo.repoId}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_SESSION_ID=${options.conscious.sessionId}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_RETRIEVAL_FILE=${options.conscious.retrievalContainerPath}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_DEBUG_LOG=${options.conscious.mcpLogContainerPath}`);

    const serverArgs = [
      'node',
      options.conscious.containerServerScriptPath,
      '--state-dir',
      options.conscious.containerStateDir,
      '--repo',
      options.conscious.repo.repoId,
      '--debug-log',
      options.conscious.mcpLogContainerPath,
    ].map(shellQuote).join(' ');

    if (options.toolName === 'codex') {
      initScriptLines.push(
        `if command -v codex >/dev/null 2>&1; then`,
        `  codex mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
        `  codex mcp add ${CONSCIOUS_MCP_NAME} -- ${serverArgs} >/dev/null 2>&1 || true`,
        'fi',
      );
      postRunCleanupLines.push(`codex mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`);
    } else if (options.toolName === 'claude') {
      initScriptLines.push(
        'if command -v claude >/dev/null 2>&1; then',
        `  claude mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
        `  claude mcp add --transport stdio ${CONSCIOUS_MCP_NAME} -- ${serverArgs} >/dev/null 2>&1 || true`,
        'fi',
      );
      postRunCleanupLines.push(`claude mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`);
    }
  }

  if (initScriptLines.length > 0) {
    const initDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-init-'));
    cleanupTargets.push(initDir);
    initScriptPath = path.join(initDir, 'init.sh');
    const initScript = `#!/bin/bash
set -e
${initScriptLines.join('\n')}
`;
    writeFileSync(initScriptPath, initScript, { encoding: 'utf8', mode: 0o755 });
    dockerArgs.push('--mount', `type=bind,source=${initScriptPath},target=/tmp/devcon/init.sh,readonly`);
  }

  dockerArgs.push(options.image);

  const toolCommand = options.tool.command ?? [];
  const commandArgs = [...toolCommand, ...options.toolArgs];

  if (initScriptPath) {
    const commandString = commandArgs.length > 0
      ? commandArgs.map(shellQuote).join(' ')
      : '/bin/bash';
    if (postRunCleanupLines.length > 0) {
      const cleanupCommand = postRunCleanupLines.join('\n');
      dockerArgs.push('/bin/bash', '-lc', `source /tmp/devcon/init.sh && ${commandString}; status=$?; ${cleanupCommand}; exit $status`);
    } else {
      dockerArgs.push('/bin/bash', '-lc', `source /tmp/devcon/init.sh && exec ${commandString}`);
    }
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
    const consciousRuntime = options.conscious
      ? prepareConsciousRuntime(cwd, options.toolArgs, options.consciousStatePath)
      : undefined;
    if (consciousRuntime) {
      console.log(`Conscious mode enabled (state: ${consciousRuntime.stateDir})`);
      console.log(`Seed retrieval query: "${consciousRuntime.seedQuery}"`);
      console.log(`MCP debug log: ${consciousRuntime.mcpLogHostPath}`);
    }
    const image = options.imageOverride ?? DEFAULT_IMAGE_TAG;
    await ensureImageAvailable(image, image === DEFAULT_IMAGE_TAG ? DEFAULT_AUTO_BUILD : undefined);
    const networkHost = await maybeEnableHostNetwork(image, options.networkHost, options.dryRun);

    const toolDef: ToolDefinition = {
      image,
      command: options.toolArgs.length === 0 ? ['/bin/bash'] : [],
      description: 'Interactive shell',
    };

    const { command, args, cleanup } = buildDockerArgs({
      cwd,
      toolName: options.toolName,
      tool: toolDef,
      toolArgs: options.toolArgs,
      shareHome: options.shareHome,
      image,
      allowGit: options.allowGit,
      tempGit: options.tempGit,
      forceIpv4: options.forceIpv4,
      networkHost,
      conscious: consciousRuntime,
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
      const captured = maybeCaptureConsciousLearning(consciousRuntime, cwd, code);
      if (captured) {
        console.log(`Conscious mode captured finding ${captured.id}`);
      }
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

  const consciousRuntime = options.conscious
    ? prepareConsciousRuntime(cwd, options.toolArgs, options.consciousStatePath)
    : undefined;
  if (consciousRuntime) {
    console.log(`Conscious mode enabled (state: ${consciousRuntime.stateDir})`);
    console.log(`Seed retrieval query: "${consciousRuntime.seedQuery}"`);
    console.log(`MCP debug log: ${consciousRuntime.mcpLogHostPath}`);
  }

  console.log(`Preparing to launch tool "${options.toolName}" using image "${tool.image}"...`);

  const image = options.imageOverride ?? tool.image;
  await ensureImageAvailable(image, options.imageOverride ? undefined : tool.autoBuild);
  const networkHost = await maybeEnableHostNetwork(image, options.networkHost, options.dryRun);

  const { command, args, cleanup, tempGitDir } = buildDockerArgs({
    cwd,
    toolName: options.toolName,
    tool,
    toolArgs: options.toolArgs,
    shareHome: options.shareHome && tool.shareHome !== false,
    image,
    allowGit: options.allowGit,
    tempGit: options.tempGit,
    forceIpv4: options.forceIpv4,
    networkHost,
    conscious: consciousRuntime,
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
    if (options.tempGit && tempGitDir && options.exportPatchPath !== undefined) {
      try {
        exportTempGitPatch(tempGitDir, cwd, options.exportPatchPath || undefined);
      } catch (error) {
        console.warn('Failed to export patch from temp git repo:', error instanceof Error ? error.message : error);
      }
    }
    const captured = maybeCaptureConsciousLearning(consciousRuntime, cwd, code);
    if (captured) {
      console.log(`Conscious mode captured finding ${captured.id}`);
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
