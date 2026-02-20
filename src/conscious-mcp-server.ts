#!/usr/bin/env node
import { appendFileSync } from 'fs';
import { randomBytes } from 'crypto';
import {
  ConsciousArchiveStore,
  bootstrapConsciousPaths,
  resolveConsciousPaths,
} from './conscious-archive';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

interface RuntimeConfig {
  stateDir: string;
  defaultRepo?: string;
  projectId?: string;
  projectName?: string;
  debugLogPath?: string;
}

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2024-11-05',
];

const OVERVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

function parseArgs(argv: string[]): RuntimeConfig {
  let stateDir = process.env.DEVCON_CONSCIOUS_STATE_DIR;
  let defaultRepo = process.env.DEVCON_CONSCIOUS_REPO;
  let projectId = process.env.DEVCON_CONSCIOUS_PROJECT_ID;
  let projectName = process.env.DEVCON_CONSCIOUS_PROJECT_NAME;
  let debugLogPath = process.env.DEVCON_CONSCIOUS_DEBUG_LOG;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--state-dir=')) {
      stateDir = arg.slice('--state-dir='.length);
      continue;
    }
    if (arg === '--state-dir') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--state-dir requires a path.');
      }
      stateDir = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      defaultRepo = arg.slice('--repo='.length);
      continue;
    }
    if (arg === '--repo') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--repo requires a value.');
      }
      defaultRepo = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--project-id=')) {
      projectId = arg.slice('--project-id='.length);
      continue;
    }
    if (arg === '--project-id') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--project-id requires a value.');
      }
      projectId = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--project-name=')) {
      projectName = arg.slice('--project-name='.length);
      continue;
    }
    if (arg === '--project-name') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--project-name requires a value.');
      }
      projectName = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--debug-log=')) {
      debugLogPath = arg.slice('--debug-log='.length);
      continue;
    }
    if (arg === '--debug-log') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--debug-log requires a path.');
      }
      debugLogPath = next;
      i += 1;
      continue;
    }
  }

  if (!stateDir) {
    throw new Error('Missing --state-dir (or DEVCON_CONSCIOUS_STATE_DIR).');
  }

  return {
    stateDir,
    defaultRepo,
    projectId,
    projectName,
    debugLogPath,
  };
}

class StdioJsonRpcServer {
  private readonly archive: ConsciousArchiveStore;

  private readonly config: RuntimeConfig;

  private buffer: Buffer = Buffer.alloc(0);

  private framingMode: 'unknown' | 'content-length' | 'ndjson' = 'unknown';

  private activeOverviewToken?: {
    token: string;
    taxonomyVersion: number;
    issuedAt: number;
  };

  constructor(config: RuntimeConfig) {
    this.config = config;
    const paths = resolveConsciousPaths(config.stateDir);
    this.archive = new ConsciousArchiveStore(paths.dbPath);
    this.archive.ensureInitialized();
    this.log(`starting server (repo=${config.defaultRepo ?? 'unset'}, project=${this.projectScopeLabel()})`);
  }

