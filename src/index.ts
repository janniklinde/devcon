#!/usr/bin/env node
import { spawn, spawnSync, SpawnOptionsWithoutStdio } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
  existsSync,
  accessSync,
  constants as fsConstants,
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
  cpSync,
  lstatSync,
} from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as net from 'net';
import {
  bootstrapConsciousPaths,
  resolveConsciousPaths,
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
  backend: BackendType;
  imageOverride?: string;
  mountPaths: string[];
  shareHome: boolean;
  helpRequested: boolean;
  allowGit: boolean;
  tempGit: boolean;
  exportPatchPath?: string;
  forceIpv4: boolean;
  networkHost: boolean;
  conscious: boolean;
  consciousStatePath?: string;
  webMode: boolean;
  webHost?: string;
  webPort?: number;
  webPassword?: string;
  webSessionName?: string;
}

type BackendType = 'docker' | 'microvm';

interface AutoBuildConfig {
  dockerfile: string;
  tag: string;
  description?: string;
}

interface ExtraMount {
  hostPath: string;
  mountName: string;
}

interface LaunchPlan {
  command: string;
  args: string[];
  cleanup: () => void;
  cleanupTargets: string[];
  tempGitDir?: string;
  finalize?: () => void | Promise<void>;
}

interface SyncPlanTarget {
  label: string;
  hostPath: string;
  guestPath: string;
  stagePath: string;
  rootType: 'file' | 'dir';
  initialEntries: Set<string>;
}

type MicrovmGuestArch = 'amd64' | 'arm64';

interface MicrovmHostDependency {
  command: string;
  aptPackage?: string;
  brewPackage?: string;
}

interface MicrovmProfile {
  hostPlatform: NodeJS.Platform;
  hostArch: string;
  guestArch: MicrovmGuestArch;
  qemuBinary: string;
  downloadUrl: string;
  pristineImageName: string;
  preparedImageName: string;
  firmwareCandidates: string[];
  startArgs: (options: {
    imagePath: string;
    sshPort: number;
    pidFilePath: string;
    serialLogPath: string;
    seedImagePath?: string;
    firmwarePath?: string;
  }) => string[];
  dependencies: MicrovmHostDependency[];
}

const CONFIG_PATH = process.env.DEVCON_TOOLS_FILE
  || path.join(os.homedir(), '.config', 'devcon', 'tools.json');
const SENSITIVE_CONFIG_PATH = path.join(os.homedir(), '.config', 'devcon', 'sensitive.json');
const SKIP_SCAN_CONFIG_PATH = path.join(os.homedir(), '.config', 'devcon', 'skip-scan.json');
const CONSCIOUS_ROOT_PATH = path.join(os.homedir(), '.config', 'devcon', 'conscious');
const CONSCIOUS_CONTAINER_MCP_CLIENT = '/tmp/devcon/conscious-mcp-tcp-client.js';
const CONSCIOUS_SIDECAR_SERVER_SCRIPT = '/opt/devcon/conscious-mcp-tcp-server.js';
const CONSCIOUS_SIDECAR_MCP_SERVER_SCRIPT = '/opt/devcon/conscious-mcp-server.js';
const CONSCIOUS_SIDECAR_ARCHIVE_MODULE = '/opt/devcon/conscious-archive.js';
const CONSCIOUS_SIDECAR_STATE_DIR = '/state';
const CONSCIOUS_SIDECAR_NETWORK = 'devcon-conscious-net';
const CONSCIOUS_SIDECAR_REV = '4';
const CONSCIOUS_SIDECAR_PORT = parsePositiveIntEnv(process.env.DEVCON_CONSCIOUS_TCP_PORT, 8765);
const CONSCIOUS_SIDECAR_READY_TIMEOUT_MS = parsePositiveIntEnv(process.env.DEVCON_CONSCIOUS_READY_TIMEOUT_MS, 15_000);
const CONSCIOUS_MEMORY_POLICY = process.env.DEVCON_CONSCIOUS_MEMORY_POLICY;
const CONSCIOUS_MEMORY_POLICY_THRESHOLD = process.env.DEVCON_CONSCIOUS_MEMORY_POLICY_THRESHOLD;
const CONSCIOUS_MCP_NAME = 'devcon-archive';
const CONSCIOUS_PROJECT_ID_RELATIVE_PATH = 'devcon/project-id';
const CONSCIOUS_PROJECTS_DIRNAME = 'projects';
const CONSCIOUS_PROJECT_REGISTRY_FILENAME = 'projects.json';
const WORKSPACE_ROOT = '/workspace';
const DEFAULT_WORKSPACE_DIRNAME = 'project';
const HOME_READONLY_DEFAULT = parseBooleanEnv(process.env.DEVCON_HOME_READONLY);
const SHARE_HOME_DEFAULT = parseBooleanEnv(process.env.DEVCON_SHARE_HOME);
const DEFAULT_IMAGE_TAG = 'devcon:latest';
const DEFAULT_IMAGE_DOCKERFILE = path.resolve(__dirname, '..', 'docker', 'devcon', 'Dockerfile');
const DEFAULT_BACKEND: BackendType = process.env.DEVCON_BACKEND === 'microvm' ? 'microvm' : 'docker';
const NETWORK_CHECK_HOST = 'api.openai.com';
const NETWORK_PROBE_TIMEOUT_MS = parsePositiveIntEnv(process.env.DEVCON_NETWORK_PROBE_TIMEOUT_MS, 2500);
const WEB_DEFAULT_HOST = '0.0.0.0';
const WEB_DEFAULT_PORT = 7682;
const MICROVM_ROOT_PATH = resolveMicrovmRootPath();
const MICROVM_IMAGE_URL_AMD64 = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img';
const MICROVM_IMAGE_URL_ARM64 = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img';
const MICROVM_GUEST_USER = 'devcon';
const MICROVM_GUEST_HOME = `/home/${MICROVM_GUEST_USER}`;
const MICROVM_BOOT_TIMEOUT_MS = parsePositiveIntEnv(process.env.DEVCON_MICROVM_BOOT_TIMEOUT_MS, 120_000);
const MICROVM_PREPARE_TIMEOUT_MS = parsePositiveIntEnv(process.env.DEVCON_MICROVM_PREPARE_TIMEOUT_MS, 900_000);
const MICROVM_DEFAULT_MEMORY_MB = parsePositiveIntEnv(process.env.DEVCON_MICROVM_MEMORY_MB, 4096);
const MICROVM_DEFAULT_CPUS = parsePositiveIntEnv(process.env.DEVCON_MICROVM_CPUS, 2);
const MICROVM_DISK_SIZE_GB = parsePositiveIntEnv(process.env.DEVCON_MICROVM_DISK_SIZE_GB, 16);
const MICROVM_PREPARED_IMAGE_REV = '2';
const MICROVM_FIRMWARE_ENV = 'DEVCON_MICROVM_FIRMWARE';
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

