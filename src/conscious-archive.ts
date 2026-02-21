import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

const ARCHIVE_DB_VERSION = 4;
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
  revisionId?: string;
  revision?: number;
  revisionCreatedAt?: string;
  revisionCount?: number;
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
  currentRevisionId?: string;
}

interface ArchiveRecordBlob {
  version: number;
  id: string;
  problem: string;
  solution: string;
  evidence: string[];
}

interface ArchiveRecordRevision {
  id: string;
  findingId: string;
  revision: number;
  createdAt: string;
  branch?: string;
  commitSha?: string;
  summary: string;
  problemPreview: string;
  solutionPreview: string;
  pathId: string;
  path: string;
  labels: string[];
  confidence: number;
  ttlDays: number;
  hash: string;
  source?: string;
  blobRef: string;
}

export interface ArchiveRecordRevisionInfo {
  id: string;
  findingId: string;
  revision: number;
  createdAt: string;
  branch?: string;
  commitSha?: string;
  summary: string;
  problem: string;
  solution: string;
  pathId: string;
  path: string;
  labels: string[];
  confidence: number;
  ttlDays: number;
  hash: string;
  source?: string;
  isCurrent: boolean;
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
  revisions: ArchiveRecordRevision[];
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

export interface ArchiveUpdateInput {
  id: string;
  branch?: string;
  commitSha?: string;
  summary?: string;
  problem?: string;
  solution?: string;
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

function makeRevisionId(): string {
  return `rev_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
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

function defaultRevisionBlobRef(findingId: string, revisionId: string): string {
  return `${RECORDS_DIRNAME}/revisions/${findingId}/${revisionId}.json`;
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
    revisions: [],
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
      const existingBlob = this.readRecordBlob(existing.blobRef);
      const mergedEvidence = dedupeStrings([
        ...(existingBlob?.evidence ?? []),
        ...(normalized.evidence ?? []),
      ]).slice(0, 256);

      const nextRevision = this.nextRevisionNumber(db.revisions, existing.id);
      const revisionId = makeRevisionId();
      const revisionBlobRef = defaultRevisionBlobRef(existing.id, revisionId);
      const blob: ArchiveRecordBlob = {
        version: RECORD_BLOB_VERSION,
        id: existing.id,
        problem: normalized.problem,
        solution: normalized.solution,
        evidence: mergedEvidence,
      };
      this.writeRecordBlob(revisionBlobRef, blob);

      const revision: ArchiveRecordRevision = {
        id: revisionId,
        findingId: existing.id,
        revision: nextRevision,
        createdAt: now,
        branch: normalized.branch,
        commitSha: normalized.commitSha,
        summary: normalized.summary,
        problemPreview: makePreview(normalized.problem),
        solutionPreview: makePreview(normalized.solution),
        pathId: pathEntry.id,
        path: pathEntry.fullPath,
        labels: dedupeStrings([...existing.labels, ...(normalized.labels ?? [])]).slice(0, 32),
        confidence: Math.max(existing.confidence, normalized.confidence as number),
        ttlDays: normalized.ttlDays as number,
        hash,
        source: normalized.source,
        blobRef: revisionBlobRef,
      };
      db.revisions.push(revision);

      existing.summary = revision.summary;
      existing.problemPreview = revision.problemPreview;
      existing.solutionPreview = revision.solutionPreview;
      existing.branch = revision.branch;
      existing.commitSha = revision.commitSha;
      existing.source = revision.source;
      existing.ttlDays = revision.ttlDays;
      existing.confidence = revision.confidence;
      existing.labels = revision.labels;
      existing.pathId = revision.pathId;
      existing.path = revision.path;
      existing.updatedAt = now;
      existing.hash = hash;
      existing.blobRef = revision.blobRef;
      existing.currentRevisionId = revision.id;

      this.writeDb(db);
      return this.materializeRecord(existing, blob, revision, this.countRevisions(db.revisions, existing.id));
    }

    const recordId = makeRecordId();
    const revisionId = makeRevisionId();
    const blobRef = defaultBlobRef(recordId);
    const revisionBlobRef = defaultRevisionBlobRef(recordId, revisionId);
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
      blobRef: revisionBlobRef,
      currentRevisionId: revisionId,
    };

    const blob: ArchiveRecordBlob = {
      version: RECORD_BLOB_VERSION,
      id: recordId,
      problem: normalized.problem,
      solution: normalized.solution,
      evidence: normalized.evidence ?? [],
    };

    this.writeRecordBlob(blobRef, blob);
    this.writeRecordBlob(revisionBlobRef, blob);
    db.revisions.push({
      id: revisionId,
      findingId: recordId,
      revision: 1,
      createdAt: now,
      branch: normalized.branch,
      commitSha: normalized.commitSha,
      summary: normalized.summary,
      problemPreview: makePreview(normalized.problem),
      solutionPreview: makePreview(normalized.solution),
      pathId: pathEntry.id,
      path: pathEntry.fullPath,
      labels: normalized.labels ?? [],
      confidence: normalized.confidence as number,
      ttlDays: normalized.ttlDays as number,
      hash,
      source: normalized.source,
      blobRef: revisionBlobRef,
    });
    db.records.push(indexRecord);
    this.writeDb(db);
    return this.materializeRecord(indexRecord, blob, db.revisions[db.revisions.length - 1], 1);
  }

  update(input: ArchiveUpdateInput): ArchiveRecord {
    this.ensureInitialized();
    const db = this.readDb();
    const existing = db.records.find((item) => item.id === input.id);
    if (!existing) {
      throw new Error(`Finding ${input.id} was not found.`);
    }

    const fallbackPath = db.paths.find((item) => item.id === existing.pathId);
    const nextPathId = input.pathId ?? existing.pathId;
    const nextPath = db.paths.find((item) => item.id === nextPathId);
    if (!nextPath) {
      throw new Error(`Unknown pathId ${nextPathId}. Fetch archive_overview first and use an existing path_id.`);
    }

    const currentBlob = this.readRecordBlob(existing.blobRef);
    const summary = typeof input.summary === 'string' && input.summary.trim().length > 0 ? input.summary.trim() : existing.summary;
    const problem = typeof input.problem === 'string' && input.problem.trim().length > 0
      ? input.problem.trim()
      : (currentBlob?.problem || existing.problemPreview);
    const solution = typeof input.solution === 'string' && input.solution.trim().length > 0
      ? input.solution.trim()
      : (currentBlob?.solution || existing.solutionPreview);
    const labels = input.labels || input.tags
      ? dedupeStrings([...(input.labels ?? []), ...(input.tags ?? [])]).map(normalizeLabel).filter((entry) => entry.length > 0).slice(0, 32)
      : existing.labels;
    const evidence = dedupeStrings([
      ...(currentBlob?.evidence ?? []),
      ...(input.evidence ?? []),
    ]).slice(0, 256);
    const confidence = typeof input.confidence === 'number' ? clamp(input.confidence, 0, 1) : existing.confidence;
    const ttlDays = typeof input.ttlDays === 'number' ? Math.max(1, Math.floor(input.ttlDays)) : existing.ttlDays;
    const now = nowIso();
    const hash = stableHashForRecord(
      {
        repo: existing.repo,
        summary,
        problem,
        solution,
        pathId: nextPath.id,
      },
      nextPath.id,
    );

    const nextRevision = this.nextRevisionNumber(db.revisions, existing.id);
    const revisionId = makeRevisionId();
    const revisionBlobRef = defaultRevisionBlobRef(existing.id, revisionId);
    const blob: ArchiveRecordBlob = {
      version: RECORD_BLOB_VERSION,
      id: existing.id,
      problem,
      solution,
      evidence,
    };
    this.writeRecordBlob(revisionBlobRef, blob);

    const revision: ArchiveRecordRevision = {
      id: revisionId,
      findingId: existing.id,
      revision: nextRevision,
      createdAt: now,
      branch: typeof input.branch === 'string' ? input.branch : existing.branch,
      commitSha: typeof input.commitSha === 'string' ? input.commitSha : existing.commitSha,
      summary,
      problemPreview: makePreview(problem),
      solutionPreview: makePreview(solution),
      pathId: nextPath.id,
      path: nextPath.fullPath,
      labels,
      confidence,
      ttlDays,
      hash,
      source: typeof input.source === 'string' ? input.source.trim() : existing.source,
      blobRef: revisionBlobRef,
    };
    db.revisions.push(revision);

    existing.summary = revision.summary;
    existing.problemPreview = revision.problemPreview;
    existing.solutionPreview = revision.solutionPreview;
    existing.branch = revision.branch;
    existing.commitSha = revision.commitSha;
    existing.pathId = revision.pathId || fallbackPath?.id || ROOT_PATH_ID;
    existing.path = revision.path || fallbackPath?.fullPath || '/';
    existing.labels = revision.labels;
    existing.confidence = revision.confidence;
    existing.ttlDays = revision.ttlDays;
    existing.hash = revision.hash;
    existing.source = revision.source;
    existing.updatedAt = now;
    existing.blobRef = revision.blobRef;
    existing.currentRevisionId = revision.id;

    this.writeDb(db);
    return this.materializeRecord(existing, blob, revision, this.countRevisions(db.revisions, existing.id));
  }

  get(findingId: string, revisionId?: string): ArchiveRecord {
    this.ensureInitialized();
    const db = this.readDb();
    const record = db.records.find((item) => item.id === findingId);
    if (!record) {
      throw new Error(`Finding ${findingId} was not found.`);
    }

    const currentRevision = this.resolveRevision(db, record, revisionId);
    const blob = this.readRecordBlob(currentRevision?.blobRef ?? record.blobRef);
    return this.materializeRecord(record, blob, currentRevision, this.countRevisions(db.revisions, record.id));
  }

  listVersions(findingId: string, limit = 25): ArchiveRecordRevisionInfo[] {
    this.ensureInitialized();
    const db = this.readDb();
    const record = db.records.find((item) => item.id === findingId);
    if (!record) {
      throw new Error(`Finding ${findingId} was not found.`);
    }

    const revisions = this.revisionsForFinding(db.revisions, findingId)
      .sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt))
      .slice(0, clamp(limit, 1, 100));

    return revisions.map((revision) => {
      const blob = this.readRecordBlob(revision.blobRef);
      return {
        id: revision.id,
        findingId: revision.findingId,
        revision: revision.revision,
        createdAt: revision.createdAt,
        branch: revision.branch,
        commitSha: revision.commitSha,
        summary: revision.summary,
        problem: blob?.problem ?? revision.problemPreview,
        solution: blob?.solution ?? revision.solutionPreview,
        pathId: revision.pathId,
        path: revision.path,
        labels: revision.labels,
        confidence: revision.confidence,
        ttlDays: revision.ttlDays,
        hash: revision.hash,
        source: revision.source,
        isCurrent: record.currentRevisionId === revision.id,
      };
    });
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
    const revision = this.resolveRevision(db, record);
    const blob = this.readRecordBlob(revision?.blobRef ?? record.blobRef);
    return this.materializeRecord(record, blob, revision, this.countRevisions(db.revisions, record.id));
  }

  private materializeRecord(
    indexRecord: ArchiveIndexRecord,
    blob?: ArchiveRecordBlob,
    revision?: ArchiveRecordRevision,
    revisionCount = 0,
  ): ArchiveRecord {
    const problem = blob?.problem ?? revision?.problemPreview ?? indexRecord.problemPreview;
    const solution = blob?.solution ?? revision?.solutionPreview ?? indexRecord.solutionPreview;
    const evidence = blob?.evidence ?? [];
    return {
      id: indexRecord.id,
      repo: indexRecord.repo,
      branch: revision?.branch ?? indexRecord.branch,
      commitSha: revision?.commitSha ?? indexRecord.commitSha,
      summary: revision?.summary ?? indexRecord.summary,
      problem,
      solution,
      pathId: revision?.pathId ?? indexRecord.pathId,
      path: revision?.path ?? indexRecord.path,
      labels: revision?.labels ?? indexRecord.labels,
      evidence,
      confidence: revision?.confidence ?? indexRecord.confidence,
      createdAt: indexRecord.createdAt,
      updatedAt: revision?.createdAt ?? indexRecord.updatedAt,
      ttlDays: revision?.ttlDays ?? indexRecord.ttlDays,
      useCount: indexRecord.useCount,
      successCount: indexRecord.successCount,
      lastUsedAt: indexRecord.lastUsedAt,
      hash: revision?.hash ?? indexRecord.hash,
      source: revision?.source ?? indexRecord.source,
      revisionId: revision?.id ?? indexRecord.currentRevisionId,
      revision: revision?.revision,
      revisionCreatedAt: revision?.createdAt,
      revisionCount,
    };
  }

  private revisionsForFinding(revisions: ArchiveRecordRevision[], findingId: string): ArchiveRecordRevision[] {
    return revisions.filter((item) => item.findingId === findingId);
  }

  private nextRevisionNumber(revisions: ArchiveRecordRevision[], findingId: string): number {
    const currentMax = this.revisionsForFinding(revisions, findingId)
      .reduce((max, item) => Math.max(max, item.revision), 0);
    return currentMax + 1;
  }

  private countRevisions(revisions: ArchiveRecordRevision[], findingId: string): number {
    return this.revisionsForFinding(revisions, findingId).length;
  }

  private resolveRevision(db: ArchiveDatabase, record: ArchiveIndexRecord, revisionId?: string): ArchiveRecordRevision | undefined {
    const revisions = this.revisionsForFinding(db.revisions, record.id);
    if (revisions.length === 0) {
      return undefined;
    }
    if (revisionId) {
      const explicit = revisions.find((item) => item.id === revisionId);
      if (!explicit) {
        throw new Error(`Revision ${revisionId} was not found for finding ${record.id}.`);
      }
      return explicit;
    }
    if (record.currentRevisionId) {
      const current = revisions.find((item) => item.id === record.currentRevisionId);
      if (current) {
        return current;
      }
    }
    return revisions.slice().sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt))[0];
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
    const revisionsRaw = Array.isArray(parsed.revisions) ? parsed.revisions : [];
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
          currentRevisionId: typeof entry.currentRevisionId === 'string' ? entry.currentRevisionId : undefined,
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

    const recordById = new Map<string, ArchiveIndexRecord>();
    for (const record of normalizedRecords) {
      recordById.set(record.id, record);
    }

    const normalizedRevisions: ArchiveRecordRevision[] = revisionsRaw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => {
        const findingId = typeof entry.findingId === 'string' ? entry.findingId : '';
        const linkedRecord = recordById.get(findingId);
        if (!linkedRecord) {
          return undefined;
        }

        const pathId = typeof entry.pathId === 'string' && pathMap.has(entry.pathId)
          ? entry.pathId
          : linkedRecord.pathId;
        const pathEntry = pathMap.get(pathId);
        const pathValue = typeof entry.path === 'string' && entry.path.length > 0
          ? entry.path
          : (pathEntry?.fullPath ?? linkedRecord.path);
        const labels = Array.isArray(entry.labels)
          ? entry.labels.filter((value): value is string => typeof value === 'string')
          : linkedRecord.labels;
        const normalizedLabels = dedupeStrings(labels).map(normalizeLabel).filter((value) => value.length > 0);
        const summary = typeof entry.summary === 'string' && entry.summary.trim().length > 0
          ? entry.summary.trim()
          : linkedRecord.summary;
        const problemPreview = typeof entry.problemPreview === 'string' && entry.problemPreview.trim().length > 0
          ? makePreview(entry.problemPreview)
          : linkedRecord.problemPreview;
        const solutionPreview = typeof entry.solutionPreview === 'string' && entry.solutionPreview.trim().length > 0
          ? makePreview(entry.solutionPreview)
          : linkedRecord.solutionPreview;
        const hash = typeof entry.hash === 'string' && entry.hash.length > 0
          ? entry.hash
          : linkedRecord.hash;
        const revisionId = typeof entry.id === 'string' ? entry.id : makeRevisionId();
        const blobRef = normalizeBlobRef(
          typeof entry.blobRef === 'string' ? entry.blobRef : linkedRecord.blobRef,
          linkedRecord.id,
        );

        const existingBlob = this.readRecordBlob(blobRef);
        if (!existingBlob) {
          this.writeRecordBlob(blobRef, {
            version: RECORD_BLOB_VERSION,
            id: linkedRecord.id,
            problem: problemPreview,
            solution: solutionPreview,
            evidence: [],
          });
        }

        return {
          id: revisionId,
          findingId,
          revision: typeof entry.revision === 'number' ? Math.max(1, Math.floor(entry.revision)) : 1,
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : linkedRecord.updatedAt,
          branch: typeof entry.branch === 'string' ? entry.branch : linkedRecord.branch,
          commitSha: typeof entry.commitSha === 'string' ? entry.commitSha : linkedRecord.commitSha,
          summary,
          problemPreview,
          solutionPreview,
          pathId,
          path: pathValue,
          labels: normalizedLabels,
          confidence: typeof entry.confidence === 'number' ? clamp(entry.confidence, 0, 1) : linkedRecord.confidence,
          ttlDays: typeof entry.ttlDays === 'number' ? Math.max(1, Math.floor(entry.ttlDays)) : linkedRecord.ttlDays,
          hash,
          source: typeof entry.source === 'string' ? entry.source : linkedRecord.source,
          blobRef,
        } as ArchiveRecordRevision;
      })
      .filter((entry): entry is ArchiveRecordRevision => Boolean(entry));

    for (const record of normalizedRecords) {
      const existing = normalizedRevisions.filter((revision) => revision.findingId === record.id);
      if (existing.length === 0) {
        const legacyBlobRef = normalizeBlobRef(record.blobRef, record.id);
        const legacyBlob = this.readRecordBlob(legacyBlobRef);
        if (!legacyBlob) {
          this.writeRecordBlob(legacyBlobRef, {
            version: RECORD_BLOB_VERSION,
            id: record.id,
            problem: record.problemPreview,
            solution: record.solutionPreview,
            evidence: [],
          });
        }

        normalizedRevisions.push({
          id: makeRevisionId(),
          findingId: record.id,
          revision: 1,
          createdAt: record.createdAt,
          branch: record.branch,
          commitSha: record.commitSha,
          summary: record.summary,
          problemPreview: record.problemPreview,
          solutionPreview: record.solutionPreview,
          pathId: record.pathId,
          path: record.path,
          labels: record.labels,
          confidence: record.confidence,
          ttlDays: record.ttlDays,
          hash: record.hash,
          source: record.source,
          blobRef: legacyBlobRef,
        });
      }
    }

    const revisionsByFinding = new Map<string, ArchiveRecordRevision[]>();
    for (const revision of normalizedRevisions) {
      const list = revisionsByFinding.get(revision.findingId) ?? [];
      list.push(revision);
      revisionsByFinding.set(revision.findingId, list);
    }

    for (const record of normalizedRecords) {
      const revisions = revisionsByFinding.get(record.id) ?? [];
      revisions.sort((a, b) => a.revision - b.revision || a.createdAt.localeCompare(b.createdAt));
      revisions.forEach((revision, idx) => {
        revision.revision = idx + 1;
      });
      if (revisions.length === 0) {
        continue;
      }

      const latest = revisions[revisions.length - 1];
      record.currentRevisionId = revisions.some((entry) => entry.id === record.currentRevisionId)
        ? record.currentRevisionId
        : latest.id;
      const current = revisions.find((entry) => entry.id === record.currentRevisionId) ?? latest;
      record.summary = current.summary;
      record.problemPreview = current.problemPreview;
      record.solutionPreview = current.solutionPreview;
      record.branch = current.branch;
      record.commitSha = current.commitSha;
      record.pathId = current.pathId;
      record.path = current.path;
      record.labels = current.labels;
      record.confidence = current.confidence;
      record.ttlDays = current.ttlDays;
      record.hash = current.hash;
      record.source = current.source;
      record.blobRef = current.blobRef;
      if (record.updatedAt < current.createdAt) {
        record.updatedAt = current.createdAt;
      }
    }

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
      revisions: normalizedRevisions,
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
