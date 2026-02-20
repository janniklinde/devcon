import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

const ARCHIVE_DB_VERSION = 3;
const RECORD_BLOB_VERSION = 1;
const ROOT_PATH_ID = 'path_root';
const RECORDS_DIRNAME = 'records';
const PREVIEW_CHAR_LIMIT = 500;

export interface ArchivePath {
  id: string;
  parentId?: string;
  name: string;
  fullPath: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchivePathNode {
  id: string;
  name: string;
  fullPath: string;
  children: ArchivePathNode[];
}

export interface ArchiveLabelCount {
  label: string;
  count: number;
}

export interface ArchiveRecord {
  id: string;
  repo: string;
  branch?: string;
  commitSha?: string;
  summary: string;
  problem: string;
  solution: string;
  pathId: string;
  path: string;
  labels: string[];
  evidence: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  ttlDays: number;
  useCount: number;
  successCount: number;
  lastUsedAt?: string;
  hash: string;
  source?: string;
}

interface ArchiveIndexRecord {
  id: string;
  repo: string;
  branch?: string;
  commitSha?: string;
  summary: string;
  problemPreview: string;
  solutionPreview: string;
  pathId: string;
  path: string;
  labels: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  ttlDays: number;
  useCount: number;
  successCount: number;
  lastUsedAt?: string;
  hash: string;
  source?: string;
  blobRef: string;
}

interface ArchiveRecordBlob {
  version: number;
  id: string;
  problem: string;
  solution: string;
  evidence: string[];
}

export interface ArchiveUsage {
  id: string;
  findingId: string;
  outcome: 'helpful' | 'not_helpful' | 'unknown';
  usedAt: string;
}

interface ArchiveDatabase {
  version: number;
  taxonomyVersion: number;
  paths: ArchivePath[];
  records: ArchiveIndexRecord[];
  usage: ArchiveUsage[];
}

export interface ArchiveSearchInput {
  query: string;
  repo?: string;
  topK?: number;
  minConfidence?: number;
  pathPrefix?: string;
  labelsAny?: string[];
  labelsAll?: string[];
}

export interface ArchiveSearchHit {
  id: string;
  repo: string;
  summary: string;
  problem: string;
  solution: string;
  pathId: string;
  path: string;
  labels: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  score: number;
}

export interface ArchiveWriteInput {
  repo: string;
  branch?: string;
  commitSha?: string;
  summary: string;
  problem: string;
  solution: string;
  pathId?: string;
  labels?: string[];
  tags?: string[];
  evidence?: string[];
  confidence?: number;
  ttlDays?: number;
  source?: string;
}

export interface ArchiveCreatePathInput {
  name: string;
  parentPathId?: string;
  description?: string;
}

export interface ArchiveOverviewSnapshot {
  taxonomyVersion: number;
  paths: ArchivePath[];
  pathTree: ArchivePathNode[];
  labels: ArchiveLabelCount[];
}

export interface ArchivePaths {
  rootDir: string;
  dbPath: string;
  sessionsDir: string;
  recordsDir: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeWhitespace(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(' ').filter((token) => token.length >= 2);
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stableHashForRecord(input: ArchiveWriteInput, resolvedPathId: string): string {
  const data = `${input.repo}\n${resolvedPathId}\n${normalizeWhitespace(input.problem)}\n${normalizeWhitespace(input.solution)}`;
  return hashKey(data.trim());
}

function makeRecordId(): string {
  const ts = Date.now().toString(36);
  const suffix = randomBytes(4).toString('hex');
  return `finding_${ts}_${suffix}`;
}

function makePathId(): string {
  const ts = Date.now().toString(36);
  const suffix = randomBytes(3).toString('hex');
  return `path_${ts}_${suffix}`;
}

function makeUsageId(): string {
  return `usage_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function recencyScore(createdAt: string): number {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return 0;
  }
  const ageDays = (Date.now() - createdMs) / (24 * 60 * 60 * 1000);
  if (ageDays <= 1) {
    return 1;
  }
  if (ageDays <= 7) {
    return 0.8;
  }
  if (ageDays <= 30) {
    return 0.5;
  }
  if (ageDays <= 90) {
    return 0.25;
  }
  return 0.1;
}

function isExpired(record: ArchiveIndexRecord): boolean {
  const createdMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdMs)) {
    return false;
  }
  const expiryMs = createdMs + (record.ttlDays * 24 * 60 * 60 * 1000);
  return Date.now() > expiryMs;
}

function dedupeStrings(values: string[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }
    set.add(normalized);
  }
  return [...set.values()];
}

function normalizeLabel(value: string): string {
  return normalizeWhitespace(value).replace(/\s+/g, '-');
}

function normalizePathName(name: string): string {
  return normalizeWhitespace(name).replace(/\s+/g, '-');
}

function joinPath(parentPath: string, name: string): string {
  if (parentPath === '/' || parentPath.length === 0) {
    return `/${name}`;
  }
  return `${parentPath}/${name}`.replace(/\/+/g, '/');
}

function buildPathTree(paths: ArchivePath[]): ArchivePathNode[] {
  const byParent = new Map<string, ArchivePath[]>();
  for (const item of paths) {
    const parent = item.parentId ?? '__root__';
    const existing = byParent.get(parent) ?? [];
    existing.push(item);
    byParent.set(parent, existing);
  }

  const buildNodes = (parentId: string): ArchivePathNode[] => {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    return children.map((child) => ({
      id: child.id,
      name: child.name,
      fullPath: child.fullPath,
      children: buildNodes(child.id),
    }));
  };

  return buildNodes('__root__');
}

function defaultPaths(): ArchivePath[] {
  const now = nowIso();
  const root: ArchivePath = {
    id: ROOT_PATH_ID,
    name: 'root',
    fullPath: '/',
    createdAt: now,
    updatedAt: now,
  };
  const engineering: ArchivePath = {
    id: 'path_engineering',
    parentId: ROOT_PATH_ID,
    name: 'engineering',
    fullPath: '/engineering',
    createdAt: now,
    updatedAt: now,
  };
  const debugging: ArchivePath = {
    id: 'path_debugging',
    parentId: engineering.id,
    name: 'debugging',
    fullPath: '/engineering/debugging',
    createdAt: now,
    updatedAt: now,
  };
  const user: ArchivePath = {
    id: 'path_user',
    parentId: ROOT_PATH_ID,
    name: 'user',
    fullPath: '/user',
    createdAt: now,
    updatedAt: now,
  };
  const preferences: ArchivePath = {
    id: 'path_user_preferences',
    parentId: user.id,
    name: 'preferences',
    fullPath: '/user/preferences',
    description: 'Durable user preferences and communication style decisions.',
    createdAt: now,
    updatedAt: now,
  };
  return [root, engineering, debugging, user, preferences];
}

function defaultBlobRef(recordId: string): string {
  return `${RECORDS_DIRNAME}/${recordId}.json`;
}

function normalizeBlobRef(ref: string | undefined, recordId: string): string {
  const candidate = (ref ?? '').trim().replace(/\\/g, '/');
  if (!candidate) {
    return defaultBlobRef(recordId);
  }
  const normalized = path.posix.normalize(candidate);
  if (
    normalized.startsWith('/')
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || !normalized.startsWith(`${RECORDS_DIRNAME}/`)
  ) {
    return defaultBlobRef(recordId);
  }
  return normalized;
}

function sanitizeBlobRefForRead(ref: string): string {
  const normalized = path.posix.normalize(ref.trim().replace(/\\/g, '/'));
  if (
    !normalized
    || normalized.startsWith('/')
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || !normalized.startsWith(`${RECORDS_DIRNAME}/`)
  ) {
    throw new Error(`Invalid blobRef "${ref}"`);
  }
  return normalized;
}

function makePreview(input: string): string {
  const text = input.trim();
  if (text.length <= PREVIEW_CHAR_LIMIT) {
    return text;
  }
  return `${text.slice(0, PREVIEW_CHAR_LIMIT)}...`;
}

function defaultDb(): ArchiveDatabase {
  return {
    version: ARCHIVE_DB_VERSION,
    taxonomyVersion: 1,
    paths: defaultPaths(),
    records: [],
    usage: [],
  };
}

export function resolveConsciousPaths(rootDir: string): ArchivePaths {
  return {
    rootDir,
    dbPath: path.join(rootDir, 'archive-db.json'),
    sessionsDir: path.join(rootDir, 'sessions'),
    recordsDir: path.join(rootDir, RECORDS_DIRNAME),
  };
}

export function bootstrapConsciousPaths(rootDir: string): ArchivePaths {
  const paths = resolveConsciousPaths(rootDir);
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  mkdirSync(paths.recordsDir, { recursive: true });
  if (!existsSync(paths.dbPath)) {
    writeFileSync(paths.dbPath, `${JSON.stringify(defaultDb(), null, 2)}\n`, 'utf8');
  }
  return paths;
}

export class ConsciousArchiveStore {
  private readonly dbPath: string;

  private readonly rootDir: string;

  private readonly recordsDir: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.rootDir = path.dirname(dbPath);
    this.recordsDir = path.join(this.rootDir, RECORDS_DIRNAME);
  }

  ensureInitialized(): void {
    mkdirSync(this.rootDir, { recursive: true });
    mkdirSync(this.recordsDir, { recursive: true });
    if (!existsSync(this.dbPath)) {
      writeFileSync(this.dbPath, `${JSON.stringify(defaultDb(), null, 2)}\n`, 'utf8');
      return;
    }

    const raw = this.readRawDb();
    const normalized = this.normalizeDb(raw);
    this.writeDb(normalized);
  }

  getRootPathId(): string {
    return ROOT_PATH_ID;
  }

  getTaxonomyVersion(): number {
    const db = this.readDb();
    return db.taxonomyVersion;
  }

  getOverviewSnapshot(): ArchiveOverviewSnapshot {
    this.ensureInitialized();
    const db = this.readDb();
    const labelCounts = new Map<string, number>();
    for (const record of db.records) {
      for (const label of record.labels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }

    const labels: ArchiveLabelCount[] = [...labelCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    return {
      taxonomyVersion: db.taxonomyVersion,
      paths: db.paths.slice().sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
      pathTree: buildPathTree(db.paths),
      labels,
    };
  }

  createPath(input: ArchiveCreatePathInput): { created: boolean; path: ArchivePath; taxonomyVersion: number } {
    this.ensureInitialized();
    const db = this.readDb();
    const parentPathId = input.parentPathId ?? ROOT_PATH_ID;
    const parent = db.paths.find((item) => item.id === parentPathId);
    if (!parent) {
      throw new Error(`Parent path ${parentPathId} was not found.`);
    }

    const normalizedName = normalizePathName(input.name);
    if (!normalizedName) {
      throw new Error('Path name is required.');
    }

    const existing = db.paths.find((item) => item.parentId === parentPathId && item.name === normalizedName);
    if (existing) {
      return {
        created: false,
        path: existing,
        taxonomyVersion: db.taxonomyVersion,
      };
    }

    const now = nowIso();
    const createdPath: ArchivePath = {
      id: makePathId(),
      parentId: parentPathId,
      name: normalizedName,
      fullPath: joinPath(parent.fullPath, normalizedName),
      description: input.description?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };

    db.paths.push(createdPath);
    db.taxonomyVersion += 1;
    this.writeDb(db);

    return {
      created: true,
      path: createdPath,
      taxonomyVersion: db.taxonomyVersion,
    };
  }

  search(input: ArchiveSearchInput): ArchiveSearchHit[] {
    this.ensureInitialized();
    const db = this.readDb();
    const query = input.query.trim();
    const topK = clamp(input.topK ?? 5, 1, 25);
    const minConfidence = clamp(input.minConfidence ?? 0.3, 0, 1);
    const queryTokens = tokenize(query);
    if (query.length > 0 && queryTokens.length === 0) {
      return [];
    }
    const pathPrefix = input.pathPrefix ? normalizePathName(input.pathPrefix).replace(/^\/+/, '') : '';
    const normalizedPathPrefix = pathPrefix ? `/${pathPrefix}` : '';
    const labelsAny = (input.labelsAny ?? []).map(normalizeLabel).filter((entry) => entry.length > 0);
    const labelsAll = (input.labelsAll ?? []).map(normalizeLabel).filter((entry) => entry.length > 0);

    const activeRecords = db.records.filter((record) => !isExpired(record));
    if (activeRecords.length !== db.records.length) {
      db.records = activeRecords;
      this.writeDb(db);
    }

    const hits: ArchiveSearchHit[] = [];

    for (const record of activeRecords) {
      if (record.confidence < minConfidence) {
        continue;
      }
      if (input.repo && input.repo !== record.repo) {
        continue;
      }
      if (normalizedPathPrefix && !record.path.startsWith(normalizedPathPrefix)) {
        continue;
      }
      if (labelsAny.length > 0 && !labelsAny.some((label) => record.labels.includes(label))) {
        continue;
      }
      if (labelsAll.length > 0 && !labelsAll.every((label) => record.labels.includes(label))) {
        continue;
      }

      const haystack = `${record.summary} ${record.problemPreview} ${record.solutionPreview} ${record.labels.join(' ')} ${record.path}`;
      const hayTokens = new Set(tokenize(haystack));
      const overlap = queryTokens.reduce((acc, token) => (hayTokens.has(token) ? acc + 1 : acc), 0);
      const tokenScore = queryTokens.length === 0 ? 0.4 : overlap / queryTokens.length;
      const confidenceScore = record.confidence;
      const freshScore = recencyScore(record.createdAt);
      const usageScore = Math.min(1, record.successCount / Math.max(1, record.useCount || 1));
      const score = (tokenScore * 0.6) + (confidenceScore * 0.2) + (freshScore * 0.1) + (usageScore * 0.1);

      if (queryTokens.length > 0 && overlap === 0) {
        continue;
      }

      hits.push({
        id: record.id,
        repo: record.repo,
        summary: record.summary,
        problem: record.problemPreview,
        solution: record.solutionPreview,
        pathId: record.pathId,
        path: record.path,
        labels: record.labels,
        confidence: record.confidence,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastUsedAt: record.lastUsedAt,
        useCount: record.useCount,
        score,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  write(input: ArchiveWriteInput): ArchiveRecord {
    this.ensureInitialized();
    const db = this.readDb();
    const pathId = input.pathId ?? ROOT_PATH_ID;
    const pathEntry = db.paths.find((item) => item.id === pathId);
    if (!pathEntry) {
      throw new Error(`Unknown pathId ${pathId}. Fetch archive_overview first and use an existing path_id.`);
    }

    const mergedLabels = dedupeStrings([
      ...(input.labels ?? []),
      ...(input.tags ?? []),
    ]).map(normalizeLabel).filter((entry) => entry.length > 0);

    const normalized: ArchiveWriteInput = {
      ...input,
      pathId,
      summary: input.summary.trim(),
      problem: input.problem.trim(),
      solution: input.solution.trim(),
      confidence: clamp(input.confidence ?? 0.6, 0, 1),
      ttlDays: Math.max(1, Math.floor(input.ttlDays ?? 180)),
      evidence: dedupeStrings((input.evidence ?? []).slice(0, 128)),
      labels: mergedLabels,
      source: input.source?.trim(),
    };

    if (!normalized.repo || !normalized.summary || !normalized.problem || !normalized.solution) {
      throw new Error('archive_write requires repo, summary, problem, and solution.');
    }

    const hash = stableHashForRecord(normalized, pathId);
    const now = nowIso();
    const existing = db.records.find((record) => record.hash === hash && record.repo === normalized.repo);

    if (existing) {
      existing.summary = normalized.summary;
      existing.problemPreview = makePreview(normalized.problem);
      existing.solutionPreview = makePreview(normalized.solution);
      existing.branch = normalized.branch;
      existing.commitSha = normalized.commitSha;
      existing.source = normalized.source;
      existing.ttlDays = normalized.ttlDays as number;
      existing.confidence = Math.max(existing.confidence, normalized.confidence as number);
      existing.labels = dedupeStrings([...existing.labels, ...(normalized.labels ?? [])]).slice(0, 32);
      existing.pathId = pathEntry.id;
      existing.path = pathEntry.fullPath;
      existing.updatedAt = now;
      existing.blobRef = normalizeBlobRef(existing.blobRef, existing.id);

      const existingBlob = this.readRecordBlob(existing.blobRef);
      const mergedEvidence = dedupeStrings([
        ...(existingBlob?.evidence ?? []),
        ...(normalized.evidence ?? []),
      ]).slice(0, 256);

      const blob: ArchiveRecordBlob = {
        version: RECORD_BLOB_VERSION,
        id: existing.id,
        problem: normalized.problem,
        solution: normalized.solution,
        evidence: mergedEvidence,
      };

      this.writeRecordBlob(existing.blobRef, blob);
      this.writeDb(db);
      return this.materializeRecord(existing, blob);
    }

    const recordId = makeRecordId();
    const blobRef = defaultBlobRef(recordId);
    const indexRecord: ArchiveIndexRecord = {
      id: recordId,
      repo: normalized.repo,
      branch: normalized.branch,
      commitSha: normalized.commitSha,
      summary: normalized.summary,
      problemPreview: makePreview(normalized.problem),
      solutionPreview: makePreview(normalized.solution),
      pathId: pathEntry.id,
      path: pathEntry.fullPath,
      labels: normalized.labels ?? [],
      confidence: normalized.confidence as number,
      createdAt: now,
      updatedAt: now,
      ttlDays: normalized.ttlDays as number,
      useCount: 0,
      successCount: 0,
      hash,
      source: normalized.source,
      blobRef,
    };

    const blob: ArchiveRecordBlob = {
      version: RECORD_BLOB_VERSION,
      id: recordId,
      problem: normalized.problem,
      solution: normalized.solution,
      evidence: normalized.evidence ?? [],
    };

    this.writeRecordBlob(blobRef, blob);
    db.records.push(indexRecord);
    this.writeDb(db);
    return this.materializeRecord(indexRecord, blob);
  }

  get(findingId: string): ArchiveRecord {
    this.ensureInitialized();
    const db = this.readDb();
    const record = db.records.find((item) => item.id === findingId);
    if (!record) {
      throw new Error(`Finding ${findingId} was not found.`);
    }

    const blob = this.readRecordBlob(record.blobRef);
    return this.materializeRecord(record, blob);
  }

  markUsed(findingId: string, outcome: 'helpful' | 'not_helpful' | 'unknown'): ArchiveRecord {
    this.ensureInitialized();
    const db = this.readDb();
    const record = db.records.find((item) => item.id === findingId);
    if (!record) {
      throw new Error(`Finding ${findingId} was not found.`);
    }

    const now = nowIso();
    record.useCount += 1;
    if (outcome === 'helpful') {
      record.successCount += 1;
    }
    record.lastUsedAt = now;
    record.updatedAt = now;

    db.usage.push({
      id: makeUsageId(),
      findingId,
      outcome,
      usedAt: now,
    });

    this.writeDb(db);
    const blob = this.readRecordBlob(record.blobRef);
    return this.materializeRecord(record, blob);
  }

  private materializeRecord(indexRecord: ArchiveIndexRecord, blob?: ArchiveRecordBlob): ArchiveRecord {
    const problem = blob?.problem ?? indexRecord.problemPreview;
    const solution = blob?.solution ?? indexRecord.solutionPreview;
    const evidence = blob?.evidence ?? [];
    return {
      id: indexRecord.id,
      repo: indexRecord.repo,
      branch: indexRecord.branch,
      commitSha: indexRecord.commitSha,
      summary: indexRecord.summary,
      problem,
      solution,
      pathId: indexRecord.pathId,
      path: indexRecord.path,
      labels: indexRecord.labels,
      evidence,
      confidence: indexRecord.confidence,
      createdAt: indexRecord.createdAt,
      updatedAt: indexRecord.updatedAt,
      ttlDays: indexRecord.ttlDays,
      useCount: indexRecord.useCount,
      successCount: indexRecord.successCount,
      lastUsedAt: indexRecord.lastUsedAt,
      hash: indexRecord.hash,
      source: indexRecord.source,
    };
  }

  private blobPathFromRef(blobRef: string): string {
    const normalized = sanitizeBlobRefForRead(blobRef);
    return path.join(this.rootDir, normalized);
  }

  private readRecordBlob(blobRef: string): ArchiveRecordBlob | undefined {
    try {
      const blobPath = this.blobPathFromRef(blobRef);
      if (!existsSync(blobPath)) {
        return undefined;
      }
      const raw = JSON.parse(readFileSync(blobPath, 'utf8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') {
        return undefined;
      }
      const problem = typeof raw.problem === 'string' ? raw.problem : '';
      const solution = typeof raw.solution === 'string' ? raw.solution : '';
      const evidence = Array.isArray(raw.evidence)
        ? raw.evidence.filter((item): item is string => typeof item === 'string')
        : [];
      if (!problem && !solution) {
        return undefined;
      }
      return {
        version: typeof raw.version === 'number' ? raw.version : RECORD_BLOB_VERSION,
        id: typeof raw.id === 'string' ? raw.id : '',
        problem,
        solution,
        evidence,
      };
    } catch {
      return undefined;
    }
  }

  private writeRecordBlob(blobRef: string, blob: ArchiveRecordBlob): void {
    const blobPath = this.blobPathFromRef(blobRef);
    mkdirSync(path.dirname(blobPath), { recursive: true });

    const normalizedBlob: ArchiveRecordBlob = {
      version: RECORD_BLOB_VERSION,
      id: blob.id,
      problem: blob.problem.trim(),
      solution: blob.solution.trim(),
      evidence: dedupeStrings(blob.evidence ?? []).slice(0, 256),
    };

    const tmpPath = `${blobPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(normalizedBlob, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, blobPath);
  }

  private readRawDb(): unknown {
    try {
      const raw = readFileSync(this.dbPath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Unable to read archive database at ${this.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readDb(): ArchiveDatabase {
    return this.normalizeDb(this.readRawDb());
  }

  private normalizeDb(raw: unknown): ArchiveDatabase {
    const parsed = raw as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return defaultDb();
    }

    const version = typeof parsed.version === 'number' ? parsed.version : 1;
    const recordsRaw = Array.isArray(parsed.records) ? parsed.records : [];
    const usageRaw = Array.isArray(parsed.usage) ? parsed.usage : [];
    const now = nowIso();

    const pathsRaw = Array.isArray(parsed.paths) ? parsed.paths : defaultPaths();
    const normalizedPaths = dedupePaths(pathsRaw as ArchivePath[]);
    if (!normalizedPaths.some((entry) => entry.id === ROOT_PATH_ID)) {
      normalizedPaths.unshift({
        id: ROOT_PATH_ID,
        name: 'root',
        fullPath: '/',
        createdAt: now,
        updatedAt: now,
      });
    }

    const pathMap = new Map<string, ArchivePath>();
    for (const item of normalizedPaths) {
      pathMap.set(item.id, item);
    }

    const normalizedRecords: ArchiveIndexRecord[] = recordsRaw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => {
        const id = typeof entry.id === 'string' ? entry.id : makeRecordId();
        const pathId = typeof entry.pathId === 'string' && pathMap.has(entry.pathId) ? entry.pathId : ROOT_PATH_ID;
        const resolvedPath = pathMap.get(pathId)?.fullPath ?? '/';
        const oldTags = Array.isArray(entry.tags) ? entry.tags.filter((v): v is string => typeof v === 'string') : [];
        const labels = Array.isArray(entry.labels) ? entry.labels.filter((v): v is string => typeof v === 'string') : [];
        const mergedLabels = dedupeStrings([...labels, ...oldTags]).map(normalizeLabel).filter((v) => v.length > 0);

        const repo = typeof entry.repo === 'string' ? entry.repo : '';
        const summary = typeof entry.summary === 'string' ? entry.summary : '';
        const oldProblem = typeof entry.problem === 'string' ? entry.problem : '';
        const oldSolution = typeof entry.solution === 'string' ? entry.solution : '';

        const explicitProblemPreview = typeof entry.problemPreview === 'string' ? entry.problemPreview : '';
        const explicitSolutionPreview = typeof entry.solutionPreview === 'string' ? entry.solutionPreview : '';
        const problemPreview = explicitProblemPreview || makePreview(oldProblem);
        const solutionPreview = explicitSolutionPreview || makePreview(oldSolution);

        const fallbackHash = stableHashForRecord(
          {
            repo,
            summary,
            problem: oldProblem || problemPreview,
            solution: oldSolution || solutionPreview,
            pathId,
          },
          pathId,
        );

        const blobRef = normalizeBlobRef(typeof entry.blobRef === 'string' ? entry.blobRef : undefined, id);

        const normalizedRecord: ArchiveIndexRecord = {
          id,
          repo,
          branch: typeof entry.branch === 'string' ? entry.branch : undefined,
          commitSha: typeof entry.commitSha === 'string' ? entry.commitSha : undefined,
          summary,
          problemPreview,
          solutionPreview,
          pathId,
          path: typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : resolvedPath,
          labels: mergedLabels,
          confidence: typeof entry.confidence === 'number' ? clamp(entry.confidence, 0, 1) : 0.6,
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now,
          ttlDays: typeof entry.ttlDays === 'number' ? Math.max(1, Math.floor(entry.ttlDays)) : 180,
          useCount: typeof entry.useCount === 'number' ? Math.max(0, Math.floor(entry.useCount)) : 0,
          successCount: typeof entry.successCount === 'number' ? Math.max(0, Math.floor(entry.successCount)) : 0,
          lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : undefined,
          hash: typeof entry.hash === 'string' ? entry.hash : fallbackHash,
          source: typeof entry.source === 'string' ? entry.source : undefined,
          blobRef,
        };

        const existingBlob = this.readRecordBlob(blobRef);
        if (!existingBlob) {
          const inlineEvidence = Array.isArray(entry.evidence)
            ? entry.evidence.filter((v): v is string => typeof v === 'string')
            : [];
          if (oldProblem || oldSolution || inlineEvidence.length > 0 || problemPreview || solutionPreview) {
            const bootstrapBlob: ArchiveRecordBlob = {
              version: RECORD_BLOB_VERSION,
              id,
              problem: oldProblem || problemPreview,
              solution: oldSolution || solutionPreview,
              evidence: inlineEvidence,
            };
            this.writeRecordBlob(blobRef, bootstrapBlob);
          }
        }

        return normalizedRecord;
      })
      .filter((entry) => entry.repo.length > 0 && entry.summary.length > 0 && (entry.problemPreview.length > 0 || entry.solutionPreview.length > 0));

    const normalizedUsage: ArchiveUsage[] = usageRaw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => {
        const outcome: ArchiveUsage['outcome'] = entry.outcome === 'helpful' || entry.outcome === 'not_helpful' || entry.outcome === 'unknown'
          ? entry.outcome
          : 'unknown';
        return {
          id: typeof entry.id === 'string' ? entry.id : makeUsageId(),
          findingId: typeof entry.findingId === 'string' ? entry.findingId : '',
          outcome,
          usedAt: typeof entry.usedAt === 'string' ? entry.usedAt : now,
        };
      })
      .filter((entry) => entry.findingId.length > 0);

    const taxonomyVersion = typeof parsed.taxonomyVersion === 'number'
      ? Math.max(1, Math.floor(parsed.taxonomyVersion))
      : version >= 2
        ? 1
        : 1;

    return {
      version: ARCHIVE_DB_VERSION,
      taxonomyVersion,
      paths: normalizedPaths,
      records: normalizedRecords,
      usage: normalizedUsage,
    };
  }

  private writeDb(db: ArchiveDatabase): void {
    const tmpPath = `${this.dbPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.dbPath);
  }
}

function dedupePaths(paths: ArchivePath[]): ArchivePath[] {
  const now = nowIso();
  const deduped = new Map<string, ArchivePath>();
  for (const raw of paths) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
      continue;
    }

    const existing = deduped.get(raw.id);
    if (existing) {
      continue;
    }

    const name = typeof raw.name === 'string' && raw.name.trim().length > 0
      ? normalizePathName(raw.name)
      : 'path';
    const fullPath = typeof raw.fullPath === 'string' && raw.fullPath.trim().length > 0
      ? raw.fullPath
      : `/${name}`;

    deduped.set(raw.id, {
      id: raw.id,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : undefined,
      name,
      fullPath,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    });
  }

  return [...deduped.values()];
}