function pathIsWritable(target: string): boolean {
  try {
    const probe = existsSync(target) ? target : path.dirname(target);
    accessSync(probe, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveMicrovmRootPath(): string {
  const explicit = process.env.DEVCON_MICROVM_ROOT;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }

  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache && pathIsWritable(xdgCache)) {
    return path.join(path.resolve(xdgCache), 'devcon', 'microvm');
  }

  const homeDir = os.homedir();
  if (homeDir && pathIsWritable(homeDir)) {
    return path.join(homeDir, '.cache', 'devcon', 'microvm');
  }

  const uidSuffix = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown';
  return path.join(os.tmpdir(), `devcon-${uidSuffix}`, 'microvm');
}

function normalizeHostArch(arch: string): 'x64' | 'arm64' | 'unknown' {
  if (arch === 'x64') {
    return 'x64';
  }
  if (arch === 'arm64' || arch === 'aarch64') {
    return 'arm64';
  }
  return 'unknown';
}

function resolveMicrovmProfile(): MicrovmProfile {
  const normalizedArch = normalizeHostArch(os.arch());
  const preparedSuffix = `r${MICROVM_PREPARED_IMAGE_REV}-${MICROVM_DISK_SIZE_GB}g`;
  if (process.platform === 'darwin' && normalizedArch === 'arm64') {
    return {
      hostPlatform: process.platform,
      hostArch: os.arch(),
      guestArch: 'arm64',
      qemuBinary: 'qemu-system-aarch64',
      downloadUrl: process.env.DEVCON_MICROVM_IMAGE_URL || MICROVM_IMAGE_URL_ARM64,
      pristineImageName: 'ubuntu-24.04-cloudimg-arm64.img',
      preparedImageName: `devcon-microvm-base-arm64-${preparedSuffix}.qcow2`,
      firmwareCandidates: [
        process.env[MICROVM_FIRMWARE_ENV] ?? '',
        '/opt/homebrew/share/qemu/edk2-aarch64-code.fd',
        '/opt/homebrew/share/qemu/QEMU_EFI.fd',
        '/usr/local/share/qemu/edk2-aarch64-code.fd',
        '/usr/local/share/qemu/QEMU_EFI.fd',
      ].filter((entry) => entry.length > 0),
      startArgs: ({ imagePath, sshPort, pidFilePath, serialLogPath, seedImagePath, firmwarePath }) => {
        if (!firmwarePath) {
          throw new Error(
            `Apple Silicon microVM launches require an AArch64 UEFI firmware file. Set ${MICROVM_FIRMWARE_ENV} if QEMU was installed outside Homebrew.`,
          );
        }
        const args = [
          '-daemonize',
          '-display',
          'none',
          '-machine',
          'virt,accel=hvf:tcg',
          '-cpu',
          'max',
          '-m',
          String(MICROVM_DEFAULT_MEMORY_MB),
          '-smp',
          String(MICROVM_DEFAULT_CPUS),
          '-pidfile',
          pidFilePath,
          '-serial',
          `file:${serialLogPath}`,
          '-bios',
          firmwarePath,
          '-drive',
          `if=virtio,format=qcow2,file=${imagePath}`,
          '-nic',
          `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
        ];
        if (seedImagePath) {
          args.push('-drive', `if=virtio,format=raw,file=${seedImagePath},readonly=on`);
        }
        return args;
      },
      dependencies: [
        { command: 'qemu-system-aarch64', brewPackage: 'qemu' },
        { command: 'qemu-img', brewPackage: 'qemu' },
        { command: 'ssh' },
        { command: 'ssh-keygen' },
        { command: 'curl' },
        { command: 'tar' },
      ],
    };
  }

  if (process.platform === 'linux' && normalizedArch === 'x64') {
    return {
      hostPlatform: process.platform,
      hostArch: os.arch(),
      guestArch: 'amd64',
      qemuBinary: 'qemu-system-x86_64',
      downloadUrl: process.env.DEVCON_MICROVM_IMAGE_URL || MICROVM_IMAGE_URL_AMD64,
      pristineImageName: 'ubuntu-24.04-cloudimg-amd64.img',
      preparedImageName: `devcon-microvm-base-amd64-${preparedSuffix}.qcow2`,
      firmwareCandidates: [],
      startArgs: ({ imagePath, sshPort, pidFilePath, serialLogPath, seedImagePath }) => {
        const args = [
          '-daemonize',
          '-display',
          'none',
          '-machine',
          'q35,accel=kvm:tcg',
          '-cpu',
          'max',
          '-m',
          String(MICROVM_DEFAULT_MEMORY_MB),
          '-smp',
          String(MICROVM_DEFAULT_CPUS),
          '-pidfile',
          pidFilePath,
          '-serial',
          `file:${serialLogPath}`,
          '-drive',
          `if=virtio,format=qcow2,file=${imagePath}`,
          '-nic',
          `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
        ];
        if (seedImagePath) {
          args.push('-drive', `if=virtio,format=raw,file=${seedImagePath},readonly=on`);
        }
        return args;
      },
      dependencies: [
        { command: 'qemu-system-x86_64', aptPackage: 'qemu-system-x86' },
        { command: 'qemu-img', aptPackage: 'qemu-utils' },
        { command: 'cloud-localds', aptPackage: 'cloud-image-utils' },
        { command: 'ssh', aptPackage: 'openssh-client' },
        { command: 'ssh-keygen', aptPackage: 'openssh-client' },
        { command: 'curl', aptPackage: 'curl' },
        { command: 'tar', aptPackage: 'tar' },
      ],
    };
  }

  if (process.platform === 'linux' && normalizedArch === 'arm64') {
    return {
      hostPlatform: process.platform,
      hostArch: os.arch(),
      guestArch: 'arm64',
      qemuBinary: 'qemu-system-aarch64',
      downloadUrl: process.env.DEVCON_MICROVM_IMAGE_URL || MICROVM_IMAGE_URL_ARM64,
      pristineImageName: 'ubuntu-24.04-cloudimg-arm64.img',
      preparedImageName: `devcon-microvm-base-arm64-${preparedSuffix}.qcow2`,
      firmwareCandidates: [
        process.env[MICROVM_FIRMWARE_ENV] ?? '',
        '/usr/share/qemu-efi-aarch64/QEMU_EFI.fd',
        '/usr/share/AAVMF/AAVMF_CODE.fd',
        '/usr/share/edk2/aarch64/QEMU_EFI.fd',
        '/usr/share/qemu/QEMU_EFI.fd',
      ].filter((entry) => entry.length > 0),
      startArgs: ({ imagePath, sshPort, pidFilePath, serialLogPath, seedImagePath, firmwarePath }) => {
        if (!firmwarePath) {
          throw new Error(
            `Linux arm64 microVM launches require an AArch64 UEFI firmware file. Install qemu-efi-aarch64 or set ${MICROVM_FIRMWARE_ENV}.`,
          );
        }
        const args = [
          '-daemonize',
          '-display',
          'none',
          '-machine',
          'virt,accel=kvm:tcg',
          '-cpu',
          'max',
          '-m',
          String(MICROVM_DEFAULT_MEMORY_MB),
          '-smp',
          String(MICROVM_DEFAULT_CPUS),
          '-pidfile',
          pidFilePath,
          '-serial',
          `file:${serialLogPath}`,
          '-bios',
          firmwarePath,
          '-drive',
          `if=virtio,format=qcow2,file=${imagePath}`,
          '-nic',
          `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
        ];
        if (seedImagePath) {
          args.push('-drive', `if=virtio,format=raw,file=${seedImagePath},readonly=on`);
        }
        return args;
      },
      dependencies: [
        { command: 'qemu-system-aarch64', aptPackage: 'qemu-system-arm' },
        { command: 'qemu-img', aptPackage: 'qemu-utils' },
        { command: 'cloud-localds', aptPackage: 'cloud-image-utils' },
        { command: 'ssh', aptPackage: 'openssh-client' },
        { command: 'ssh-keygen', aptPackage: 'openssh-client' },
        { command: 'curl', aptPackage: 'curl' },
        { command: 'tar', aptPackage: 'tar' },
      ],
    };
  }

  throw new Error(
    `The microVM backend is not supported on ${process.platform}/${os.arch()} yet. Supported hosts: linux/x64, linux/arm64, darwin/arm64.`,
  );
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

function resolveExtraMountInput(input: string, cwd: string, homeDir: string): string {
  if (!input || input.trim().length === 0) {
    throw new Error('Mount path entries must not be empty.');
  }
  if (input === '~') {
    return homeDir;
  }
  if (input.startsWith('~/')) {
    return path.join(homeDir, input.substring(2));
  }
  if (path.isAbsolute(input)) {
    return path.resolve(input);
  }
  return path.resolve(cwd, input);
}

function resolveExtraMounts(mountInputs: string[], cwd: string): ExtraMount[] {
  if (mountInputs.length === 0) {
    return [];
  }

  const homeDir = os.homedir();
  const unique = new Set<string>();
  const resolved: ExtraMount[] = [];

  for (const input of mountInputs) {
    const hostPath = resolveExtraMountInput(input, cwd, homeDir);
    if (unique.has(hostPath)) {
      continue;
    }
    if (!existsSync(hostPath)) {
      throw new Error(`Mount path ${hostPath} does not exist.`);
    }
    if (!statSync(hostPath).isDirectory()) {
      throw new Error(`Mount path ${hostPath} must be a directory.`);
    }
    const mountName = path.basename(hostPath);
    if (!mountName || mountName === '.' || mountName === path.sep) {
      throw new Error(`Mount path ${hostPath} must have a valid directory name.`);
    }
    unique.add(hostPath);
    resolved.push({
      hostPath,
      mountName,
    });
  }

  return resolved;
}

function assertNoExtraMounts(mountInputs: string[], commandName: string): void {
  if (mountInputs.length === 0) {
    return;
  }
  throw new Error(`The --mount flag cannot be used with "devcon ${commandName}".`);
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
  const mountPaths: string[] = [];
  let toolName: string | undefined;
  let dryRun = false;
  let backend = DEFAULT_BACKEND;
  let imageOverride: string | undefined;
  let shareHome = SHARE_HOME_DEFAULT;
  let allowGit = false;
  let tempGit = false;
  let exportPatchPath: string | undefined;
  let forceIpv4 = false;
  let networkHost = false;
  let conscious = false;
  let consciousStatePath: string | undefined;
  let webMode = false;
  let webHost: string | undefined;
  let webPort: number | undefined;
  let webPassword: string | undefined;
  let webSessionName: string | undefined;
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

    if (arg.startsWith('--backend=')) {
      const value = arg.substring('--backend='.length).trim();
      if (value !== 'docker' && value !== 'microvm') {
        throw new Error('--backend must be either "docker" or "microvm".');
      }
      backend = value;
      continue;
    }

    if (arg === '--backend') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--backend flag requires an argument, e.g. --backend microvm');
      }
      if (next !== 'docker' && next !== 'microvm') {
        throw new Error('--backend must be either "docker" or "microvm".');
      }
      backend = next;
      i += 1;
      continue;
    }

    if (arg === '--web') {
      webMode = true;
      continue;
    }

    if (arg.startsWith('--web-host=')) {
      webHost = arg.substring('--web-host='.length);
      webMode = true;
      continue;
    }

    if (arg === '--web-host') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--web-host flag requires an argument, e.g. --web-host 0.0.0.0');
      }
      webHost = next;
      webMode = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--web-port=')) {
      const value = arg.substring('--web-port='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--web-port must be a positive integer, e.g. --web-port 7682');
      }
      webPort = parsed;
      webMode = true;
      continue;
    }

    if (arg === '--web-port') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--web-port flag requires an argument, e.g. --web-port 7682');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--web-port must be a positive integer, e.g. --web-port 7682');
      }
      webPort = parsed;
      webMode = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--web-password=')) {
      webPassword = arg.substring('--web-password='.length);
      webMode = true;
      continue;
    }

    if (arg === '--web-password') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--web-password flag requires an argument.');
      }
      webPassword = next;
      webMode = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--web-session=')) {
      webSessionName = arg.substring('--web-session='.length);
      webMode = true;
      continue;
    }

    if (arg === '--web-session') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--web-session flag requires an argument, e.g. --web-session devcon-web');
      }
      webSessionName = next;
      webMode = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--mount=')) {
      const value = arg.substring('--mount='.length);
      if (!value) {
        throw new Error('--mount flag requires a directory path, e.g. --mount ../shared');
      }
      mountPaths.push(value);
      continue;
    }

    if (arg === '--mount') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--mount flag requires a directory path, e.g. --mount ../shared');
      }
      mountPaths.push(next);
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

    if (!toolName) {
      toolName = arg;
      continue;
    }
    toolArgs.push(arg);
  }

  return {
    toolName,
    toolArgs,
    dryRun,
    backend,
    imageOverride,
    mountPaths,
    shareHome,
    helpRequested,
    allowGit,
    tempGit,
    exportPatchPath,
    forceIpv4,
    networkHost,
    conscious,
    consciousStatePath,
    webMode,
    webHost,
    webPort,
    webPassword,
    webSessionName,
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
  projectId: string;
  projectName: string;
  sessionId: string;
  stateDir: string;
  dbPath: string;
  sessionsDir: string;
  repo: GitRepoContext;
  hostServerScriptPath: string;
  hostArchiveModulePath: string;
  hostTcpServerScriptPath: string;
  hostTcpClientScriptPath: string;
  containerTcpClientPath: string;
  retrievalHostPath: string;
  mcpLogHostPath: string;
  sidecarContainerName: string;
  sidecarNetworkName: string;
  sidecarHost: string;
  sidecarPort: number;
  captureSource: string;
  seedQuery: string;
}

interface ConsciousProjectRegistryEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  linkedRepos: string[];
}

interface ConsciousProjectRegistry {
  projects: ConsciousProjectRegistryEntry[];
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

function getConsciousRegistryPath(consciousRootDir: string): string {
  return path.join(consciousRootDir, CONSCIOUS_PROJECT_REGISTRY_FILENAME);
}

function getConsciousProjectsRoot(consciousRootDir: string): string {
  return path.join(consciousRootDir, CONSCIOUS_PROJECTS_DIRNAME);
}

function getConsciousProjectStateDir(consciousRootDir: string, projectId: string): string {
  return path.join(getConsciousProjectsRoot(consciousRootDir), projectId);
}

function loadConsciousProjectRegistry(consciousRootDir: string): ConsciousProjectRegistry {
  const registryPath = getConsciousRegistryPath(consciousRootDir);
  if (!existsSync(registryPath)) {
    return { projects: [] };
  }

  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf8')) as ConsciousProjectRegistry;
    if (!data || !Array.isArray(data.projects)) {
      return { projects: [] };
    }
    const projects = data.projects
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string')
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
        linkedRepos: Array.isArray(entry.linkedRepos)
          ? entry.linkedRepos.filter((repo): repo is string => typeof repo === 'string')
          : [],
      }));
    return { projects };
  } catch {
    return { projects: [] };
  }
}

function saveConsciousProjectRegistry(consciousRootDir: string, registry: ConsciousProjectRegistry): void {
  mkdirSync(consciousRootDir, { recursive: true });
  mkdirSync(getConsciousProjectsRoot(consciousRootDir), { recursive: true });
  const registryPath = getConsciousRegistryPath(consciousRootDir);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function generateConsciousProjectId(): string {
  return `proj_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function upsertConsciousProjectRegistryEntry(
  consciousRootDir: string,
  projectId: string,
  projectName: string,
  repoHint: string,
): ConsciousProjectRegistryEntry {
  const registry = loadConsciousProjectRegistry(consciousRootDir);
  const now = new Date().toISOString();
  const existing = registry.projects.find((entry) => entry.id === projectId);
  if (existing) {
    existing.name = projectName || existing.name;
    existing.updatedAt = now;
    if (!existing.linkedRepos.includes(repoHint)) {
      existing.linkedRepos.push(repoHint);
    }
    saveConsciousProjectRegistry(consciousRootDir, registry);
    return existing;
  }

  const created: ConsciousProjectRegistryEntry = {
    id: projectId,
    name: projectName,
    createdAt: now,
    updatedAt: now,
    linkedRepos: repoHint ? [repoHint] : [],
  };
  registry.projects.push(created);
  saveConsciousProjectRegistry(consciousRootDir, registry);
  return created;
}

function resolveGitPath(cwd: string, relativePath: string): string {
  const result = spawnSync('git', ['rev-parse', '--git-path', relativePath], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error('Unable to resolve git metadata path for conscious project ID.');
  }
  return path.resolve(cwd, result.stdout.trim());
}

function readConsciousProjectIdFromGit(cwd: string): string | undefined {
  try {
    const projectIdPath = resolveGitPath(cwd, CONSCIOUS_PROJECT_ID_RELATIVE_PATH);
    if (!existsSync(projectIdPath)) {
      return undefined;
    }
    const value = readFileSync(projectIdPath, 'utf8').trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeConsciousProjectIdToGit(cwd: string, projectId: string): void {
  const projectIdPath = resolveGitPath(cwd, CONSCIOUS_PROJECT_ID_RELATIVE_PATH);
  mkdirSync(path.dirname(projectIdPath), { recursive: true });
  writeFileSync(projectIdPath, `${projectId}\n`, 'utf8');
}

function inferDefaultProjectName(cwd: string): string {
  const base = path.basename(cwd).trim();
  return base.length > 0 ? base : 'project';
}

async function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function chooseExistingProject(
  projects: ConsciousProjectRegistryEntry[],
  prompt: string,
): Promise<ConsciousProjectRegistryEntry> {
  if (projects.length === 0) {
    throw new Error('No existing conscious projects are available.');
  }
  while (true) {
    const answer = await promptLine(prompt);
    const parsed = Number.parseInt(answer, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= projects.length) {
      return projects[parsed - 1];
    }
    console.log(`Please enter a number between 1 and ${projects.length}.`);
  }
}

function printExistingConsciousProjects(projects: ConsciousProjectRegistryEntry[]): void {
  console.log('Existing conscious projects:');
  if (projects.length === 0) {
    console.log('  (none)');
    return;
  }
  projects.forEach((entry, index) => {
    const linkedRepo = entry.linkedRepos[0] ?? '(no repo hint)';
    console.log(`  ${index + 1}. ${entry.name} [${entry.id}] (${linkedRepo})`);
  });
}

function cloneConsciousProjectState(
  consciousRootDir: string,
  sourceProjectId: string,
  targetProjectId: string,
): void {
  const sourceDir = getConsciousProjectStateDir(consciousRootDir, sourceProjectId);
  const targetDir = getConsciousProjectStateDir(consciousRootDir, targetProjectId);
  if (!existsSync(sourceDir)) {
    mkdirSync(targetDir, { recursive: true });
    return;
  }
  mkdirSync(path.dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true });
}

function createNewConsciousProject(
  consciousRootDir: string,
  cwd: string,
  repo: GitRepoContext,
  projectName: string,
): { projectId: string; projectName: string; projectStateDir: string } {
  const projectId = generateConsciousProjectId();
  upsertConsciousProjectRegistryEntry(consciousRootDir, projectId, projectName, repo.repoId);
  if (repo.isRepo) {
    writeConsciousProjectIdToGit(cwd, projectId);
  }
  return {
    projectId,
    projectName,
    projectStateDir: getConsciousProjectStateDir(consciousRootDir, projectId),
  };
}

async function resolveConsciousProject(
  cwd: string,
  repo: GitRepoContext,
  consciousRootDir: string,
): Promise<{ projectId: string; projectName: string; projectStateDir: string }> {
  if (!repo.isRepo) {
    const existingProjectId = `adhoc_${buildStableSuffix(path.resolve(cwd), 16)}`;
    const projectName = inferDefaultProjectName(cwd);
    upsertConsciousProjectRegistryEntry(consciousRootDir, existingProjectId, projectName, repo.repoId);
    return {
      projectId: existingProjectId,
      projectName,
      projectStateDir: getConsciousProjectStateDir(consciousRootDir, existingProjectId),
    };
  }

  const existingProjectId = readConsciousProjectIdFromGit(cwd);
  if (existingProjectId) {
    const registry = loadConsciousProjectRegistry(consciousRootDir);
    const existing = registry.projects.find((entry) => entry.id === existingProjectId);
    const projectName = existing?.name ?? inferDefaultProjectName(cwd);
    upsertConsciousProjectRegistryEntry(consciousRootDir, existingProjectId, projectName, repo.repoId);
    return {
      projectId: existingProjectId,
      projectName,
      projectStateDir: getConsciousProjectStateDir(consciousRootDir, existingProjectId),
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Conscious mode needs an interactive terminal the first time in a repository to choose a project identity.');
  }

  const registry = loadConsciousProjectRegistry(consciousRootDir);
  const existingProjects = registry.projects.slice().sort((a, b) => a.name.localeCompare(b.name));
  const defaultName = inferDefaultProjectName(cwd);

  console.log('\nNo conscious project identifier found for this repository.');
  printExistingConsciousProjects(existingProjects);
  if (existingProjects.length === 0) {
    const nameInput = await promptLine(`Project name [${defaultName}]: `);
    return createNewConsciousProject(consciousRootDir, cwd, repo, nameInput || defaultName);
  }

  console.log('\nChoose how to initialize conscious memory:');
  console.log('  1) Create new project');
  console.log('  2) Link to existing project');
  console.log('  3) Clone existing project into a new project');

  let mode = '';
  while (!['1', '2', '3'].includes(mode)) {
    mode = await promptLine('Selection [1-3]: ');
  }

  if (mode === '1') {
    const nameInput = await promptLine(`Project name [${defaultName}]: `);
    return createNewConsciousProject(consciousRootDir, cwd, repo, nameInput || defaultName);
  }

  if (mode === '2') {
    const selected = await chooseExistingProject(existingProjects, 'Existing project number: ');
    upsertConsciousProjectRegistryEntry(consciousRootDir, selected.id, selected.name, repo.repoId);
    writeConsciousProjectIdToGit(cwd, selected.id);
    return {
      projectId: selected.id,
      projectName: selected.name,
      projectStateDir: getConsciousProjectStateDir(consciousRootDir, selected.id),
    };
  }

  const source = await chooseExistingProject(existingProjects, 'Project number to clone: ');
  const nameInput = await promptLine(`New project name [${defaultName}]: `);
  const projectName = nameInput || `${defaultName}-fork`;
  const projectId = generateConsciousProjectId();
  cloneConsciousProjectState(consciousRootDir, source.id, projectId);
  upsertConsciousProjectRegistryEntry(consciousRootDir, projectId, projectName, repo.repoId);
  writeConsciousProjectIdToGit(cwd, projectId);
  return {
    projectId,
    projectName,
    projectStateDir: getConsciousProjectStateDir(consciousRootDir, projectId),
  };
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

function formatRetrievalMarkdown(
  hits: ArchiveSearchHit[],
  taxonomy: { paths: { fullPath: string }[]; labels: { label: string; count: number }[] },
): string {
  const lines: string[] = ['# Relevant prior findings', ''];
  if (hits.length === 0) {
    lines.push('No prior findings matched this launch context.');
  } else {
    hits.forEach((hit, index) => {
      lines.push(`${index + 1}. ${hit.summary}`);
      lines.push(`   - id: ${hit.id}`);
      lines.push(`   - path: ${hit.path}`);
      lines.push(`   - confidence: ${hit.confidence.toFixed(2)} | score: ${hit.score.toFixed(2)}`);
      if (hit.labels.length > 0) {
        lines.push(`   - labels: ${hit.labels.join(', ')}`);
      }
      lines.push(`   - problem: ${hit.problem}`);
      lines.push(`   - solution: ${hit.solution}`);
    });
  }

  lines.push('');
  lines.push('# Memory taxonomy');
  lines.push('');
  lines.push('Session bootstrap: call `archive_bootstrap` (or `archive_overview`) before other archive tools so path/label choices match current taxonomy.');
  lines.push('Storage is already project-local for this repo. Do not create project-name wrapper folders like `engineering/<project-name>`.');
  lines.push('`archive_search` returns fast index previews; call `archive_get` for full stored details of a hit.');
  lines.push('Use `archive_versions` to inspect revision history and `archive_get` with `revision_id` to load older versions.');
  lines.push('During substantive work, periodically reflect on whether a reusable insight is worth persisting with `archive_write` or `archive_update`; skip transient one-off details.');
  lines.push('Use existing `path_id` values whenever possible; only create new paths when no existing one fits.');
  lines.push('');
  lines.push('Known paths:');
  taxonomy.paths
    .slice()
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath))
    .forEach((entry) => lines.push(`- ${entry.fullPath}`));
  lines.push('');
  lines.push('Top labels:');
  if (taxonomy.labels.length === 0) {
    lines.push('- (none)');
  } else {
    taxonomy.labels.slice(0, 12).forEach((entry) => lines.push(`- ${entry.label} (${entry.count})`));
  }
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

function getConsciousTcpServerPath(): string {
  const distPath = path.resolve(__dirname, 'conscious-mcp-tcp-server.js');
  if (existsSync(distPath)) {
    return distPath;
  }
  throw new Error(`Conscious mode requires ${distPath}. Build devcon first (npm run build).`);
}

function getConsciousTcpClientPath(): string {
  const distPath = path.resolve(__dirname, 'conscious-mcp-tcp-client.js');
  if (existsSync(distPath)) {
    return distPath;
  }
  throw new Error(`Conscious mode requires ${distPath}. Build devcon first (npm run build).`);
}

function buildStableSuffix(input: string, length = 12): string {
  return createHash('sha1').update(input).digest('hex').slice(0, length);
}

function getConsciousSidecarImage(): string {
  return process.env.DEVCON_CONSCIOUS_SIDECAR_IMAGE || DEFAULT_IMAGE_TAG;
}

function ensureDockerNetwork(name: string): void {
  const inspect = spawnSync('docker', ['network', 'inspect', name], { stdio: 'ignore' });
  if (inspect.status === 0) {
    return;
  }
  const create = spawnSync('docker', ['network', 'create', name], { stdio: 'ignore' });
  if (create.status !== 0) {
    throw new Error(`Failed to create Docker network "${name}" for conscious sidecar.`);
  }
}

function isContainerRunning(name: string): boolean {
  const ps = spawnSync('docker', ['ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0) {
    return false;
  }
  return ps.stdout.split('\n').some((line) => line.trim() === name);
}

function doesContainerExist(name: string): boolean {
  const ps = spawnSync('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0) {
    return false;
  }
  return ps.stdout.split('\n').some((line) => line.trim() === name);
}

function getConsciousWarmupFrames(): string[] {
  return [
    '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  ];
}

function buildConsciousWarmupCommand(serverArgs: string, connectTimeoutMs: number): string {
  const lines = getConsciousWarmupFrames().map((line) => `'${line}'`).join(' ');
  const timeout = Math.max(1_000, connectTimeoutMs);
  return `printf '%s\\n' ${lines} | DEVCON_CONSCIOUS_TCP_CONNECT_TIMEOUT_MS=${timeout} ${serverArgs} >/dev/null 2>&1`;
}

function probeConsciousSidecar(runtime: ConsciousRuntime, timeoutMs: number): { ok: boolean; reason?: string } {
  const script = [
    "const net=require('net');",
    "const port=Number(process.argv[1]);",
    "const timeout=Number(process.argv[2]);",
    "let buffer='';",
    "const req=JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18'}})+'\\n';",
    "const hasInit=()=>buffer.includes('\"id\":0')&&buffer.includes('\"result\"');",
    "const fail=(code,msg)=>{if(msg){process.stderr.write(String(msg)+'\\n');}process.exit(code);};",
    "const socket=net.createConnection({host:'127.0.0.1',port});",
    "socket.setTimeout(timeout);",
    "socket.on('connect',()=>socket.write(req));",
    "socket.on('data',(chunk)=>{buffer+=chunk.toString('utf8');if(hasInit()){process.exit(0);}});",
    "socket.on('timeout',()=>{socket.destroy();fail(2,'timeout waiting for initialize response');});",
    "socket.on('error',(error)=>fail(3,error.message));",
    "socket.on('close',()=>{if(hasInit()){process.exit(0);}fail(4,'closed before initialize response');});",
  ].join('');

  const timeout = Math.max(1_000, timeoutMs);
  const probe = spawnSync(
    'docker',
    [
      'exec',
      runtime.sidecarContainerName,
      'node',
      '-e',
      script,
      String(runtime.sidecarPort),
      String(timeout),
    ],
    {
      encoding: 'utf8',
      timeout: timeout + 2_000,
    },
  );

  if (probe.status === 0) {
    return { ok: true };
  }

  if (probe.error) {
    return { ok: false, reason: probe.error.message };
  }

  const stderr = probe.stderr?.trim();
  const stdout = probe.stdout?.trim();
  const reason = stderr || stdout || `exit status ${probe.status ?? 'unknown'}`;
  return { ok: false, reason };
}

function ensureConsciousSidecar(runtime: ConsciousRuntime, image: string, dryRun: boolean): void {
  if (dryRun) {
    return;
  }

  const readyTimeoutMs = CONSCIOUS_SIDECAR_READY_TIMEOUT_MS;
  ensureDockerNetwork(runtime.sidecarNetworkName);
  if (isContainerRunning(runtime.sidecarContainerName)) {
    const ready = probeConsciousSidecar(runtime, readyTimeoutMs);
    if (ready.ok) {
      return;
    }
    console.warn(`Conscious sidecar ${runtime.sidecarContainerName} was running but not ready (${ready.reason ?? 'unknown reason'}). Restarting...`);
    spawnSync('docker', ['rm', '-f', runtime.sidecarContainerName], { stdio: 'ignore' });
  }

  if (doesContainerExist(runtime.sidecarContainerName)) {
    spawnSync('docker', ['rm', '-f', runtime.sidecarContainerName], { stdio: 'ignore' });
  }

  const sidecarDebugLog = path.join(CONSCIOUS_SIDECAR_STATE_DIR, 'sessions', 'sidecar.log');
  const hostConsciousDistDir = path.dirname(runtime.hostServerScriptPath);
  const runArgs = [
    'run',
    '-d',
    '--name',
    runtime.sidecarContainerName,
    '--network',
    runtime.sidecarNetworkName,
    '--network-alias',
    runtime.sidecarHost,
    '--mount',
    `type=bind,source=${runtime.stateDir},target=${CONSCIOUS_SIDECAR_STATE_DIR}`,
    '--mount',
    `type=bind,source=${hostConsciousDistDir},target=/opt/devcon,readonly`,
  ];
  if (CONSCIOUS_MEMORY_POLICY && CONSCIOUS_MEMORY_POLICY.trim().length > 0) {
    runArgs.push('-e', `DEVCON_CONSCIOUS_MEMORY_POLICY=${CONSCIOUS_MEMORY_POLICY}`);
  }
  if (CONSCIOUS_MEMORY_POLICY_THRESHOLD && CONSCIOUS_MEMORY_POLICY_THRESHOLD.trim().length > 0) {
    runArgs.push('-e', `DEVCON_CONSCIOUS_MEMORY_POLICY_THRESHOLD=${CONSCIOUS_MEMORY_POLICY_THRESHOLD}`);
  }
  runArgs.push(
    image,
    'node',
    CONSCIOUS_SIDECAR_SERVER_SCRIPT,
    '--state-dir',
    CONSCIOUS_SIDECAR_STATE_DIR,
    '--server-script',
    CONSCIOUS_SIDECAR_MCP_SERVER_SCRIPT,
    '--port',
    String(runtime.sidecarPort),
    '--debug-log',
    sidecarDebugLog,
    '--repo',
    runtime.repo.repoId,
    '--project-id',
    runtime.projectId,
    '--project-name',
    runtime.projectName,
    '--seed-query',
    runtime.seedQuery,
  );

  const startSidecar = (): void => {
    const run = spawnSync('docker', runArgs, { encoding: 'utf8' });
    if (run.status !== 0) {
      throw new Error(`Failed to start conscious sidecar ${runtime.sidecarContainerName}: ${run.stderr || run.stdout || 'unknown docker error'}`);
    }
  };

  startSidecar();
  let ready = probeConsciousSidecar(runtime, readyTimeoutMs);
  if (ready.ok) {
    return;
  }

  spawnSync('docker', ['rm', '-f', runtime.sidecarContainerName], { stdio: 'ignore' });
  startSidecar();
  ready = probeConsciousSidecar(runtime, readyTimeoutMs);
  if (!ready.ok) {
    throw new Error(`Conscious sidecar ${runtime.sidecarContainerName} started but did not answer MCP initialize (${ready.reason ?? 'unknown reason'}).`);
  }
}

async function prepareConsciousRuntime(
  cwd: string,
  toolArgs: string[],
  explicitStatePath: string | undefined,
): Promise<ConsciousRuntime> {
  const consciousRootDir = getConsciousStateDir(explicitStatePath, os.homedir());
  const repo = getGitRepoContext(cwd);
  const project = await resolveConsciousProject(cwd, repo, consciousRootDir);
  const paths = bootstrapConsciousPaths(project.projectStateDir);
  const archive = new ConsciousArchiveStore(paths.dbPath);
  archive.ensureInitialized();

  const seedQuery = deriveConsciousQuery(toolArgs, cwd);
  const retrievalHits = archive.search({
    query: seedQuery,
    repo: repo.repoId,
    topK: 5,
    minConfidence: 0.35,
  });
  const overview = archive.getOverviewSnapshot();

  const sessionId = generateSessionId();
  const retrievalHostPath = path.join(paths.sessionsDir, `${sessionId}.retrieval.md`);
  writeFileSync(retrievalHostPath, formatRetrievalMarkdown(retrievalHits, overview), 'utf8');
  const mcpLogHostPath = path.join(paths.sessionsDir, 'sidecar.log');
  const sidecarIdentity = buildStableSuffix(`${CONSCIOUS_SIDECAR_REV}::${consciousRootDir}::${project.projectId}`);
  const sidecarContainerName = `devcon-conscious-${sidecarIdentity}`;
  const sidecarHost = `devcon-conscious-${sidecarIdentity}`;

  const metadataPath = path.join(paths.sessionsDir, `${sessionId}.json`);
  const metadata = {
    sessionId,
    createdAt: new Date().toISOString(),
    seedQuery,
    retrievalCount: retrievalHits.length,
    projectId: project.projectId,
    projectName: project.projectName,
    repo: repo.repoId,
    branch: repo.branch,
    commitSha: repo.commitSha,
    cleanAtStart: repo.cleanAtStart,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  return {
    projectId: project.projectId,
    projectName: project.projectName,
    sessionId,
    stateDir: paths.rootDir,
    dbPath: paths.dbPath,
    sessionsDir: paths.sessionsDir,
    repo,
    hostServerScriptPath: getConsciousServerScriptPath(),
    hostArchiveModulePath: getConsciousArchiveModulePath(),
    hostTcpServerScriptPath: getConsciousTcpServerPath(),
    hostTcpClientScriptPath: getConsciousTcpClientPath(),
    containerTcpClientPath: CONSCIOUS_CONTAINER_MCP_CLIENT,
    retrievalHostPath,
    mcpLogHostPath,
    sidecarContainerName,
    sidecarNetworkName: CONSCIOUS_SIDECAR_NETWORK,
    sidecarHost,
    sidecarPort: CONSCIOUS_SIDECAR_PORT,
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
    pathId: 'path_debugging',
    summary,
    problem,
    solution,
    evidence,
    labels: [...tags, 'auto-capture'],
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

function resolveDefaultWorkspaceTarget(cwd: string): string {
  const normalizedCwd = path.resolve(cwd);
  const workspaceDirname = path.basename(normalizedCwd);
  if (!workspaceDirname || workspaceDirname === '.' || workspaceDirname === path.sep) {
    return path.posix.join(WORKSPACE_ROOT, DEFAULT_WORKSPACE_DIRNAME);
  }
  return path.posix.join(WORKSPACE_ROOT, workspaceDirname);
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

function dedupeSensitivePaths(paths: SensitivePath[]): SensitivePath[] {
  const unique = new Map<string, SensitivePath>();
  for (const entry of paths) {
    if (!unique.has(entry.containerPath)) {
      unique.set(entry.containerPath, entry);
    }
  }
  return [...unique.values()];
}

function resolveExtraMountContainerPaths(extraMounts: ExtraMount[], workspaceTarget: string): Array<{
  hostPath: string;
  containerPath: string;
}> {
  const seenTargets = new Set<string>([workspaceTarget]);
  const resolved: Array<{ hostPath: string; containerPath: string }> = [];

  for (const extra of extraMounts) {
    const containerPath = path.posix.join(WORKSPACE_ROOT, extra.mountName);
    if (seenTargets.has(containerPath)) {
      throw new Error(`Mount target collision at ${containerPath}. Choose a mount directory with a unique name.`);
    }
    seenTargets.add(containerPath);
    resolved.push({ hostPath: extra.hostPath, containerPath });
  }

  return resolved;
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

interface ConsciousProjectStats {
  dbExists: boolean;
  findingCount: number;
  pathCount: number;
  usageCount: number;
  sessionCount: number;
}

interface ConsciousProjectSelector {
  projectRef?: string;
  useCurrent: boolean;
  yes: boolean;
}

type PathTreeNode = {
  fullPath: string;
  children: PathTreeNode[];
};

function parseConsciousProjectSelector(args: string[]): ConsciousProjectSelector {
  let projectRef: string | undefined;
  let positionalProjectRef: string | undefined;
  let useCurrent = false;
  let yes = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--current') {
      useCurrent = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectRef = arg.slice('--project='.length);
      continue;
    }
    if (arg.startsWith('--project-id=')) {
      projectRef = arg.slice('--project-id='.length);
      continue;
    }
    if (arg.startsWith('--project-name=')) {
      projectRef = arg.slice('--project-name='.length);
      continue;
    }
    if (arg === '--project' || arg === '--project-id') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a project name or identifier value.`);
      }
      projectRef = next;
      i += 1;
      continue;
    }
    if (arg === '--project-name') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a project name value.`);
      }
      projectRef = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag "${arg}" for conscious management command.`);
    }
    if (positionalProjectRef) {
      throw new Error('Only one project reference may be provided.');
    }
    positionalProjectRef = arg;
  }

  if (!projectRef && positionalProjectRef) {
    projectRef = positionalProjectRef;
  }

  if (projectRef && useCurrent) {
    throw new Error('Use either --current or --project, not both.');
  }

  return {
    projectRef: projectRef?.trim() || undefined,
    useCurrent,
    yes,
  };
}

function resolveConsciousProjectReference(
  registry: ConsciousProjectRegistry,
  reference: string,
): ConsciousProjectRegistryEntry | undefined {
  const ref = reference.trim();
  if (!ref) {
    return undefined;
  }

  const directId = registry.projects.find((entry) => entry.id === ref);
  if (directId) {
    return directId;
  }

  const exactName = registry.projects.filter((entry) => entry.name === ref);
  if (exactName.length === 1) {
    return exactName[0];
  }
  if (exactName.length > 1) {
    throw new Error(`Project name "${ref}" is ambiguous. Use an explicit project id.`);
  }

  const lower = ref.toLowerCase();
  const caseInsensitiveName = registry.projects.filter((entry) => entry.name.toLowerCase() === lower);
  if (caseInsensitiveName.length === 1) {
    return caseInsensitiveName[0];
  }
  if (caseInsensitiveName.length > 1) {
    throw new Error(`Project name "${ref}" is ambiguous. Use an explicit project id.`);
  }

  const idPrefix = registry.projects.filter((entry) => entry.id.startsWith(ref));
  if (idPrefix.length === 1) {
    return idPrefix[0];
  }
  if (idPrefix.length > 1) {
    throw new Error(`Project id prefix "${ref}" is ambiguous. Use a longer id or full project name.`);
  }

  return undefined;
}

function readConsciousProjectStats(projectStateDir: string): ConsciousProjectStats {
  const paths = resolveConsciousPaths(projectStateDir);
  let findingCount = 0;
  let pathCount = 0;
  let usageCount = 0;
  let sessionCount = 0;
  const dbExists = existsSync(paths.dbPath);

  if (dbExists) {
    try {
      const raw = JSON.parse(readFileSync(paths.dbPath, 'utf8')) as {
        records?: unknown;
        paths?: unknown;
        usage?: unknown;
      };
      findingCount = Array.isArray(raw.records) ? raw.records.length : 0;
      pathCount = Array.isArray(raw.paths) ? raw.paths.length : 0;
      usageCount = Array.isArray(raw.usage) ? raw.usage.length : 0;
    } catch {
      // Ignore malformed db for listing output.
    }
  }

  if (existsSync(paths.sessionsDir)) {
    try {
      sessionCount = readdirSync(paths.sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .length;
    } catch {
      // Ignore unreadable sessions directory.
    }
  }

  return {
    dbExists,
    findingCount,
    pathCount,
    usageCount,
    sessionCount,
  };
}

function printConsciousPathTree(nodes: PathTreeNode[], indent = ''): void {
  const sorted = [...nodes].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  for (const node of sorted) {
    console.log(`${indent}- ${node.fullPath}`);
    if (node.children.length > 0) {
      printConsciousPathTree(node.children, `${indent}  `);
    }
  }
}

function stopConsciousSidecarForProject(consciousRootDir: string, projectId: string): boolean {
  const identities = [
    buildStableSuffix(`${CONSCIOUS_SIDECAR_REV}::${consciousRootDir}::${projectId}`),
    buildStableSuffix(`${consciousRootDir}::${projectId}`), // legacy sidecar naming
  ];
  let stopped = false;
  for (const identity of identities) {
    const sidecarContainerName = `devcon-conscious-${identity}`;
    if (!doesContainerExist(sidecarContainerName)) {
      continue;
    }
    spawnSync('docker', ['rm', '-f', sidecarContainerName], { stdio: 'ignore' });
    stopped = true;
  }
  return stopped;
}

function stopAllConsciousSidecars(): number {
  const list = spawnSync(
    'docker',
    ['ps', '-a', '--filter', 'name=^/devcon-conscious-', '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (list.status !== 0) {
    return 0;
  }
  const names = list.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const name of names) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
  return names.length;
}

async function confirmConsciousDestructiveAction(message: string, yes: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${message} Refusing to continue without --yes in non-interactive mode.`);
  }
  return promptYesNo(`${message} Continue? [y/N] `);
}

function printConsciousProjectList(cwd: string, consciousRootDir: string): void {
  const registry = loadConsciousProjectRegistry(consciousRootDir);
  const currentProjectId = readConsciousProjectIdFromGit(cwd);

  console.log(`Conscious root: ${consciousRootDir}`);
  if (currentProjectId) {
    console.log(`Current repository project id: ${currentProjectId}`);
  } else {
    console.log('Current repository project id: (not set)');
  }

  if (registry.projects.length === 0) {
    console.log('\nRegistered projects: (none)');
    return;
  }

  console.log('\nRegistered projects:');
  const sorted = registry.projects.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const stateDir = getConsciousProjectStateDir(consciousRootDir, entry.id);
    const stats = readConsciousProjectStats(stateDir);
    const marker = entry.id === currentProjectId ? '*' : ' ';
    console.log(`${marker} ${entry.name} [${entry.id}]`);
    console.log(`    state=${stateDir}`);
    console.log(`    findings=${stats.findingCount} paths=${stats.pathCount} usage=${stats.usageCount} session_files=${stats.sessionCount}`);
    if (entry.linkedRepos.length > 0) {
      console.log(`    repos=${entry.linkedRepos.join(', ')}`);
    }
  }
}

function resolveProjectForInspection(
  cwd: string,
  consciousRootDir: string,
  selector: ConsciousProjectSelector,
): { projectId: string; projectName: string; stateDir: string } {
  const registry = loadConsciousProjectRegistry(consciousRootDir);
  const currentProjectId = readConsciousProjectIdFromGit(cwd);

  if (selector.projectRef) {
    const matched = resolveConsciousProjectReference(registry, selector.projectRef);
    if (matched) {
      return {
        projectId: matched.id,
        projectName: matched.name,
        stateDir: getConsciousProjectStateDir(consciousRootDir, matched.id),
      };
    }
    const fallbackStateDir = getConsciousProjectStateDir(consciousRootDir, selector.projectRef);
    if (existsSync(fallbackStateDir)) {
      return {
        projectId: selector.projectRef,
        projectName: selector.projectRef,
        stateDir: fallbackStateDir,
      };
    }
    throw new Error(`Unknown project "${selector.projectRef}". Run "devcon conscious list" to see valid project names/ids.`);
  }

  let projectId = selector.useCurrent ? currentProjectId : undefined;
  if (!projectId && currentProjectId) {
    projectId = currentProjectId;
  }
  if (!projectId && registry.projects.length === 1) {
    projectId = registry.projects[0].id;
  }
  if (!projectId) {
    throw new Error('Unable to resolve target project. Use --project <name-or-id> or --current.');
  }

  const known = resolveConsciousProjectReference(registry, projectId);
  return {
    projectId,
    projectName: known?.name ?? projectId,
    stateDir: getConsciousProjectStateDir(consciousRootDir, projectId),
  };
}

function resolveProjectForWipe(
  cwd: string,
  consciousRootDir: string,
  selector: ConsciousProjectSelector,
): { projectId: string; projectName: string; stateDir: string } {
  const registry = loadConsciousProjectRegistry(consciousRootDir);
  const currentProjectId = readConsciousProjectIdFromGit(cwd);

  if (selector.projectRef) {
    const matched = resolveConsciousProjectReference(registry, selector.projectRef);
    if (matched) {
      return {
        projectId: matched.id,
        projectName: matched.name,
        stateDir: getConsciousProjectStateDir(consciousRootDir, matched.id),
      };
    }
    throw new Error(`Unknown project "${selector.projectRef}". Run "devcon conscious list" to see valid project names/ids.`);
  }

  let projectId: string | undefined;
  if (!projectId) {
    projectId = currentProjectId;
  }
  if (!projectId) {
    throw new Error('No current project identifier found. Use --project <name-or-id>.');
  }

  const known = resolveConsciousProjectReference(registry, projectId);
  return {
    projectId,
    projectName: known?.name ?? projectId,
    stateDir: getConsciousProjectStateDir(consciousRootDir, projectId),
  };
}

function printConsciousProjectStructure(
  cwd: string,
  consciousRootDir: string,
  selector: ConsciousProjectSelector,
): void {
  const target = resolveProjectForInspection(cwd, consciousRootDir, selector);
  const stats = readConsciousProjectStats(target.stateDir);
  const paths = resolveConsciousPaths(target.stateDir);

  console.log(`Project: ${target.projectName} [${target.projectId}]`);
  console.log(`State directory: ${target.stateDir}`);
  console.log(`Archive DB: ${paths.dbPath} (${stats.dbExists ? 'present' : 'missing'})`);
  console.log(`Sessions directory: ${paths.sessionsDir} (${existsSync(paths.sessionsDir) ? 'present' : 'missing'})`);
  console.log(`Counts: findings=${stats.findingCount}, paths=${stats.pathCount}, usage=${stats.usageCount}, session_files=${stats.sessionCount}`);

  if (!stats.dbExists) {
    console.log('\nNo archive database found for this project yet.');
    return;
  }

  const store = new ConsciousArchiveStore(paths.dbPath);
  store.ensureInitialized();
  const overview = store.getOverviewSnapshot();

  console.log('\nTaxonomy paths:');
  printConsciousPathTree(overview.pathTree as PathTreeNode[]);

  console.log('\nTop labels:');
  if (overview.labels.length === 0) {
    console.log('- (none)');
  } else {
    for (const entry of overview.labels.slice(0, 20)) {
      console.log(`- ${entry.label} (${entry.count})`);
    }
  }
}

async function wipeConsciousProject(
  cwd: string,
  consciousRootDir: string,
  selector: ConsciousProjectSelector,
): Promise<void> {
  const target = resolveProjectForWipe(cwd, consciousRootDir, selector);
  const confirmed = await confirmConsciousDestructiveAction(
    `This will wipe all conscious memory for project ${target.projectName} [${target.projectId}] at ${target.stateDir}.`,
    selector.yes,
  );
  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  const sidecarStopped = stopConsciousSidecarForProject(consciousRootDir, target.projectId);
  rmSync(target.stateDir, { recursive: true, force: true });
  console.log(`Wiped project memory: ${target.projectName} [${target.projectId}]`);
  if (sidecarStopped) {
    console.log('Stopped related conscious sidecar container.');
  }
}

async function wipeConsciousAll(consciousRootDir: string, yes: boolean): Promise<void> {
  const confirmed = await confirmConsciousDestructiveAction(
    `This will wipe all conscious memory under ${consciousRootDir}.`,
    yes,
  );
  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  const stopped = stopAllConsciousSidecars();
  rmSync(consciousRootDir, { recursive: true, force: true });
  console.log(`Wiped all conscious memory under ${consciousRootDir}`);
  if (stopped > 0) {
    console.log(`Stopped ${stopped} conscious sidecar container(s).`);
  }
}

async function handleConsciousCommand(
  args: string[],
  cwd: string,
  explicitStatePath: string | undefined,
): Promise<void> {
  const knownSubcommands = new Set(['list', 'inspect', 'tree', 'wipe-project', 'wipe', 'wipe-all']);
  const subcommandIndex = args.findIndex((arg) => knownSubcommands.has(arg));
  const subcommand = subcommandIndex >= 0 ? args[subcommandIndex] : 'list';
  const subArgs = subcommandIndex >= 0
    ? [...args.slice(0, subcommandIndex), ...args.slice(subcommandIndex + 1)]
    : args;
  const consciousRootDir = getConsciousStateDir(explicitStatePath, os.homedir());

  if (subcommand === 'list') {
    if (subArgs.length > 0) {
      throw new Error(`Unknown arguments for "conscious list": ${subArgs.join(' ')}`);
    }
    printConsciousProjectList(cwd, consciousRootDir);
    return;
  }

  if (subcommand === 'inspect' || subcommand === 'tree') {
    const selector = parseConsciousProjectSelector(subArgs);
    printConsciousProjectStructure(cwd, consciousRootDir, selector);
    return;
  }

  if (subcommand === 'wipe-project' || subcommand === 'wipe') {
    const selector = parseConsciousProjectSelector(subArgs);
    await wipeConsciousProject(cwd, consciousRootDir, selector);
    return;
  }

  if (subcommand === 'wipe-all') {
    const selector = parseConsciousProjectSelector(subArgs);
    if (selector.projectRef || selector.useCurrent) {
      throw new Error('wipe-all does not accept --project or --current. Use --yes to confirm non-interactively.');
    }
    await wipeConsciousAll(consciousRootDir, selector.yes);
    return;
  }

  throw new Error(`Unknown "conscious" subcommand "${subcommand}". Use list, inspect, tree, wipe-project, or wipe-all.`);
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

function ensureTmuxAvailable(): void {
  const check = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  if (check.status !== 0) {
    throw new Error('tmux is required for --web mode but was not found in PATH.');
  }
}

function resolveWebServerScriptPath(): string {
  const scriptPath = path.resolve(__dirname, '..', 'web', 'server.js');
  if (!existsSync(scriptPath)) {
    throw new Error(
      `Web mode server script not found at ${scriptPath}. Ensure the package includes the "web/" directory.`,
    );
  }
  return scriptPath;
}

function sanitizeWebSessionToken(raw: string): string {
  const normalized = raw.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'devcon';
}

function resolveWebSessionName(options: CliOptions): string {
  if (options.webSessionName && options.webSessionName.trim().length > 0) {
    const provided = options.webSessionName.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(provided)) {
      throw new Error('--web-session must contain only letters, numbers, "_" or "-".');
    }
    return provided;
  }
  const toolToken = sanitizeWebSessionToken(options.toolName ?? 'run');
  const suffix = randomBytes(3).toString('hex');
  return `devcon-${toolToken}-${suffix}`;
}

function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function createWebLauncherScript(
  launch: LaunchPlan,
  cwd: string,
): { scriptPath: string; dirPath: string } {
  const launcherDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-web-launch-'));
  const scriptPath = path.join(launcherDir, 'launch.sh');
  const cleanupTargets = [...launch.cleanupTargets, launcherDir];
  const cleanupLines = cleanupTargets.length > 0
    ? cleanupTargets.map((target) => `  rm -rf ${shellQuote(target)} >/dev/null 2>&1 || true`).join('\n')
    : '  :';
  const script = `#!/bin/bash
set +e
cleanup() {
${cleanupLines}
}
trap cleanup EXIT
cd ${shellQuote(cwd)} || exit 1
${buildShellCommand(launch.command, launch.args)}
status=$?
exit $status
`;
  writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  return { scriptPath, dirPath: launcherDir };
}

function tmuxSessionExists(sessionName: string): boolean {
  const check = spawnSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
  return check.status === 0;
}

function startWebTmuxSession(sessionName: string, cwd: string, scriptPath: string): void {
  if (tmuxSessionExists(sessionName)) {
    throw new Error(`tmux session "${sessionName}" already exists. Pick another name via --web-session.`);
  }
  const create = spawnSync(
    'tmux',
    ['new-session', '-d', '-s', sessionName, '-c', cwd, scriptPath],
    { stdio: 'inherit' },
  );
  if (create.status !== 0) {
    throw new Error(`Failed to create tmux session "${sessionName}" for web mode.`);
  }
}

function killTmuxSession(sessionName: string): void {
  if (!tmuxSessionExists(sessionName)) {
    return;
  }
  const kill = spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  if (kill.status !== 0) {
    console.warn(`Failed to kill tmux session "${sessionName}".`);
  }
}

function resolveWebHost(options: CliOptions): string {
  const host = options.webHost ?? process.env.HOST ?? WEB_DEFAULT_HOST;
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error('--web-host must not be empty.');
  }
  return trimmed;
}

function resolveWebPort(options: CliOptions): number {
  if (options.webPort) {
    return options.webPort;
  }
  return parsePositiveIntEnv(process.env.PORT, WEB_DEFAULT_PORT);
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function getLocalNetworkIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    if (!addresses) {
      continue;
    }
    for (const addr of addresses) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.add(addr.address);
      }
    }
  }
  return [...ips];
}

function resolveWebPassword(options: CliOptions): { password: string; generated: boolean } {
  const provided = options.webPassword ?? process.env.WEB_PASSWORD ?? process.env.AUTH_TOKEN;
  if (provided && provided.length > 0) {
    return { password: provided, generated: false };
  }
  return { password: randomBytes(9).toString('base64url'), generated: true };
}

async function launchWebModeSession(
  options: CliOptions,
  cwd: string,
  launch: LaunchPlan,
): Promise<void> {
  ensureTmuxAvailable();
  const sessionName = resolveWebSessionName(options);
  const host = resolveWebHost(options);
  const port = resolveWebPort(options);
  const passwordInfo = resolveWebPassword(options);

  if (options.dryRun) {
    console.log(`[dry-run] Web mode session: ${sessionName}`);
    console.log(`[dry-run] Docker command: ${buildShellCommand(launch.command, launch.args)}`);
    console.log(`[dry-run] Web server: HOST=${host} PORT=${port} TMUX_TARGET=${sessionName}`);
    if (passwordInfo.generated) {
      console.log('[dry-run] A one-time random web password would be generated at runtime.');
    }
    launch.cleanup();
    return;
  }

  const webServerScript = resolveWebServerScriptPath();
  let launcherScriptPath = '';
  let launcherDir = '';
  try {
    const launcher = createWebLauncherScript(launch, cwd);
    launcherScriptPath = launcher.scriptPath;
    launcherDir = launcher.dirPath;
    startWebTmuxSession(sessionName, cwd, launcherScriptPath);
  } catch (error) {
    launch.cleanup();
    if (launcherDir) {
      rmSync(launcherDir, { recursive: true, force: true });
    }
    throw error;
  }

  console.log(`Web mode enabled for tool "${options.toolName}".`);
  console.log(`tmux session: ${sessionName}`);
  if (passwordInfo.generated) {
    console.log(`Web password (generated): ${passwordInfo.password}`);
  } else {
    console.log('Web password: using provided WEB_PASSWORD/--web-password value.');
  }
  console.log(`Web terminal bind URL: http://${formatHostForUrl(host)}:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    const localIps = getLocalNetworkIpv4Addresses();
    if (localIps.length > 0) {
      console.log('Local network URLs:');
      for (const ip of localIps) {
        console.log(`  http://${ip}:${port}`);
      }
    } else {
      console.log('Local network URL: unable to detect a non-loopback IPv4 address.');
    }
  }
  console.log(`To stop this session later: tmux kill-session -t ${sessionName}`);

  const webEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: host,
    PORT: String(port),
    TMUX_TARGET: sessionName,
    WEB_PASSWORD: passwordInfo.password,
    AUTO_CREATE_SESSION: '0',
  };

  await new Promise<void>((resolve, reject) => {
    const webProcess = spawn(process.execPath, [webServerScript], {
      stdio: 'inherit',
      env: webEnv,
    });

    let interrupted = false;
    const terminate = (): void => {
      interrupted = true;
      webProcess.kill('SIGINT');
    };

    process.on('SIGINT', terminate);
    process.on('SIGTERM', terminate);

    const clearHandlers = (): void => {
      process.off('SIGINT', terminate);
      process.off('SIGTERM', terminate);
    };

    webProcess.on('error', (error) => {
      killTmuxSession(sessionName);
      clearHandlers();
      reject(error);
    });

    webProcess.on('exit', (code) => {
      killTmuxSession(sessionName);
      clearHandlers();
      if (interrupted) {
        resolve();
        return;
      }
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      reject(new Error(`Web server exited with code ${code}`));
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
  console.log('  devcon conscious <list|inspect|tree|wipe-project|wipe-all> [options]\n');
  console.log('Flags:');
  console.log('  --dry-run     Print the assembled launch plan without executing it');
  console.log('  --backend NAME Choose runtime backend: docker (default) or microvm');
  console.log('  --home        Share your host home directory with the container (Docker backend only)');
  console.log('  --no-home     Do not share your host home directory with the runtime');
  console.log('  --image=IMG   Override the docker image for this run (Docker backend only)');
  console.log('  --with-git    Unmask .git and inject a sandboxed git user inside the runtime');
  console.log('  --temp-git    Mask host .git but provide a temporary git repo/worktree inside the runtime');
  console.log('  --mount PATH  Add an extra host directory under /workspace/<folder-name> (repeatable)');
  console.log('  --export-patch[=PATH] Export changes from temp-git repo after run (defaults to .devcon/drafts/<ts>.patch)');
  console.log('  --network-host, -network-host Use host networking (Docker backend only)');
  console.log('  --ipv4, -ipv4 Force IPv4-only networking inside the runtime when supported');
  console.log('  --web         Run tool inside tmux and expose it through the built-in web terminal');
  console.log('  --web-host HOST Web server bind host (default: 0.0.0.0)');
  console.log('  --web-port PORT Web server port (default: 7682)');
  console.log('  --web-password PASS Password for web terminal login (auto-generated if omitted)');
  console.log('  --web-session NAME tmux session name to use for --web (default: auto-generated)');
  console.log('  --conscious, -conscious Enable persistent archive memory via sidecar and auto-mount MCP tools');
  console.log('  --conscious-path PATH Override where conscious state is stored (default: ~/.config/devcon/conscious)');
  console.log('  --help        Show this message');
  console.log('\nCommands:');
  console.log('  update        Refresh Docker images for one or more tools (pull base, rerun npm install)');
  console.log('  rebuild       Fully rebuild Docker images for one or more tools (no cache)');
  console.log('  sensitive     List/add/remove sensitive-path patterns that get masked in containers');
  console.log('  skip-scan     List/add/remove directory names skipped during sensitive-pattern scanning');
  console.log('  conscious     Inspect or wipe conscious memory storage (project or global scope)');
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
  extraMounts: ExtraMount[];
  shareHome: boolean;
  image: string;
  allowGit: boolean;
  tempGit: boolean;
  forceIpv4: boolean;
  networkHost: boolean;
  conscious?: ConsciousRuntime;
}): LaunchPlan {
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

  const workspaceTarget = options.tool.workdir ?? resolveDefaultWorkspaceTarget(options.cwd);
  const resolvedExtraMounts = resolveExtraMountContainerPaths(options.extraMounts, workspaceTarget);
  dockerArgs.push('--mount', `type=bind,source=${options.cwd},target=${workspaceTarget}`);
  dockerArgs.push('-w', workspaceTarget);
  dockerArgs.push('-e', `DEVCON_WORKSPACE=${workspaceTarget}`);
  dockerArgs.push('-e', `DEVCON_TOOL=${options.toolName}`);

  for (const extra of resolvedExtraMounts) {
    dockerArgs.push('--mount', `type=bind,source=${extra.hostPath},target=${extra.containerPath}`);
    console.log(`Additional mount enabled: ${extra.hostPath} -> ${extra.containerPath}`);
  }

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

  const scanTargets = [
    {
      label: 'workspace',
      hostPath: options.cwd,
      containerPath: workspaceTarget,
    },
    ...resolvedExtraMounts.map((extra, index) => ({
      label: `mount ${index + 1}`,
      hostPath: extra.hostPath,
      containerPath: extra.containerPath,
    })),
  ];
  let sensitivePaths: SensitivePath[] = [];
  for (const target of scanTargets) {
    const scanStart = Date.now();
    console.log(`Scanning ${target.label} for sensitive paths...`);
    const discovered = discoverSensitivePaths(target.hostPath, target.containerPath, { allowGit: options.allowGit });
    console.log(`Found ${discovered.length} sensitive path(s) to mask in ${target.label} (in ${Date.now() - scanStart}ms)`);
    sensitivePaths = sensitivePaths.concat(discovered);
  }
  sensitivePaths = dedupeSensitivePaths(sensitivePaths);
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
    if (options.networkHost) {
      throw new Error('Conscious sidecar mode does not support --network-host. Disable --network-host for conscious runs.');
    }
    dockerArgs.push('--network', options.conscious.sidecarNetworkName);
    dockerArgs.push('--mount', `type=bind,source=${options.conscious.hostTcpClientScriptPath},target=${options.conscious.containerTcpClientPath},readonly`);
    dockerArgs.push('-e', 'DEVCON_CONSCIOUS=1');
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_REPO=${options.conscious.repo.repoId}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_PROJECT_ID=${options.conscious.projectId}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_PROJECT_NAME=${options.conscious.projectName}`);
    dockerArgs.push('-e', `DEVCON_CONSCIOUS_SESSION_ID=${options.conscious.sessionId}`);

    const serverArgs = [
      'node',
      options.conscious.containerTcpClientPath,
      '--host',
      options.conscious.sidecarHost,
      '--port',
      String(options.conscious.sidecarPort),
    ].map(shellQuote).join(' ');
    const warmupCommand = buildConsciousWarmupCommand(serverArgs, CONSCIOUS_SIDECAR_READY_TIMEOUT_MS);
    const warmupGuard = `if ! ${warmupCommand}; then echo "devcon conscious: MCP sidecar warmup failed for ${CONSCIOUS_MCP_NAME}." >&2; exit 86; fi`;

    if (options.toolName === 'codex') {
      initScriptLines.push(
        `if command -v codex >/dev/null 2>&1; then`,
        `  codex mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
        `  codex mcp add ${CONSCIOUS_MCP_NAME} -- ${serverArgs} >/dev/null 2>&1 || true`,
        `  ${warmupGuard}`,
        'fi',
      );
      postRunCleanupLines.push(`codex mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`);
    } else if (options.toolName === 'claude') {
      initScriptLines.push(
        'if command -v claude >/dev/null 2>&1; then',
        `  claude mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
        `  claude mcp add --transport stdio ${CONSCIOUS_MCP_NAME} -- ${serverArgs} >/dev/null 2>&1 || true`,
        `  ${warmupGuard}`,
        'fi',
      );
      postRunCleanupLines.push(`claude mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`);
    }
  } else if (options.toolName === 'codex') {
    initScriptLines.push(
      'if command -v codex >/dev/null 2>&1; then',
      `  codex mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
      'fi',
    );
  } else if (options.toolName === 'claude') {
    initScriptLines.push(
      'if command -v claude >/dev/null 2>&1; then',
      `  claude mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
      'fi',
    );
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

  return {
    command: 'docker',
    args: dockerArgs,
    cleanup,
    cleanupTargets: [...cleanupTargets],
    tempGitDir,
  };
}

function getMicrovmPaths(profile: MicrovmProfile): {
  rootDir: string;
  imagesDir: string;
  runsDir: string;
  sshDir: string;
  pristineImagePath: string;
  preparedImagePath: string;
  privateKeyPath: string;
  publicKeyPath: string;
} {
  const imagesDir = path.join(MICROVM_ROOT_PATH, 'images');
  const runsDir = path.join(MICROVM_ROOT_PATH, 'runs');
  const sshDir = path.join(MICROVM_ROOT_PATH, 'ssh');
  return {
    rootDir: MICROVM_ROOT_PATH,
    imagesDir,
    runsDir,
    sshDir,
    pristineImagePath: path.join(imagesDir, profile.pristineImageName),
    preparedImagePath: path.join(imagesDir, profile.preparedImageName),
    privateKeyPath: path.join(sshDir, 'id_ed25519'),
    publicKeyPath: path.join(sshDir, 'id_ed25519.pub'),
  };
}

function ensureDir(target: string): void {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }
}

function commandExists(command: string, args: string[] = ['--version']): boolean {
  const direct = spawnSync(command, args, { stdio: 'ignore' });
  if (!direct.error && direct.status === 0) {
    return true;
  }

  const lookup = spawnSync('/bin/sh', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return !lookup.error && lookup.status === 0;
}

function renderAptInstallCommand(packages: string[]): string {
  return `sudo apt-get update && sudo apt-get install -y ${packages.join(' ')}`;
}

function renderBrewInstallCommand(packages: string[]): string {
  return `brew install ${packages.join(' ')}`;
}

async function installViaApt(packages: string[], dryRun: boolean): Promise<void> {
  if (packages.length === 0) {
    return;
  }
  const installCommand = renderAptInstallCommand(packages);
  if (dryRun) {
    console.log(`[dry-run] Missing microVM host dependencies. Would run: ${installCommand}`);
    return;
  }

  if (!commandExists('apt-get')) {
    throw new Error(`Missing microVM host dependencies (${packages.join(', ')}). Install them with: ${installCommand}`);
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const command = isRoot ? 'apt-get' : 'sudo';
  const updateArgs = isRoot ? ['update'] : ['apt-get', 'update'];
  const installArgs = isRoot ? ['install', '-y', ...packages] : ['apt-get', 'install', '-y', ...packages];

  if (!isRoot) {
    if (!commandExists('sudo', ['--version'])) {
      throw new Error(`Missing microVM host dependencies (${packages.join(', ')}). Install them with: ${installCommand}`);
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Missing microVM host dependencies (${packages.join(', ')}). Install them with: ${installCommand}`);
    }
    const confirmed = await promptYesNo('Install required microVM host packages now? [y/N] ');
    if (!confirmed) {
      throw new Error(`Install the missing microVM host packages and retry: ${installCommand}`);
    }
  } else {
    console.log(`Installing required microVM host packages: ${packages.join(', ')}`);
  }

  await runCommand(command, updateArgs);
  await runCommand(command, installArgs);
}

async function installViaBrew(packages: string[], dryRun: boolean): Promise<void> {
  if (packages.length === 0) {
    return;
  }
  const installCommand = renderBrewInstallCommand(packages);
  if (dryRun) {
    console.log(`[dry-run] Missing microVM host dependencies. Would run: ${installCommand}`);
    return;
  }
  if (!commandExists('brew', ['--version'])) {
    throw new Error(`Missing microVM host dependencies (${packages.join(', ')}). Install them with: ${installCommand}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Missing microVM host dependencies (${packages.join(', ')}). Install them with: ${installCommand}`);
  }
  const confirmed = await promptYesNo('Install required microVM host packages with Homebrew now? [y/N] ');
  if (!confirmed) {
    throw new Error(`Install the missing microVM host packages and retry: ${installCommand}`);
  }
  await runCommand('brew', ['install', ...packages]);
}

async function ensureMicrovmHostDependencies(profile: MicrovmProfile, dryRun: boolean): Promise<void> {
  const missing = profile.dependencies.filter((entry) => !commandExists(entry.command));
  if (missing.length === 0) {
    return;
  }

  if (profile.hostPlatform === 'linux') {
    const aptPackages = Array.from(new Set(
      missing
        .map((entry) => entry.aptPackage)
        .filter((entry): entry is string => Boolean(entry)),
    ));
    if (aptPackages.length === 0) {
      throw new Error(`Missing microVM host dependencies: ${missing.map((entry) => entry.command).join(', ')}`);
    }
    await installViaApt(aptPackages, dryRun);
    return;
  }

  if (profile.hostPlatform === 'darwin') {
    const brewPackages = Array.from(new Set(
      missing
        .map((entry) => entry.brewPackage)
        .filter((entry): entry is string => Boolean(entry)),
    ));
    if (brewPackages.length === 0) {
      throw new Error(`Missing microVM host dependencies: ${missing.map((entry) => entry.command).join(', ')}`);
    }
    await installViaBrew(brewPackages, dryRun);
    return;
  }

  throw new Error(`Unsupported host platform for microVM dependency installation: ${profile.hostPlatform}`);
}

function ensureMicrovmSshKeyPair(privateKeyPath: string, publicKeyPath: string): void {
  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    return;
  }
  ensureDir(path.dirname(privateKeyPath));
  const keygen = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-N', '', '-C', 'devcon-microvm', '-f', privateKeyPath],
    { stdio: 'inherit' },
  );
  if (keygen.status !== 0) {
    throw new Error('Failed to generate the microVM SSH keypair.');
  }
}

