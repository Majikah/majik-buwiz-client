/**
 * @file expense-manager.ts
 * @description ExpenseManager — async ExpenseRecord store backed by a
 * pluggable ExpenseRecordStorageAdapter.
 *
 * Responsibilities:
 *   - Async CRUD backed by whichever adapter is injected (IDB, SQLite, memory)
 *   - In-memory cache (Map) in front of the adapter so reads are instant after
 *     the initial hydrate() call
 *   - Query with filtering, sorting, and pagination — done in-memory on the
 *     cache when the adapter doesn't implement queryAdvanced()
 *   - Adapter can be swapped at runtime via setAdapter()
 *
 * Design mirrors MajikInvoiceManager:
 *   - Always call hydrate() once after construction to warm the cache
 *   - All write methods (save, remove, clear, bulkSave, bulkRemove) write to
 *     both the cache and the adapter in sequence
 *   - Manager stays decoupled from RecurringExpenseManager — wiring is the
 *     caller's responsibility in the bootstrapper
 *
 * The duplicate actualization check for recurring expenses is done here via
 * findByActualizationKey(itemId, month) — RecurringExpenseManager calls this
 * instead of maintaining a separate log adapter.
 */

import { ExpenseRecordStorageAdapter } from "../storage/expense/expense-records/_types";
import { InMemoryExpenseRecordAdapter } from "../storage/expense/expense-records/adapter-memory";
import { ExpenseRecordError } from "./errors";
import { ExpenseRecord } from "./expense-record";

import type {
  DateRangeFilter,
  ExpenseAdvancedQueryOptions,
  ExpenseCategory,
  ExpenseQueryOptions,
  ExpenseQueryResult,
  ExpenseRecordJSON,
} from "./types";

// =============================================================================
// ── ExpenseManager ────────────────────────────────────────────────────────────
// =============================================================================

export class ExpenseManager {
  /** In-memory cache — warmed by hydrate(), kept in sync on every write */
  private _cache: Map<string, ExpenseRecord> = new Map();
  private _adapter: ExpenseRecordStorageAdapter;

