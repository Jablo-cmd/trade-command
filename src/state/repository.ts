/**
 * Persistence boundary. The local repository keeps data in this browser only.
 * No credentials are ever part of AppData, so nothing secret is written to storage.
 */
import { emptyData, type AppData } from './model';

export interface Repository {
  readonly kind: 'local' | 'supabase';
  load(): Promise<AppData>;
  save(data: AppData): Promise<void>;
}

export class LocalRepository implements Repository {
  readonly kind = 'local' as const;
  constructor(
    private readonly storage: Storage | undefined = globalThis.localStorage,
    private readonly key = 'trade-command:v1',
  ) {}

  load(): Promise<AppData> {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return Promise.resolve(emptyData());
      const parsed = JSON.parse(raw) as AppData;
      if (parsed.schemaVersion !== 1) return Promise.resolve(emptyData());
      return Promise.resolve({ ...emptyData(), ...parsed, settings: { ...emptyData().settings, ...parsed.settings } });
    } catch (e) {
      console.error('Failed to load local data', e);
      return Promise.resolve(emptyData());
    }
  }

  save(data: AppData): Promise<void> {
    try {
      this.storage?.setItem(this.key, JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save local data', e);
    }
    return Promise.resolve();
  }
}

export class MemoryRepository implements Repository {
  readonly kind = 'local' as const;
  constructor(private data: AppData = emptyData()) {}
  load() {
    return Promise.resolve(structuredClone(this.data));
  }
  save(d: AppData) {
    this.data = structuredClone(d);
    return Promise.resolve();
  }
}