  start(): void {
    const keepAlive = setInterval(() => undefined, 60_000);
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.tryProcessBuffer();
    });
    process.stdin.on('end', () => {
      this.log('stdin ended; waiting for process shutdown signal.');
    });

    process.stdin.on('error', (error) => {
      this.log(`stdin error: ${error.message}`);
    });

    process.on('uncaughtException', (error) => {
      this.log(`uncaughtException: ${error.message}`);
    });

    process.on('unhandledRejection', (reason) => {
      this.log(`unhandledRejection: ${String(reason)}`);
    });

    process.on('SIGTERM', () => {
      clearInterval(keepAlive);
      process.exit(0);
    });
    process.on('SIGINT', () => {
      clearInterval(keepAlive);
      process.exit(0);
    });
  }

  private tryProcessBuffer(): void {
    while (true) {
      if (this.framingMode !== 'ndjson') {
        const handledContentLength = this.tryProcessContentLengthFrame();
        if (handledContentLength === true) {
          continue;
        }
        if (handledContentLength === null && this.framingMode === 'content-length') {
          return;
        }
      }

      if (this.framingMode !== 'content-length') {
        const handledNdjson = this.tryProcessNdjsonFrame();
        if (handledNdjson === true) {
          continue;
        }
      }

      return;
    }
  }

  private tryProcessContentLengthFrame(): boolean | null {
    const boundary = this.findHeaderBoundary(this.buffer);
    if (!boundary) {
      return false;
    }

    const headerText = this.buffer.slice(0, boundary.headerEnd).toString('utf8');
    const contentLength = this.parseContentLength(headerText);
    if (contentLength <= 0) {
      if (this.framingMode === 'unknown') {
        return false;
      }
      this.log('Invalid Content-Length header.');
      this.buffer = Buffer.alloc(0);
      return null;
    }

    const bodyStart = boundary.bodyStart;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) {
      return null;
    }

    this.framingMode = 'content-length';
    const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
    this.buffer = this.buffer.slice(bodyEnd);
    this.handleJsonRpcBody(body);
    return true;
  }

  private tryProcessNdjsonFrame(): boolean {
    const newlineIndex = this.buffer.indexOf('\n');
    if (newlineIndex === -1) {
      return false;
    }

    const rawLine = this.buffer.slice(0, newlineIndex).toString('utf8');
    const line = rawLine.trim();

    if (line.length === 0) {
      this.buffer = this.buffer.slice(newlineIndex + 1);
      return true;
    }

    if (!line.startsWith('{')) {
      if (this.framingMode === 'unknown') {
        return false;
      }
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.log('Invalid NDJSON line; dropping buffer.');
      this.buffer = Buffer.alloc(0);
      return false;
    }

    this.buffer = this.buffer.slice(newlineIndex + 1);
    this.framingMode = 'ndjson';
    this.handleJsonRpcBody(line);
    return true;
  }

  private handleJsonRpcBody(body: string): void {
    this.log(`recv: ${this.truncateForLog(body)}`);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(body) as JsonRpcRequest;
    } catch (error) {
      this.log(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    void this.handleMessage(message);
  }

  private findHeaderBoundary(buffer: Buffer): { headerEnd: number; bodyStart: number } | null {
    const crlfBoundary = buffer.indexOf('\r\n\r\n');
    const lfBoundary = buffer.indexOf('\n\n');

    if (crlfBoundary === -1 && lfBoundary === -1) {
      return null;
    }

    if (crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary <= lfBoundary)) {
      return {
        headerEnd: crlfBoundary,
        bodyStart: crlfBoundary + 4,
      };
    }

    return {
      headerEnd: lfBoundary,
      bodyStart: lfBoundary + 2,
    };
  }

  private parseContentLength(headerText: string): number {
    const lines = headerText.split(/\r?\n/);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx === -1) {
        continue;
      }
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === 'content-length') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : -1;
      }
    }
    return -1;
  }

  private async handleMessage(message: JsonRpcRequest): Promise<void> {
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (message.id !== undefined) {
        this.sendError(message.id, -32600, 'Invalid Request');
      }
      return;
    }

    const isRequest = message.id !== undefined;

    try {
      const result = await this.dispatch(message.method, message.params);
      if (isRequest) {
        this.send({
          jsonrpc: '2.0',
          id: message.id ?? null,
          result,
        });
      }
    } catch (error) {
      if (isRequest) {
        this.sendError(
          message.id ?? null,
          -32000,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const requestedVersion = this.parseRequestedProtocolVersion(params);
      const protocolVersion = requestedVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        serverInfo: {
          name: 'devcon-archive',
          version: '0.4.0',
        },
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
      };
    }

    if (method === 'notifications/initialized') {
      return null;
    }

    if (method === 'ping') {
      return {};
    }

    if (method === 'tools/list') {
      return {
        tools: [
          {
            name: 'archive_overview',
            description: 'Session bootstrap tool. Call this first (before archive_search/archive_write/archive_create_path) to fetch current folder/label taxonomy and an overview token. Storage is already scoped to this project, so do not create project-name wrapper folders.',
            inputSchema: {
              type: 'object',
              properties: {
                depth: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
              },
            },
          },
          {
            name: 'archive_create_path',
            description: 'Create a new folder path under an existing parent after archive_overview. Use only when no existing path matches. Storage is project-local; avoid redundant project-name path segments.',
            inputSchema: {
              type: 'object',
              properties: {
                overview_token: { type: 'string' },
                parent_path_id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['overview_token', 'name'],
            },
          },
          {
            name: 'archive_search',
            description: 'Search historical findings by text, path prefix, and labels. Returns summary + previews from the hot index. Call archive_get for full stored details. Requires archive_overview once per session first so path/label choices follow current taxonomy.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                repo: { type: 'string' },
                top_k: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
                min_confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
                path_prefix: { type: 'string' },
                labels_any: {
                  type: 'array',
                  items: { type: 'string' },
                },
                labels_all: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'archive_get',
            description: 'Fetch full stored details for a finding id (problem, solution, evidence). Use this after archive_search when a hit looks relevant.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            },
          },
          {
            name: 'archive_write',
            description: 'Persist a durable finding in the existing taxonomy. Long details are persisted in per-finding files; archive_search serves index previews and archive_get retrieves full details. Call archive_overview first, then pass overview_token + path_id. Storage is project-local; do not add project-name wrapper folders. Store user preferences under /user/preferences with label user-preference.',
            inputSchema: {
              type: 'object',
              properties: {
                overview_token: { type: 'string' },
                repo: { type: 'string' },
                branch: { type: 'string' },
                commit_sha: { type: 'string' },
                path_id: { type: 'string' },
                summary: { type: 'string' },
                problem: { type: 'string' },
                solution: { type: 'string' },
                evidence: {
                  type: 'array',
                  items: { type: 'string' },
                },
                labels: {
                  type: 'array',
                  items: { type: 'string' },
                },
                confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.6 },
                ttl_days: { type: 'integer', minimum: 1, default: 180 },
                source: { type: 'string' },
              },
              required: ['overview_token', 'path_id', 'summary', 'problem', 'solution'],
            },
          },
          {
            name: 'archive_mark_used',
            description: 'Record whether a retrieved finding helped solve the task.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                outcome: { type: 'string', enum: ['helpful', 'not_helpful', 'unknown'] },
              },
              required: ['id', 'outcome'],
            },
          },
        ],
      };
    }

    if (method === 'tools/call') {
      const payload = (params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = payload.name;
      const args = payload.arguments ?? {};
      if (!name) {
        throw new Error('tools/call missing tool name.');
      }

      if (name === 'archive_overview') {
        return this.handleArchiveOverview();
      }
      if (name === 'archive_create_path') {
        return this.handleArchiveCreatePath(args);
      }
      if (name === 'archive_search') {
        return this.handleArchiveSearch(args);
      }
      if (name === 'archive_get') {
        return this.handleArchiveGet(args);
      }
      if (name === 'archive_write') {
        return this.handleArchiveWrite(args);
      }
      if (name === 'archive_mark_used') {
        return this.handleArchiveMarkUsed(args);
      }

      throw new Error(`Unknown tool "${name}".`);
    }

    throw new Error(`Method not found: ${method}`);
  }

  private handleArchiveOverview(): unknown {
    const overview = this.archive.getOverviewSnapshot();
    const overviewToken = this.issueOverviewToken(overview.taxonomyVersion);

    const topLabels = overview.labels.slice(0, 8).map((entry) => `${entry.label}(${entry.count})`).join(', ');
    const pathCount = overview.paths.length;
    const labelText = topLabels.length > 0 ? topLabels : '(none yet)';
    const text = `Overview ready for ${this.projectScopeLabel()}. paths=${pathCount}, taxonomy_version=${overview.taxonomyVersion}, labels=${labelText}. Storage is project-local; avoid project-name wrapper folders. Use overview_token with archive_write/archive_create_path.`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        overview_token: overviewToken,
        taxonomy_version: overview.taxonomyVersion,
        project_scope: {
          project_id: this.config.projectId,
          project_name: this.config.projectName,
        },
        paths: overview.paths,
        path_tree: overview.pathTree,
        labels: overview.labels,
      },
      isError: false,
    };
  }

  private handleArchiveCreatePath(args: Record<string, unknown>): unknown {
    const token = this.readString(args.overview_token, 'archive_create_path requires overview_token.');
    const tokenState = this.validateOverviewToken(token);
    const name = this.readString(args.name, 'archive_create_path requires name.');
    const parentPathId = typeof args.parent_path_id === 'string' ? args.parent_path_id : undefined;

    const result = this.archive.createPath({
      name,
      parentPathId,
      description: typeof args.description === 'string' ? args.description : undefined,
    });

    let nextToken = token;
    if (result.taxonomyVersion !== tokenState.taxonomyVersion) {
      nextToken = this.issueOverviewToken(result.taxonomyVersion);
    }

    return {
      content: [{ type: 'text', text: result.created ? `Created path ${result.path.fullPath}` : `Path already exists: ${result.path.fullPath}` }],
      structuredContent: {
        created: result.created,
        path: result.path,
        taxonomy_version: result.taxonomyVersion,
        overview_token: nextToken,
      },
      isError: false,
    };
  }

  private handleArchiveSearch(args: Record<string, unknown>): unknown {
    if (!this.activeOverviewToken) {
      throw new Error('Call archive_overview once at session start before archive_search.');
    }

    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) {
      throw new Error('archive_search requires a non-empty query.');
    }

    const repo = typeof args.repo === 'string' ? args.repo : this.config.defaultRepo;
    const topK = typeof args.top_k === 'number' ? args.top_k : 5;
    const minConfidence = typeof args.min_confidence === 'number' ? args.min_confidence : 0.3;
    const pathPrefix = typeof args.path_prefix === 'string' ? args.path_prefix : undefined;
    const labelsAny = Array.isArray(args.labels_any) ? args.labels_any.filter((entry): entry is string => typeof entry === 'string') : [];
    const labelsAll = Array.isArray(args.labels_all) ? args.labels_all.filter((entry): entry is string => typeof entry === 'string') : [];

    const hits = this.archive.search({
      query,
      repo,
      topK,
      minConfidence,
      pathPrefix,
      labelsAny,
      labelsAll,
    });

    const text = hits.length === 0
      ? 'No prior findings matched the query.'
      : hits
        .map((hit, index) => `${index + 1}. [${hit.id}] ${hit.summary} (path=${hit.path}, confidence=${hit.confidence.toFixed(2)}, score=${hit.score.toFixed(2)})`)
        .join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        query,
        repo,
        project_id: this.config.projectId,
        project_name: this.config.projectName,
        path_prefix: pathPrefix,
        labels_any: labelsAny,
        labels_all: labelsAll,
        results: hits,
      },
      isError: false,
    };
  }

  private handleArchiveWrite(args: Record<string, unknown>): unknown {
    const token = this.readString(args.overview_token, 'archive_write requires overview_token from archive_overview.');
    this.validateOverviewToken(token);

    const repo = typeof args.repo === 'string' ? args.repo : this.config.defaultRepo;
    if (!repo) {
      throw new Error('archive_write requires repo (or server default repo).');
    }

    const pathId = this.readString(args.path_id, 'archive_write requires path_id from archive_overview.');
    const summary = this.readString(args.summary, 'archive_write requires summary.');
    const problem = this.readString(args.problem, 'archive_write requires problem.');
    const solution = this.readString(args.solution, 'archive_write requires solution.');

    const labels = Array.isArray(args.labels)
      ? args.labels.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const record = this.archive.write({
      repo,
      branch: typeof args.branch === 'string' ? args.branch : undefined,
      commitSha: typeof args.commit_sha === 'string' ? args.commit_sha : undefined,
      pathId,
      summary,
      problem,
      solution,
      evidence: Array.isArray(args.evidence) ? args.evidence.filter((entry): entry is string => typeof entry === 'string') : [],
      labels,
      confidence: typeof args.confidence === 'number' ? args.confidence : 0.6,
      ttlDays: typeof args.ttl_days === 'number' ? args.ttl_days : 180,
      source: typeof args.source === 'string' ? args.source : 'mcp',
    });

    return {
      content: [{ type: 'text', text: `Stored finding ${record.id} in ${record.path}` }],
      structuredContent: record,
      isError: false,
    };
  }

  private handleArchiveGet(args: Record<string, unknown>): unknown {
    const id = this.readString(args.id, 'archive_get requires id.');
    const record = this.archive.get(id);
    return {
      content: [{ type: 'text', text: `Loaded full finding ${record.id} from ${record.path}` }],
      structuredContent: record,
      isError: false,
    };
  }

  private handleArchiveMarkUsed(args: Record<string, unknown>): unknown {
    const id = this.readString(args.id, 'archive_mark_used requires id.');
    const outcome = typeof args.outcome === 'string' ? args.outcome : '';
    if (outcome !== 'helpful' && outcome !== 'not_helpful' && outcome !== 'unknown') {
      throw new Error('archive_mark_used requires outcome in {helpful, not_helpful, unknown}.');
    }

    const record = this.archive.markUsed(id, outcome);
    return {
      content: [{ type: 'text', text: `Marked ${id} as ${outcome}` }],
      structuredContent: {
        id: record.id,
        useCount: record.useCount,
        successCount: record.successCount,
        lastUsedAt: record.lastUsedAt,
      },
      isError: false,
    };
  }

  private parseRequestedProtocolVersion(params: unknown): string | undefined {
    const candidate = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (typeof candidate !== 'string') {
      return undefined;
    }
    if (SUPPORTED_PROTOCOL_VERSIONS.includes(candidate)) {
      return candidate;
    }
    return SUPPORTED_PROTOCOL_VERSIONS[0];
  }

  private issueOverviewToken(taxonomyVersion: number): string {
    const token = `ov_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    this.activeOverviewToken = {
      token,
      taxonomyVersion,
      issuedAt: Date.now(),
    };
    return token;
  }

  private validateOverviewToken(token: string): { token: string; taxonomyVersion: number; issuedAt: number } {
    if (!this.activeOverviewToken) {
      throw new Error('Call archive_overview before archive_write or archive_create_path.');
    }

    if (this.activeOverviewToken.token !== token) {
      throw new Error('Stale overview_token. Call archive_overview again.');
    }

    if ((Date.now() - this.activeOverviewToken.issuedAt) > OVERVIEW_TOKEN_TTL_MS) {
      throw new Error('overview_token expired. Call archive_overview again.');
    }

    const currentTaxonomyVersion = this.archive.getTaxonomyVersion();
    if (currentTaxonomyVersion !== this.activeOverviewToken.taxonomyVersion) {
      throw new Error('Taxonomy changed since overview fetch. Call archive_overview again.');
    }

    return this.activeOverviewToken;
  }

  private readString(value: unknown, message: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(message);
    }
    return value.trim();
  }

  private send(payload: JsonRpcResponse): void {
    const body = JSON.stringify(payload);
    this.log(`send: ${this.truncateForLog(body)}`);
    if (this.framingMode === 'ndjson') {
      process.stdout.write(`${body}\n`);
      return;
    }
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    process.stdout.write(header + body);
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    });
  }

  private projectScopeLabel(): string {
    const name = this.config.projectName?.trim();
    const id = this.config.projectId?.trim();
    if (name && id) {
      return `${name} [${id}]`;
    }
    if (name) {
      return name;
    }
    if (id) {
      return id;
    }
    return 'project-local scope';
  }

  private log(message: string): void {
    const line = `[devcon-archive-mcp] ${message}\n`;
    process.stderr.write(line);
    if (this.config.debugLogPath) {
      try {
        appendFileSync(this.config.debugLogPath, line, 'utf8');
      } catch {
        // ignore debug log write failures
      }
    }
  }

  private truncateForLog(value: string, maxLen = 400): string {
    if (value.length <= maxLen) {
      return value;
    }
    return `${value.slice(0, maxLen)}...`;
  }
}

function main(): void {
  const config = parseArgs(process.argv.slice(2));
  bootstrapConsciousPaths(config.stateDir);
  const server = new StdioJsonRpcServer(config);
  server.start();
}

main();