  constructor(
    adapter: ExpenseRecordStorageAdapter = new InMemoryExpenseRecordAdapter(),
  ) {
    this._adapter = adapter;
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get adapter(): ExpenseRecordStorageAdapter {
    return this._adapter;
  }

  /**
   * Swap the storage adapter at runtime.
   *
   * Does NOT migrate existing data — caller is responsible.
   * Typical migration pattern:
   * ```ts
   * const snapshots = manager.toJSON();
   * manager.setAdapter(new IDBExpenseRecordAdapter());
   * await manager.hydrate();
   * await manager.bulkSave(snapshots.map(ExpenseRecord.fromJSON));
   * ```
   */
  setAdapter(adapter: ExpenseRecordStorageAdapter): void {
    this._adapter = adapter;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Hydrate the in-memory cache from the current adapter.
   * Existing cache contents are replaced only after hydration succeeds.
   * Malformed records are skipped with a warning.
   */
  async hydrate(): Promise<void> {
    const nextCache = new Map<string, ExpenseRecord>();

    try {
      const jsons = await this._adapter.list();

      for (const json of jsons) {
        try {
          nextCache.set(json.id, ExpenseRecord.fromJSON(json));
        } catch (err) {
          console.warn(
            `ExpenseManager.hydrate: skipping malformed record "${json?.id}"`,
            err,
          );
        }
      }

      this._cache = nextCache;
    } catch (err) {
      console.error("ExpenseManager.hydrate: failed to hydrate records", err);
      throw err;
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Persist an ExpenseRecord — upsert semantics on both cache and adapter.
   * Awaits the adapter write before returning.
   */
  async save(record: ExpenseRecord): Promise<void> {
    await this._adapter.save(record.toJSON());
    this._cache.set(record.id, record);
  }

  /**
   * Get a stored record by ID.
   * Checks cache first; falls back to adapter on cache miss.
   * Returns undefined if not found.
   */
  async getById(id: string): Promise<ExpenseRecord | undefined> {
    const cached = this._cache.get(id);
    if (cached) return cached;

    const json = await this._adapter.getById(id);
    if (!json) return undefined;

    try {
      const record = ExpenseRecord.fromJSON(json);
      this._cache.set(id, record); // warm cache
      return record;
    } catch {
      return undefined;
    }
  }

  /**
   * @throws {ExpenseRecordError} if not found
   */
  async getByIdOrThrow(id: string): Promise<ExpenseRecord> {
    const record = await this.getById(id);
    if (!record) {
      throw new ExpenseRecordError(`ExpenseRecord "${id}" not found in store.`);
    }
    return record;
  }

  /**
   * Remove a stored record by ID.
   * Returns true if it existed and was removed, false if not found.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this._cache.has(id);
    this._cache.delete(id);
    await this._adapter.remove(id);
    return existed;
  }

  /** Remove all stored records */
  async clear(): Promise<void> {
    this._cache.clear();
    await this._adapter.clear();
  }

  /** Persist multiple records in one call */
  async bulkSave(records: ExpenseRecord[]): Promise<void> {
    if (records.length === 0) return;
    const jsons = records.map((r) => r.toJSON());
    if (this._adapter.bulkSave) {
      await this._adapter.bulkSave(jsons);
    } else {
      for (const json of jsons) await this._adapter.save(json);
    }
    for (const record of records) this._cache.set(record.id, record);
  }

  /** Remove multiple records by ID in one call */
  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this._adapter.bulkRemove) {
      await this._adapter.bulkRemove(ids);
    } else {
      for (const id of ids) await this._adapter.remove(id);
    }
    for (const id of ids) this._cache.delete(id);
  }

  // ── Synchronous cache reads ───────────────────────────────────────────────

  getCached(id: string): ExpenseRecord | undefined {
    return this._cache.get(id);
  }

  has(id: string): boolean {
    return this._cache.has(id);
  }

  listCached(): ExpenseRecord[] {
    return Array.from(this._cache.values());
  }

  get cachedCount(): number {
    return this._cache.size;
  }

  // ── Async count / exists ──────────────────────────────────────────────────

  async count(): Promise<number> {
    return this._adapter.count();
  }

  async exists(id: string): Promise<boolean> {
    if (this._cache.has(id)) return true;
    return this._adapter.exists(id);
  }

  // ==========================================================================
  // ── QUERY ──────────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Query cached records with filtering, sorting, and pagination.
   * Operates on the in-memory cache — always call hydrate() first.
   *
   * @example
   *   const { items, total } = manager.query({
   *     status: "approved",
   *     sortBy: "expenseDate",
   *     sortDir: "desc",
   *     limit: 20,
   *     offset: 0,
   *   });
   */
  query(opts: ExpenseQueryOptions = {}): ExpenseQueryResult {
    let items = this.listCached();

    // ── Filters ───────────────────────────────────────────────────────────

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((r) => statuses.includes(r.status));
    }

    if (opts.documentType) {
      items = items.filter((r) => r.documentType === opts.documentType);
    }

    if (opts.payeeName) {
      items = items.filter((r) => r.payee.legalName === opts.payeeName);
    }

    if (opts.paidByName) {
      items = items.filter((r) => r.paidBy.legalName === opts.paidByName);
    }

    if (opts.currency) {
      items = items.filter((r) => r.currency === opts.currency);
    }

    // ── Sort ──────────────────────────────────────────────────────────────

    const sortBy = opts.sortBy ?? "expenseDate";
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;

    items.sort((a, b) => {
      switch (sortBy) {
        case "totalAmount":
          return mult * (a.totalAmount - b.totalAmount);
        case "updatedAt":
          return mult * a.updatedAt.localeCompare(b.updatedAt);
        case "createdAt":
          return mult * a.createdAt.localeCompare(b.createdAt);
        default: // expenseDate
          return mult * a.expenseDate.localeCompare(b.expenseDate);
      }
    });

    // ── Paginate ──────────────────────────────────────────────────────────

    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? items.length;

    return { items: items.slice(offset, offset + limit), total, offset, limit };
  }

  /**
   * Advanced query — supports date ranges, tags, and recurring metadata fields.
   * Falls back to in-memory filtering when the adapter doesn't implement
   * queryAdvanced().
   */
  async queryAdvanced(
    opts: ExpenseAdvancedQueryOptions,
  ): Promise<ExpenseQueryResult> {
    if (this._adapter.queryAdvanced) {
      const jsons = await this._adapter.queryAdvanced(opts);
      const items = jsons.map((j) => ExpenseRecord.fromJSON(j));
      return {
        items,
        total: items.length,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? items.length,
      };
    }

    return this._queryAdvancedInMemory(opts);
  }

  async countAdvanced(opts: ExpenseAdvancedQueryOptions): Promise<number> {
    if (this._adapter.countAdvanced) {
      return this._adapter.countAdvanced(opts);
    }
    return this._queryAdvancedInMemory(opts).total;
  }

  private _queryAdvancedInMemory(
    opts: ExpenseAdvancedQueryOptions,
  ): ExpenseQueryResult {
    let items = this.listCached();

    // ── Base filters (from ExpenseQueryOptions) ───────────────────────────

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((r) => statuses.includes(r.status));
    }

    if (opts.documentType) {
      items = items.filter((r) => r.documentType === opts.documentType);
    }

    if (opts.payeeName) {
      items = items.filter((r) => r.payee.legalName === opts.payeeName);
    }

    if (opts.paidByName) {
      items = items.filter((r) => r.paidBy.legalName === opts.paidByName);
    }

    if (opts.currency) {
      items = items.filter((r) => r.currency === opts.currency);
    }

    // ── Advanced date range filters ───────────────────────────────────────

    if (opts.expenseDate?.from || opts.expenseDate?.to) {
      items = items.filter((r) => {
        if (opts.expenseDate!.from && r.expenseDate < opts.expenseDate!.from)
          return false;
        if (opts.expenseDate!.to && r.expenseDate > opts.expenseDate!.to)
          return false;
        return true;
      });
    }

    if (opts.createdAt?.from || opts.createdAt?.to) {
      items = items.filter((r) => {
        if (opts.createdAt!.from && r.createdAt < opts.createdAt!.from)
          return false;
        if (opts.createdAt!.to && r.createdAt > opts.createdAt!.to)
          return false;
        return true;
      });
    }

    if (opts.paidAt?.from || opts.paidAt?.to) {
      items = items.filter((r) => {
        if (!r.paidAt) return false;
        if (opts.paidAt!.from && r.paidAt < opts.paidAt!.from) return false;
        if (opts.paidAt!.to && r.paidAt > opts.paidAt!.to) return false;
        return true;
      });
    }

    // ── Tag filter ────────────────────────────────────────────────────────

    if (opts.tag) {
      const tag = opts.tag;
      items = items.filter((r) => r.tags?.includes(tag) ?? false);
    }

    // ── Recurring metadata filters ────────────────────────────────────────
    // These check the metadata fields stamped by RecurringExpenseItem.toRecord()

    if (opts.recurringId) {
      const rid = opts.recurringId;
      items = items.filter((r) => r.recurringId === rid);
    }

    if (opts.actualizationMonth) {
      const month = opts.actualizationMonth;
      items = items.filter((r) => r.metadata?.actualizationMonth === month);
    }

    // ── Sort ──────────────────────────────────────────────────────────────

    const sortBy = opts.sortBy ?? "expenseDate";
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;

    items.sort((a, b) => {
      switch (sortBy) {
        case "totalAmount":
          return mult * (a.totalAmount - b.totalAmount);
        case "updatedAt":
          return mult * a.updatedAt.localeCompare(b.updatedAt);
        case "createdAt":
          return mult * a.createdAt.localeCompare(b.createdAt);
        default:
          return mult * a.expenseDate.localeCompare(b.expenseDate);
      }
    });

    // ── Paginate ──────────────────────────────────────────────────────────

    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? items.length;

    return { items: items.slice(offset, offset + limit), total, offset, limit };
  }

