import type { MemoryRecord, MemoryRetrievalInput, MemoryRetrievalResult } from '../domain/memory.js';
export interface MemoryStorePort {
  create(record: MemoryRecord): Promise<void>;
  update(record: MemoryRecord): Promise<void>;
  get(memoryId: string, version?: number | null): Promise<MemoryRecord | null>;
  listVersions(memoryId: string): Promise<readonly MemoryRecord[]>;
  listRecent(limit: number): Promise<readonly MemoryRecord[]>;
  listAll(): Promise<readonly MemoryRecord[]>;
  retrieve?(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult>;
}
