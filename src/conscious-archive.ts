import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

const ARCHIVE_DB_VERSION = 1;

export interface ArchiveRecord {
  id: string;
  repo: string;
  branch?: string;
  commitSha?: string;
  summary: string;
  problem: string;
  solution: string;
  evidence: string[];
  tags: string[];
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

export interface ArchiveUsage {
  id: string;
  findingId: string;
  outcome: 'helpful' | 'not_helpful' | 'unknown';
  usedAt: string;
}

interface ArchiveDatabase {
  version: number;
  records: ArchiveRecord[];
  usage: ArchiveUsage[];
}

export interface ArchiveSearchInput {
  query: string;
  repo?: string;
  topK?: number;
  minConfidence?: number;
}

export interface ArchiveSearchHit {
  id: string;
  repo: string;
  summary: string;
  problem: string;
  solution: string;
  tags: string[];
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
  evidence?: string[];
  tags?: string[];
  confidence?: number;
  ttlDays?: number;
  source?: string;
}

export interface ArchivePaths {
  rootDir: string;
  dbPath: string;
  sessionsDir: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_\-/\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stableHashForRecord(input: ArchiveWriteInput): string {
  const data = `${input.repo}\n${input.problem}\n${input.solution}`;
  return hashKey(data.trim());
}

function makeRecordId(): string {
  const ts = Date.now().toString(36);
  const suffix = randomBytes(4).toString('hex');
  return `finding_${ts}_${suffix}`;
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

function isExpired(record: ArchiveRecord): boolean {
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

function defaultDb(): ArchiveDatabase {
  return {
    version: ARCHIVE_DB_VERSION,
    records: [],
    usage: [],
  };
}

export function resolveConsciousPaths(rootDir: string): ArchivePaths {
  return {
    rootDir,
    dbPath: path.join(rootDir, 'archive-db.json'),
    sessionsDir: path.join(rootDir, 'sessions'),
  };
}

export function bootstrapConsciousPaths(rootDir: string): ArchivePaths {
  const paths = resolveConsciousPaths(rootDir);
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  if (!existsSync(paths.dbPath)) {
    writeFileSync(paths.dbPath, `${JSON.stringify(defaultDb(), null, 2)}\n`, 'utf8');
  }
  return paths;
}

export class ConsciousArchiveStore {
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  ensureInitialized(): void {
    const root = path.dirname(this.dbPath);
    mkdirSync(root, { recursive: true });
    if (!existsSync(this.dbPath)) {
      writeFileSync(this.dbPath, `${JSON.stringify(defaultDb(), null, 2)}\n`, 'utf8');
      return;
    }

    const db = this.readDb();
    if (db.version !== ARCHIVE_DB_VERSION) {
      db.version = ARCHIVE_DB_VERSION;
      this.writeDb(db);
    }
  }

  search(input: ArchiveSearchInput): ArchiveSearchHit[] {
    this.ensureInitialized();
    const db = this.readDb();
    const query = input.query.trim();
    const topK = clamp(input.topK ?? 5, 1, 25);
    const minConfidence = clamp(input.minConfidence ?? 0.3, 0, 1);
    const queryTokens = tokenize(query);

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

      const haystack = `${record.summary} ${record.problem} ${record.solution} ${record.tags.join(' ')}`;
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
        problem: record.problem,
        solution: record.solution,
        tags: record.tags,
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
    const normalized: ArchiveWriteInput = {
      ...input,
      summary: input.summary.trim(),
      problem: input.problem.trim(),
      solution: input.solution.trim(),
      confidence: clamp(input.confidence ?? 0.6, 0, 1),
      ttlDays: Math.max(1, Math.floor(input.ttlDays ?? 180)),
      evidence: dedupeStrings((input.evidence ?? []).slice(0, 32)),
      tags: dedupeStrings((input.tags ?? []).slice(0, 32)).map((tag) => tag.toLowerCase()),
      source: input.source?.trim(),
    };

    if (!normalized.repo || !normalized.summary || !normalized.problem || !normalized.solution) {
      throw new Error('archive_write requires repo, summary, problem, and solution.');
    }

    const hash = stableHashForRecord(normalized);
    const now = nowIso();
    const existing = db.records.find((record) => record.hash === hash && record.repo === normalized.repo);

    if (existing) {
      existing.summary = normalized.summary;
      existing.problem = normalized.problem;
      existing.solution = normalized.solution;
      existing.branch = normalized.branch;
      existing.commitSha = normalized.commitSha;
      existing.source = normalized.source;
      existing.ttlDays = normalized.ttlDays as number;
      existing.confidence = Math.max(existing.confidence, normalized.confidence as number);
      existing.evidence = dedupeStrings([...existing.evidence, ...(normalized.evidence ?? [])]).slice(0, 64);
      existing.tags = dedupeStrings([...existing.tags, ...(normalized.tags ?? [])]).slice(0, 32);
      existing.updatedAt = now;
      this.writeDb(db);
      return existing;
    }

    const record: ArchiveRecord = {
      id: makeRecordId(),
      repo: normalized.repo,
      branch: normalized.branch,
      commitSha: normalized.commitSha,
      summary: normalized.summary,
      problem: normalized.problem,
      solution: normalized.solution,
      evidence: normalized.evidence ?? [],
      tags: normalized.tags ?? [],
      confidence: normalized.confidence as number,
      createdAt: now,
      updatedAt: now,
      ttlDays: normalized.ttlDays as number,
      useCount: 0,
      successCount: 0,
      hash,
      source: normalized.source,
    };

    db.records.push(record);
    this.writeDb(db);
    return record;
  }

  markUsed(findingId: string, outcome: 'helpful' | 'not_helpful' | 'unknown'): ArchiveRecord {
    this.ensureInitialized();
    const db = this.readDb();
    const record = db.records.find((item) => item.id === findingId);
    if (!record) {
      throw new Error(`Finding ${findingId} was not found.`);
    }

    record.useCount += 1;
    if (outcome === 'helpful') {
      record.successCount += 1;
    }
    record.lastUsedAt = nowIso();
    record.updatedAt = nowIso();

    db.usage.push({
      id: `usage_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
      findingId,
      outcome,
      usedAt: nowIso(),
    });

    this.writeDb(db);
    return record;
  }

  private readDb(): ArchiveDatabase {
    try {
      const raw = readFileSync(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw) as ArchiveDatabase;
      if (!parsed || !Array.isArray(parsed.records) || !Array.isArray(parsed.usage)) {
        throw new Error('Malformed archive database file.');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Unable to read archive database at ${this.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeDb(db: ArchiveDatabase): void {
    const tmpPath = `${this.dbPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.dbPath);
  }
}