  /** All expenses belonging to a specific account fingerprint. */
  async listByPublicKey(publicKey: string): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ publicKey })).items;
  }

  async listByCreatedAtRange(range: DateRangeFilter): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ createdAt: range })).items;
  }

  async listByCategory(category: ExpenseCategory): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ category })).items;
  }

  // ==========================================================================
  // ── RECURRING EXPENSE HELPERS ──────────────────────────────────────────────
  // ==========================================================================

  /**
   * Check whether a recurring expense item has already been actualized
   * for a specific month.
   *
   * Called by RecurringExpenseManager instead of a separate log adapter.
   * Checks metadata.recurringExpenseItemId and metadata.actualizationMonth
   * on cached records — O(n) on cache, but fast after hydrate().
   *
   * @param itemId - The RecurringExpenseItem id
   * @param month  - YYYY-MM string
   */
  isActualized(itemId: string, month: string): boolean {
    for (const record of this._cache.values()) {
      if (
        record.metadata?.recurringExpenseItemId === itemId &&
        record.metadata?.actualizationMonth === month
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find the ExpenseRecord produced for a specific (itemId, month) pair.
   * Returns undefined if not found.
   */
  findByActualizationKey(
    itemId: string,
    month: string,
  ): ExpenseRecord | undefined {
    for (const record of this._cache.values()) {
      if (
        record.metadata?.recurringExpenseItemId === itemId &&
        record.metadata?.actualizationMonth === month
      ) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * List all ExpenseRecords produced from a given RecurringExpenseItem,
   * sorted by actualizationMonth ascending.
   */
  listByRecurringItemId(itemId: string): ExpenseRecord[] {
    return this.listCached()
      .filter((r) => r.metadata?.recurringExpenseItemId === itemId)
      .sort((a, b) => {
        const ma = (a.metadata?.actualizationMonth as string) ?? "";
        const mb = (b.metadata?.actualizationMonth as string) ?? "";
        return ma.localeCompare(mb);
      });
  }

  // ==========================================================================
  // ── CONVENIENCE QUERY SHORTCUTS ────────────────────────────────────────────
  // ==========================================================================

  async listByExpenseDateRange(
    range: DateRangeFilter,
  ): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ expenseDate: range })).items;
  }

  async listByPaidAtRange(range: DateRangeFilter): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ paidAt: range })).items;
  }

  async listByPayee(payeeName: string): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ payeeName })).items;
  }

  async listByTag(tag: string): Promise<ExpenseRecord[]> {
    return (await this.queryAdvanced({ tag })).items;
  }

  // ==========================================================================
  // ── SERIALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  toJSON(): ExpenseRecordJSON[] {
    return this.listCached().map((r) => r.toJSON());
  }

  static async fromJSON(
    jsons: ExpenseRecordJSON[],
    adapter: ExpenseRecordStorageAdapter = new InMemoryExpenseRecordAdapter(),
  ): Promise<ExpenseManager> {
    const manager = new ExpenseManager(adapter);
    const valid: ExpenseRecord[] = [];

    for (const json of jsons) {
      try {
        valid.push(ExpenseRecord.fromJSON(json));
      } catch (err) {
        console.warn(
          `ExpenseManager.fromJSON: skipping malformed record "${json?.id}":`,
          err,
        );
      }
    }

    if (valid.length > 0) {
      await manager.bulkSave(valid);
    }

    return manager;
  }
}