function resolveMicrovmFirmwarePath(profile: MicrovmProfile): string | undefined {
  for (const candidate of profile.firmwareCandidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function ensureMicrovmPristineImage(profile: MicrovmProfile, imagePath: string, dryRun: boolean): Promise<void> {
  if (existsSync(imagePath)) {
    return;
  }
  ensureDir(path.dirname(imagePath));
  if (dryRun) {
    console.log(`[dry-run] Would download microVM base image from ${profile.downloadUrl} to ${imagePath}`);
    return;
  }
  console.log(`Downloading Ubuntu cloud image for microVM backend: ${profile.downloadUrl}`);
  await runCommand('curl', ['-fL', profile.downloadUrl, '-o', imagePath]);
}

function renderMicrovmBootstrapUserData(publicKey: string): string {
  return `#cloud-config
growpart:
  mode: auto
  devices: ['/']
  ignore_growroot_disabled: false
resize_rootfs: true
package_update: true
packages:
  - git
  - curl
  - ripgrep
  - ca-certificates
  - openssh-server
  - sudo
  - nodejs
  - npm
users:
  - default
  - name: ${MICROVM_GUEST_USER}
    gecos: Devcon MicroVM
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - ${publicKey.trim()}
runcmd:
  - mkdir -p ${MICROVM_GUEST_HOME}/.ssh /workspace /tmp/devcon
  - chown -R ${MICROVM_GUEST_USER}:${MICROVM_GUEST_USER} ${MICROVM_GUEST_HOME} /workspace /tmp/devcon
  - chmod 700 ${MICROVM_GUEST_HOME}/.ssh
  - npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest
  - touch /opt/devcon-microvm-ready
`;
}

function renderMicrovmBootstrapMetaData(): string {
  return `instance-id: devcon-microvm-bootstrap
local-hostname: devcon-microvm
`;
}

function createCloudInitSeedViaHdiutil(seedImagePath: string, userDataPath: string, metaDataPath: string): void {
  const seedDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-microvm-seed-'));
  try {
    cpSync(userDataPath, path.join(seedDir, 'user-data'));
    cpSync(metaDataPath, path.join(seedDir, 'meta-data'));
    const requestedOutput = seedImagePath.endsWith('.iso') ? seedImagePath : `${seedImagePath}.iso`;
    const result = spawnSync(
      'hdiutil',
      ['makehybrid', '-o', requestedOutput, seedDir, '-iso', '-joliet', '-default-volume-name', 'cidata'],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error('Failed to create the cloud-init seed image with hdiutil.');
    }
    const generatedPath = existsSync(requestedOutput)
      ? requestedOutput
      : existsSync(`${requestedOutput}.cdr`)
        ? `${requestedOutput}.cdr`
        : undefined;
    if (!generatedPath) {
      throw new Error('hdiutil did not produce the expected cloud-init seed image output.');
    }
    if (generatedPath !== seedImagePath) {
      cpSync(generatedPath, seedImagePath);
      rmSync(generatedPath, { force: true });
    }
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
}

function createCloudInitSeedImage(seedImagePath: string, userDataPath: string, metaDataPath: string): void {
  if (commandExists('cloud-localds')) {
    const seed = spawnSync('cloud-localds', [seedImagePath, userDataPath, metaDataPath], { stdio: 'inherit' });
    if (seed.status !== 0) {
      throw new Error('Failed to create the cloud-init seed image with cloud-localds.');
    }
    return;
  }
  if (process.platform === 'darwin' && commandExists('hdiutil')) {
    createCloudInitSeedViaHdiutil(seedImagePath, userDataPath, metaDataPath);
    return;
  }
  throw new Error(
    'Unable to create the cloud-init seed image. Install cloud-image-utils (cloud-localds) or set up a compatible ISO creation tool.',
  );
}

function getBaseSshArgs(port: number, privateKeyPath: string): string[] {
  return [
    '-i',
    privateKeyPath,
    '-p',
    String(port),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=4',
  ];
}

function readVmPid(pidFilePath: string): number | undefined {
  if (!existsSync(pidFilePath)) {
    return undefined;
  }
  const raw = readFileSync(pidFilePath, 'utf8').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidRunning(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function stopMicrovm(pidFilePath: string): void {
  const pid = readVmPid(pidFilePath);
  if (!pid) {
    return;
  }
  if (!isPidRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
}

async function waitForSshReady(port: number, privateKeyPath: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  const sshArgs = [
    ...getBaseSshArgs(port, privateKeyPath),
    `${MICROVM_GUEST_USER}@127.0.0.1`,
    'true',
  ];

  while (Date.now() - started < timeoutMs) {
    const probe = spawnSync('ssh', sshArgs, {
      stdio: 'ignore',
      timeout: 5_000,
    });
    if (probe.status === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for the microVM to accept SSH on port ${port}.`);
}

async function findFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate an ephemeral TCP port for the microVM SSH tunnel.')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createQemuOverlay(baseImagePath: string, overlayImagePath: string): void {
  const result = spawnSync(
    'qemu-img',
    ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', baseImagePath, overlayImagePath, `${MICROVM_DISK_SIZE_GB}G`],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to create microVM overlay image at ${overlayImagePath}.`);
  }
}

function startQemuInstance(options: {
  profile: MicrovmProfile;
  imagePath: string;
  sshPort: number;
  pidFilePath: string;
  serialLogPath: string;
  seedImagePath?: string;
  firmwarePath?: string;
}): void {
  const qemuArgs = options.profile.startArgs(options);
  const result = spawnSync(options.profile.qemuBinary, qemuArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('Failed to start the microVM instance with QEMU.');
  }
}

async function buildPreparedMicrovmImage(
  profile: MicrovmProfile,
  paths: ReturnType<typeof getMicrovmPaths>,
): Promise<void> {
  const bootstrapDir = mkdtempSync(path.join(os.tmpdir(), 'devcon-microvm-bootstrap-'));
  const overlayImagePath = path.join(bootstrapDir, 'bootstrap-overlay.qcow2');
  const userDataPath = path.join(bootstrapDir, 'user-data');
  const metaDataPath = path.join(bootstrapDir, 'meta-data');
  const seedImagePath = path.join(bootstrapDir, 'seed.img');
  const pidFilePath = path.join(bootstrapDir, 'qemu.pid');
  const serialLogPath = path.join(bootstrapDir, 'serial.log');

  try {
    ensureMicrovmSshKeyPair(paths.privateKeyPath, paths.publicKeyPath);
    const firmwarePath = resolveMicrovmFirmwarePath(profile);
    const publicKey = readFileSync(paths.publicKeyPath, 'utf8');
    writeFileSync(userDataPath, renderMicrovmBootstrapUserData(publicKey), 'utf8');
    writeFileSync(metaDataPath, renderMicrovmBootstrapMetaData(), 'utf8');
    createQemuOverlay(paths.pristineImagePath, overlayImagePath);
    createCloudInitSeedImage(seedImagePath, userDataPath, metaDataPath);

    const sshPort = await findFreeTcpPort();
    console.log('Preparing reusable microVM image. This can take several minutes on the first run.');
    startQemuInstance({
      profile,
      imagePath: overlayImagePath,
      sshPort,
      pidFilePath,
      serialLogPath,
      seedImagePath,
      firmwarePath,
    });

    try {
      await waitForSshReady(sshPort, paths.privateKeyPath, MICROVM_BOOT_TIMEOUT_MS);
      const markerArgs = [
        ...getBaseSshArgs(sshPort, paths.privateKeyPath),
        `${MICROVM_GUEST_USER}@127.0.0.1`,
        'test',
        '-f',
        '/opt/devcon-microvm-ready',
      ];
      const started = Date.now();
      while (Date.now() - started < MICROVM_PREPARE_TIMEOUT_MS) {
        const check = spawnSync('ssh', markerArgs, { stdio: 'ignore', timeout: 10_000 });
        if (check.status === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const readyCheck = spawnSync('ssh', markerArgs, { stdio: 'ignore', timeout: 10_000 });
      if (readyCheck.status !== 0) {
        throw new Error(
          `Timed out preparing the microVM image. Check ${serialLogPath} for guest bootstrap output.`,
        );
      }

      spawnSync(
        'ssh',
        [...getBaseSshArgs(sshPort, paths.privateKeyPath), `${MICROVM_GUEST_USER}@127.0.0.1`, 'sudo', 'shutdown', '-h', 'now'],
        { stdio: 'ignore', timeout: 15_000 },
      );
    } finally {
      const pid = readVmPid(pidFilePath);
      if (pid) {
        await waitForPidExit(pid, 30_000).catch(() => undefined);
      }
    }

    const convert = spawnSync('qemu-img', ['convert', '-O', 'qcow2', overlayImagePath, paths.preparedImagePath], {
      stdio: 'inherit',
    });
    if (convert.status !== 0) {
      throw new Error(`Failed to finalize the prepared microVM image at ${paths.preparedImagePath}.`);
    }
  } finally {
    stopMicrovm(pidFilePath);
    rmSync(bootstrapDir, { recursive: true, force: true });
  }
}

async function ensurePreparedMicrovmImage(
  profile: MicrovmProfile,
  dryRun: boolean,
): Promise<ReturnType<typeof getMicrovmPaths>> {
  const paths = getMicrovmPaths(profile);
  ensureDir(paths.rootDir);
  ensureDir(paths.imagesDir);
  ensureDir(paths.runsDir);
  ensureDir(paths.sshDir);
  await ensureMicrovmHostDependencies(profile, dryRun);
  ensureMicrovmSshKeyPair(paths.privateKeyPath, paths.publicKeyPath);
  await ensureMicrovmPristineImage(profile, paths.pristineImagePath, dryRun);

  if (existsSync(paths.preparedImagePath) || dryRun) {
    if (dryRun && !existsSync(paths.preparedImagePath)) {
      console.log(`[dry-run] Would prepare reusable microVM image at ${paths.preparedImagePath}`);
    }
    return paths;
  }

  await buildPreparedMicrovmImage(profile, paths);
  return paths;
}

function collectRelativeEntries(rootPath: string): Set<string> {
  const entries = new Set<string>();
  if (!existsSync(rootPath)) {
    return entries;
  }

  const rootStat = lstatSync(rootPath);
  if (!rootStat.isDirectory()) {
    entries.add(path.basename(rootPath));
    return entries;
  }

  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const children = readdirSync(current, { withFileTypes: true });
    for (const child of children) {
      const absPath = path.join(current, child.name);
      const relPath = toPosixPath(path.relative(rootPath, absPath));
      entries.add(relPath);
      if (child.isDirectory()) {
        stack.push(absPath);
      }
    }
  }
  return entries;
}

function copyIntoStage(sourcePath: string, stagePath: string, excludedPaths: Set<string> = new Set()): void {
  ensureDir(path.dirname(stagePath));
  const sourceStat = lstatSync(sourcePath);
  if (!sourceStat.isDirectory()) {
    cpSync(sourcePath, stagePath, { dereference: false });
    return;
  }

  cpSync(sourcePath, stagePath, {
    recursive: true,
    dereference: false,
    filter: (current) => {
      const normalized = path.resolve(current);
      for (const excluded of excludedPaths) {
        if (normalized === excluded || normalized.startsWith(`${excluded}${path.sep}`)) {
          return false;
        }
      }
      return true;
    },
  });
}

function resolveWritablePathExcludes(hostPath: string, homeDir: string): Set<string> {
  const excludes = new Set<string>();
  const normalizedHost = path.resolve(hostPath);
  const codexRoot = path.resolve(path.join(homeDir, '.codex'));
  if (normalizedHost === codexRoot) {
    for (const entry of ['tmp', 'sessions', 'shell_snapshots', 'log']) {
      const child = path.join(codexRoot, entry);
      if (existsSync(child)) {
        excludes.add(child);
      }
    }
  }
  return excludes;
}

function mapWritablePathToGuest(rawPath: string, hostHome: string): { hostPath: string; guestPath: string } {
  const hostPath = resolveUserPath(rawPath, hostHome);
  ensurePathWithinHome(hostPath, hostHome);
  ensureWritablePath(hostPath);
  const relative = path.relative(hostHome, hostPath);
  const guestPath = relative
    ? path.posix.join(MICROVM_GUEST_HOME, toPosixPath(relative))
    : MICROVM_GUEST_HOME;
  return { hostPath, guestPath };
}

function writeExecutable(targetPath: string, contents: string): void {
  ensureDir(path.dirname(targetPath));
  writeFileSync(targetPath, contents, { encoding: 'utf8', mode: 0o755 });
}

function buildMicrovmSshCommand(port: number, privateKeyPath: string, remoteCommand: string, tty = true): {
  command: string;
  args: string[];
} {
  const args = [
    ...getBaseSshArgs(port, privateKeyPath),
  ];
  if (tty) {
    args.push('-tt');
  }
  args.push(`${MICROVM_GUEST_USER}@127.0.0.1`, `/bin/bash -lc ${shellQuote(remoteCommand)}`);
  return { command: 'ssh', args };
}

async function pipeTarToSsh(sourceRoot: string, port: number, privateKeyPath: string, remoteExtractDir: string): Promise<void> {
  const tarCreate = process.platform === 'darwin'
    ? `cd ${shellQuote(sourceRoot)} && find . -mindepth 1 -maxdepth 1 -print0 | COPYFILE_DISABLE=1 tar --null --no-mac-metadata --no-xattrs -cf - --files-from -`
    : `cd ${shellQuote(sourceRoot)} && find . -mindepth 1 -maxdepth 1 -print0 | tar --null -cf - --files-from -`;
  const importDir = '/tmp/devcon/import';
  const promoteScript = [
    `rm -rf ${shellQuote(importDir)}`,
    `mkdir -p ${shellQuote(importDir)}`,
    `tar --no-same-owner --no-same-permissions -m -C ${shellQuote(importDir)} -xf -`,
    `if [ -d ${shellQuote(path.posix.join(importDir, 'workspace'))} ]; then mkdir -p ${shellQuote(path.posix.join(remoteExtractDir, 'workspace'))}; cp -a ${shellQuote(path.posix.join(importDir, 'workspace'))}/. ${shellQuote(path.posix.join(remoteExtractDir, 'workspace'))}/; fi`,
    `if [ -d ${shellQuote(path.posix.join(importDir, 'home', MICROVM_GUEST_USER))} ]; then mkdir -p ${shellQuote(MICROVM_GUEST_HOME)}; cp -a ${shellQuote(path.posix.join(importDir, 'home', MICROVM_GUEST_USER))}/. ${shellQuote(MICROVM_GUEST_HOME)}/; fi`,
    `if [ -d ${shellQuote(path.posix.join(importDir, 'tmp', 'devcon'))} ]; then mkdir -p /tmp/devcon; cp -a ${shellQuote(path.posix.join(importDir, 'tmp', 'devcon'))}/. /tmp/devcon/; fi`,
    `rm -rf ${shellQuote(importDir)}`,
  ].join(' && ');
  const remoteExtract = `/bin/bash -lc ${shellQuote(promoteScript)}`;
  const command = `${tarCreate} | ssh ${getBaseSshArgs(port, privateKeyPath).map(shellQuote).join(' ')} ${shellQuote(`${MICROVM_GUEST_USER}@127.0.0.1`)} ${shellQuote(remoteExtract)}`;
  await runCommand('/bin/bash', ['-lc', command]);
}

async function pipeTarFromSsh(pathsToFetch: string[], destinationRoot: string, port: number, privateKeyPath: string): Promise<void> {
  ensureDir(destinationRoot);
  const quotedPaths = pathsToFetch.map((entry) => shellQuote(entry.replace(/^\/+/, ''))).join(' ');
  const remoteCommand = `tar --ignore-failed-read -C / -cf - ${quotedPaths}`;
  const command = `ssh ${getBaseSshArgs(port, privateKeyPath).map(shellQuote).join(' ')} ${shellQuote(`${MICROVM_GUEST_USER}@127.0.0.1`)} ${shellQuote(remoteCommand)} | tar -C ${shellQuote(destinationRoot)} -xf -`;
  await runCommand('/bin/bash', ['-lc', command]);
}

function syncStageBackToHost(target: SyncPlanTarget): void {
  const sourceExists = existsSync(target.stagePath);
  const hostExists = existsSync(target.hostPath);
  if (target.rootType === 'file') {
    if (sourceExists) {
      ensureDir(path.dirname(target.hostPath));
      cpSync(target.stagePath, target.hostPath, { force: true, dereference: false });
    } else if (hostExists) {
      rmSync(target.hostPath, { force: true });
    }
    return;
  }

  if (sourceExists) {
    ensureDir(path.dirname(target.hostPath));
    cpSync(target.stagePath, target.hostPath, { recursive: true, force: true, dereference: false });
  }

  const rels = [...target.initialEntries].sort((a, b) => b.length - a.length);
  for (const relPath of rels) {
    const sourcePath = sourceExists ? path.join(target.stagePath, relPath) : '';
    if (sourceExists && existsSync(sourcePath)) {
      continue;
    }
    const hostPath = path.join(target.hostPath, relPath);
    if (!existsSync(hostPath)) {
      continue;
    }
    rmSync(hostPath, { recursive: true, force: true });
  }

  if (!sourceExists && hostExists && lstatSync(target.hostPath).isFile()) {
    rmSync(target.hostPath, { force: true });
  }
}

function buildMicrovmInitScript(options: {
  toolName: string;
  tool: ToolDefinition;
  toolArgs: string[];
  guestWorkspaceTarget: string;
  allowGit: boolean;
  tempGit: boolean;
}): string {
  const lines = [
    'set -e',
    `export HOME=${shellQuote(MICROVM_GUEST_HOME)}`,
    `export DEVCON_WORKSPACE=${shellQuote(options.guestWorkspaceTarget)}`,
    `export DEVCON_TOOL=${shellQuote(options.toolName)}`,
  ];

  for (const [key, value] of Object.entries(options.tool.env ?? {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  if (options.tempGit) {
    lines.push(
      'export GIT_DIR=/tmp/devcon/gitdir',
      `export GIT_WORK_TREE=${shellQuote(options.guestWorkspaceTarget)}`,
      'if ! git rev-parse --verify HEAD >/dev/null 2>&1; then',
      '  git add -A >/dev/null 2>&1 || true',
      '  git commit -m "devcon baseline" >/dev/null 2>&1 || true',
      'fi',
    );
  }

  if (options.allowGit) {
    lines.push('export GIT_CONFIG_GLOBAL=/tmp/devcon/gitconfig');
  }

  if (options.toolName === 'codex') {
    lines.push(
      'if command -v codex >/dev/null 2>&1; then',
      `  codex mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
      'fi',
    );
  } else if (options.toolName === 'claude') {
    lines.push(
      'if command -v claude >/dev/null 2>&1; then',
      `  claude mcp remove ${CONSCIOUS_MCP_NAME} >/dev/null 2>&1 || true`,
      'fi',
    );
  }

  const toolCommand = options.tool.command ?? [];
  const commandArgs = [...toolCommand, ...options.toolArgs];
  const commandString = commandArgs.length > 0
    ? commandArgs.map(shellQuote).join(' ')
    : '/bin/bash';
  lines.push(`cd ${shellQuote(options.guestWorkspaceTarget)}`);
  lines.push(`exec ${commandString}`);

  return `#!/bin/bash
${lines.join('\n')}
`;
}

async function buildMicrovmLaunchPlan(options: {
  cwd: string;
  toolName: string;
  tool: ToolDefinition;
  toolArgs: string[];
  extraMounts: ExtraMount[];
  shareHome: boolean;
  allowGit: boolean;
  tempGit: boolean;
  forceIpv4: boolean;
}): Promise<LaunchPlan> {
  if (options.shareHome) {
    throw new Error('The microVM backend does not support --home yet. Use writablePaths for the specific state you want to share.');
  }
  if (options.forceIpv4) {
    console.warn('MicroVM backend note: --ipv4 is currently ignored; QEMU user-mode networking already uses a private NAT.');
  }

  const profile = resolveMicrovmProfile();
  const paths = await ensurePreparedMicrovmImage(profile, false);
  const runDir = mkdtempSync(path.join(paths.runsDir, 'run-'));
  const cleanupTargets = [runDir];
  const overlayImagePath = path.join(runDir, 'overlay.qcow2');
  const pidFilePath = path.join(runDir, 'qemu.pid');
  const serialLogPath = path.join(runDir, 'serial.log');
  const stageRoot = path.join(runDir, 'stage');
  const outputRoot = path.join(runDir, 'output');
  const guestWorkspaceTarget = options.tool.workdir ?? resolveDefaultWorkspaceTarget(options.cwd);
  const syncTargets: SyncPlanTarget[] = [];
  let tempGitDir: string | undefined;

  try {
    const firmwarePath = resolveMicrovmFirmwarePath(profile);
    createQemuOverlay(paths.preparedImagePath, overlayImagePath);
    ensureDir(stageRoot);
    ensureDir(outputRoot);

    const resolvedExtraMounts = resolveExtraMountContainerPaths(options.extraMounts, guestWorkspaceTarget);
    const scanTargets = [
      { label: 'workspace', hostPath: options.cwd, guestPath: guestWorkspaceTarget },
      ...resolvedExtraMounts.map((entry, index) => ({
        label: `mount ${index + 1}`,
        hostPath: entry.hostPath,
        guestPath: entry.containerPath,
      })),
    ];

    for (const target of scanTargets) {
      console.log(`Staging ${target.label} for the microVM...`);
      const sensitive = dedupeSensitivePaths(
        discoverSensitivePaths(target.hostPath, target.guestPath, { allowGit: options.allowGit }),
      );
      const stagePath = path.join(stageRoot, target.guestPath.replace(/^\/+/, ''));
      copyIntoStage(
        target.hostPath,
        stagePath,
        new Set(sensitive.map((entry) => path.resolve(entry.hostPath))),
      );
      syncTargets.push({
        label: target.label,
        hostPath: target.hostPath,
        guestPath: target.guestPath,
        stagePath,
        rootType: detectPathType(target.hostPath),
        initialEntries: collectRelativeEntries(stagePath),
      });
    }

    const homeDir = os.homedir();
    for (const rawPath of options.tool.writablePaths ?? []) {
      const mapped = mapWritablePathToGuest(rawPath, homeDir);
      const stagePath = path.join(stageRoot, mapped.guestPath.replace(/^\/+/, ''));
      copyIntoStage(mapped.hostPath, stagePath, resolveWritablePathExcludes(mapped.hostPath, homeDir));
      syncTargets.push({
        label: `writable path ${rawPath}`,
        hostPath: mapped.hostPath,
        guestPath: mapped.guestPath,
        stagePath,
        rootType: detectPathType(mapped.hostPath),
        initialEntries: collectRelativeEntries(stagePath),
      });
    }

    if (options.tempGit) {
      const temp = prepareTempGitRepo(guestWorkspaceTarget);
      tempGitDir = temp.hostDir;
      cleanupTargets.push(temp.hostDir);
      const stagePath = path.join(stageRoot, temp.containerDir.replace(/^\/+/, ''));
      copyIntoStage(temp.hostDir, stagePath);
      syncTargets.push({
        label: 'temporary git repository',
        hostPath: temp.hostDir,
        guestPath: temp.containerDir,
        stagePath,
        rootType: 'dir',
        initialEntries: collectRelativeEntries(stagePath),
      });
    }

    if (options.allowGit) {
      const gitConfigPath = path.join(stageRoot, 'tmp', 'devcon', 'gitconfig');
      writeExecutable(gitConfigPath, '[user]\n\tname = devcon-bot\n\temail = devcon@example.com\n');
    }

    const initScriptPath = path.join(stageRoot, 'tmp', 'devcon', 'init.sh');
    writeExecutable(initScriptPath, buildMicrovmInitScript({
      toolName: options.toolName,
      tool: options.tool,
      toolArgs: options.toolArgs,
      guestWorkspaceTarget,
      allowGit: options.allowGit,
      tempGit: options.tempGit,
    }));

    const sshPort = await findFreeTcpPort();
    startQemuInstance({
      profile,
      imagePath: overlayImagePath,
      sshPort,
      pidFilePath,
      serialLogPath,
      firmwarePath,
    });
    await waitForSshReady(sshPort, paths.privateKeyPath, MICROVM_BOOT_TIMEOUT_MS);
    await pipeTarToSsh(stageRoot, sshPort, paths.privateKeyPath, '/');

    const launch = buildMicrovmSshCommand(
      sshPort,
      paths.privateKeyPath,
      'source /tmp/devcon/init.sh',
    );

    return {
      command: launch.command,
      args: launch.args,
      cleanupTargets,
      tempGitDir,
      finalize: async () => {
        await pipeTarFromSsh(syncTargets.map((entry) => entry.guestPath), outputRoot, sshPort, paths.privateKeyPath);
        for (const entry of syncTargets) {
          const outputStagePath = path.join(outputRoot, entry.guestPath.replace(/^\/+/, ''));
          syncStageBackToHost({
            ...entry,
            stagePath: outputStagePath,
          });
        }
      },
      cleanup: () => {
        stopMicrovm(pidFilePath);
        const pid = readVmPid(pidFilePath);
        if (pid && isPidRunning(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Ignore secondary shutdown errors.
          }
        }
        for (const target of cleanupTargets) {
          try {
            rmSync(target, { recursive: true, force: true });
          } catch (error) {
            console.warn('Failed to clean temporary artifact', target, error);
          }
        }
      },
    };
  } catch (error) {
    stopMicrovm(pidFilePath);
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

function printMicrovmDryRunSummary(options: {
  toolName: string;
  tool: ToolDefinition;
  cwd: string;
  extraMounts: ExtraMount[];
  toolArgs?: string[];
}): void {
  const profile = resolveMicrovmProfile();
  const paths = getMicrovmPaths(profile);
  const workspaceTarget = options.tool.workdir ?? resolveDefaultWorkspaceTarget(options.cwd);
  console.log('[dry-run] Backend: microvm');
  console.log(`[dry-run] Host profile: ${profile.hostPlatform}/${profile.hostArch} -> guest ${profile.guestArch}`);
  console.log(`[dry-run] Workspace: ${options.cwd} -> ${workspaceTarget}`);
  if (options.extraMounts.length > 0) {
    for (const mount of options.extraMounts) {
      console.log(`[dry-run] Extra mount: ${mount.hostPath} -> ${path.posix.join(WORKSPACE_ROOT, mount.mountName)}`);
    }
  }
  console.log(`[dry-run] Prepared image cache: ${paths.preparedImagePath}`);
  console.log(`[dry-run] Pristine image cache: ${paths.pristineImagePath}`);
  if (profile.firmwareCandidates.length > 0) {
    const firmwarePath = resolveMicrovmFirmwarePath(profile);
    console.log(`[dry-run] Firmware: ${firmwarePath ?? `not found (set ${MICROVM_FIRMWARE_ENV})`}`);
  }
  const toolCommand = options.tool.command ?? [];
  const commandArgs = [...toolCommand, ...(options.toolArgs ?? [])];
  console.log(`[dry-run] Guest command: ${commandArgs.length > 0 ? commandArgs.join(' ') : '/bin/bash'}`);
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

  if (options.webMode && options.exportPatchPath !== undefined) {
    throw new Error('--export-patch is not supported with --web mode.');
  }

  if (options.backend === 'microvm' && options.webMode) {
    throw new Error('The microVM backend does not support --web mode yet.');
  }

  if (!options.toolName) {
    console.error('No tool specified.');
    printHelp(tools);
    process.exitCode = 1;
    return;
  }

  if (options.toolName === 'update') {
    if (options.backend === 'microvm') {
      throw new Error('"devcon update" currently manages Docker images only. The microVM backend provisions itself automatically on first use.');
    }
    if (options.webMode) {
      throw new Error('The --web flag cannot be used with "devcon update".');
    }
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon update". Specify the desired image in the tool configuration instead.');
    }
    assertNoExtraMounts(options.mountPaths, 'update');
    await handleUpdateCommand(options.toolArgs, tools, options.dryRun);
    return;
  }

  if (options.toolName === 'rebuild') {
    if (options.backend === 'microvm') {
      throw new Error('"devcon rebuild" currently manages Docker images only. Remove --backend microvm for this command.');
    }
    if (options.webMode) {
      throw new Error('The --web flag cannot be used with "devcon rebuild".');
    }
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon rebuild". Specify the desired image in the tool configuration instead.');
    }
    assertNoExtraMounts(options.mountPaths, 'rebuild');
    await handleRebuildCommand(options.toolArgs, tools, options.dryRun);
    return;
  }

  const cwd = getCurrentWorkingDirectory();

  if (options.toolName === 'sensitive') {
    if (options.webMode) {
      throw new Error('The --web flag cannot be used with "devcon sensitive".');
    }
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon sensitive". This command only manages sensitive-file patterns.');
    }
    assertNoExtraMounts(options.mountPaths, 'sensitive');
    handleSensitiveCommand(options.toolArgs, cwd);
    return;
  }

  if (options.toolName === 'skip-scan') {
    if (options.webMode) {
      throw new Error('The --web flag cannot be used with "devcon skip-scan".');
    }
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon skip-scan". This command only manages directory scan skips.');
    }
    assertNoExtraMounts(options.mountPaths, 'skip-scan');
    handleSkipScanCommand(options.toolArgs);
    return;
  }

  if (options.toolName === 'conscious') {
    if (options.webMode) {
      throw new Error('The --web flag cannot be used with "devcon conscious".');
    }
    if (options.imageOverride) {
      throw new Error('The --image flag cannot be used with "devcon conscious". This command manages conscious storage only.');
    }
    assertNoExtraMounts(options.mountPaths, 'conscious');
    await handleConsciousCommand(options.toolArgs, cwd, options.consciousStatePath);
    return;
  }

  const extraMounts = resolveExtraMounts(options.mountPaths, cwd);
  const tool = tools[options.toolName];

  if (options.toolName === 'run') {
    const toolDef: ToolDefinition = {
      image: DEFAULT_IMAGE_TAG,
      command: options.toolArgs.length === 0 ? ['/bin/bash'] : [],
      description: 'Interactive shell',
    };

    let launch: LaunchPlan;
    let consciousRuntime: ConsciousRuntime | undefined;

    if (options.backend === 'docker') {
      ensureDockerAvailable();
      consciousRuntime = options.conscious
        ? await prepareConsciousRuntime(cwd, options.toolArgs, options.consciousStatePath)
        : undefined;
      if (consciousRuntime) {
        console.log(`Conscious mode enabled (state: ${consciousRuntime.stateDir})`);
        console.log(`Conscious project: ${consciousRuntime.projectName} [${consciousRuntime.projectId}]`);
        console.log(`Seed retrieval query: "${consciousRuntime.seedQuery}"`);
        console.log(`MCP debug log: ${consciousRuntime.mcpLogHostPath}`);
      }
      const image = options.imageOverride ?? DEFAULT_IMAGE_TAG;
      await ensureImageAvailable(image, image === DEFAULT_IMAGE_TAG ? DEFAULT_AUTO_BUILD : undefined);
      const networkHost = await maybeEnableHostNetwork(image, options.networkHost, options.dryRun);
      if (consciousRuntime) {
        if (networkHost) {
          throw new Error('Conscious sidecar mode is not compatible with --network-host.');
        }
        const sidecarImage = getConsciousSidecarImage();
        await ensureImageAvailable(sidecarImage, sidecarImage === DEFAULT_IMAGE_TAG ? DEFAULT_AUTO_BUILD : undefined);
        ensureConsciousSidecar(consciousRuntime, sidecarImage, options.dryRun);
        console.log(`Conscious sidecar ready: ${consciousRuntime.sidecarContainerName} (${consciousRuntime.sidecarHost}:${consciousRuntime.sidecarPort})`);
      }

      launch = buildDockerArgs({
        cwd,
        toolName: options.toolName,
        tool: { ...toolDef, image },
        toolArgs: options.toolArgs,
        extraMounts,
        shareHome: options.shareHome,
        image,
        allowGit: options.allowGit,
        tempGit: options.tempGit,
        forceIpv4: options.forceIpv4,
        networkHost,
        conscious: consciousRuntime,
      });
    } else {
      if (options.conscious) {
        throw new Error('The microVM backend does not support --conscious yet.');
      }
      if (options.imageOverride) {
        throw new Error('The --image flag is only supported by the Docker backend.');
      }
      if (options.networkHost) {
        throw new Error('The microVM backend does not support --network-host.');
      }
      if (options.dryRun) {
        printMicrovmDryRunSummary({
          toolName: options.toolName,
          tool: toolDef,
          cwd,
          extraMounts,
          toolArgs: options.toolArgs,
        });
        return;
      }
      launch = await buildMicrovmLaunchPlan({
        cwd,
        toolName: options.toolName,
        tool: toolDef,
        toolArgs: options.toolArgs,
        extraMounts,
        shareHome: options.shareHome,
        allowGit: options.allowGit,
        tempGit: options.tempGit,
        forceIpv4: options.forceIpv4,
      });
    }

    if (options.webMode) {
      if (consciousRuntime) {
        console.warn('Web mode note: conscious auto-capture on CLI exit is not performed while running inside tmux.');
      }
      await launchWebModeSession(options, cwd, launch);
      return;
    }

    if (options.dryRun) {
      console.log([launch.command, ...launch.args].join(' '));
      launch.cleanup();
      return;
    }

    const child = spawn(launch.command, launch.args, { stdio: 'inherit' });
    const terminate = (): void => {
      child.kill('SIGINT');
    };

    process.on('SIGINT', terminate);
    process.on('SIGTERM', terminate);

    child.on('exit', (code) => {
      Promise.resolve(launch.finalize?.())
        .catch((error) => {
          console.warn('Launch finalization failed:', error instanceof Error ? error.message : error);
        })
        .finally(() => {
          const captured = maybeCaptureConsciousLearning(consciousRuntime, cwd, code);
          if (captured) {
            console.log(`Conscious mode captured finding ${captured.id}`);
          }
          launch.cleanup();
          process.exit(code ?? 1);
        });
    });

    child.on('error', (error) => {
      launch.cleanup();
      console.error('Failed to start launch process:', error instanceof Error ? error.message : error);
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

  let consciousRuntime: ConsciousRuntime | undefined;
  let launch: LaunchPlan;

  if (options.backend === 'docker') {
    ensureDockerAvailable();
    consciousRuntime = options.conscious
      ? await prepareConsciousRuntime(cwd, options.toolArgs, options.consciousStatePath)
      : undefined;
    if (consciousRuntime) {
      console.log(`Conscious mode enabled (state: ${consciousRuntime.stateDir})`);
      console.log(`Conscious project: ${consciousRuntime.projectName} [${consciousRuntime.projectId}]`);
      console.log(`Seed retrieval query: "${consciousRuntime.seedQuery}"`);
      console.log(`MCP debug log: ${consciousRuntime.mcpLogHostPath}`);
    }

    console.log(`Preparing to launch tool "${options.toolName}" using image "${tool.image}"...`);

    const image = options.imageOverride ?? tool.image;
    await ensureImageAvailable(image, options.imageOverride ? undefined : tool.autoBuild);
    const networkHost = await maybeEnableHostNetwork(image, options.networkHost, options.dryRun);
    if (consciousRuntime) {
      if (networkHost) {
        throw new Error('Conscious sidecar mode is not compatible with --network-host.');
      }
      const sidecarImage = getConsciousSidecarImage();
      await ensureImageAvailable(sidecarImage, sidecarImage === DEFAULT_IMAGE_TAG ? DEFAULT_AUTO_BUILD : undefined);
      ensureConsciousSidecar(consciousRuntime, sidecarImage, options.dryRun);
      console.log(`Conscious sidecar ready: ${consciousRuntime.sidecarContainerName} (${consciousRuntime.sidecarHost}:${consciousRuntime.sidecarPort})`);
    }

    launch = buildDockerArgs({
      cwd,
      toolName: options.toolName,
      tool,
      toolArgs: options.toolArgs,
      extraMounts,
      shareHome: options.shareHome && tool.shareHome !== false,
      image,
      allowGit: options.allowGit,
      tempGit: options.tempGit,
      forceIpv4: options.forceIpv4,
      networkHost,
      conscious: consciousRuntime,
    });
  } else {
    if (options.conscious) {
      throw new Error('The microVM backend does not support --conscious yet.');
    }
    if (options.imageOverride) {
      throw new Error('The --image flag is only supported by the Docker backend.');
    }
    if (options.networkHost) {
      throw new Error('The microVM backend does not support --network-host.');
    }
    if (options.dryRun) {
      printMicrovmDryRunSummary({
        toolName: options.toolName,
        tool,
        cwd,
        extraMounts,
        toolArgs: options.toolArgs,
      });
      return;
    }
    console.log(`Preparing to launch tool "${options.toolName}" using the microVM backend...`);
    launch = await buildMicrovmLaunchPlan({
      cwd,
      toolName: options.toolName,
      tool,
      toolArgs: options.toolArgs,
      extraMounts,
      shareHome: options.shareHome && tool.shareHome !== false,
      allowGit: options.allowGit,
      tempGit: options.tempGit,
      forceIpv4: options.forceIpv4,
    });
  }

  if (options.webMode) {
    if (options.tempGit) {
      console.warn('Web mode note: --temp-git is supported, but patch export/auto-capture callbacks are not run by the parent CLI process.');
    }
    if (consciousRuntime) {
      console.warn('Web mode note: conscious auto-capture on CLI exit is not performed while running inside tmux.');
    }
    await launchWebModeSession(options, cwd, launch);
    return;
  }

  if (options.dryRun) {
    console.log([launch.command, ...launch.args].join(' '));
    launch.cleanup();
    return;
  }

  const child = spawn(launch.command, launch.args, { stdio: 'inherit' });
  const terminate = (): void => {
    child.kill('SIGINT');
  };

  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);

  child.on('exit', (code) => {
    Promise.resolve(launch.finalize?.())
      .catch((error) => {
        console.warn('Launch finalization failed:', error instanceof Error ? error.message : error);
      })
      .finally(() => {
        if (options.tempGit && launch.tempGitDir && options.exportPatchPath !== undefined) {
          try {
            exportTempGitPatch(launch.tempGitDir, cwd, options.exportPatchPath || undefined);
          } catch (error) {
            console.warn('Failed to export patch from temp git repo:', error instanceof Error ? error.message : error);
          }
        }
        const captured = maybeCaptureConsciousLearning(consciousRuntime, cwd, code);
        if (captured) {
          console.log(`Conscious mode captured finding ${captured.id}`);
        }
        launch.cleanup();
        process.exit(code ?? 1);
      });
  });

  child.on('error', (error) => {
    launch.cleanup();
    console.error('Failed to start launch process:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
