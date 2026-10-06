/**
 * @file recurring-expense-manager.ts
 * @description RecurringExpenseManager — adapter-backed store for
 * RecurringExpenseItem templates.
 *
 * Duplicate actualization detection:
 *   No separate log adapter. Instead the caller provides an isActualized()
 *   callback that delegates to ExpenseManager.isActualized(itemId, month).
 *   This avoids redundant storage while keeping the two managers decoupled.
 *
 * Wiring in bootstrapper:
 * ```ts
 * const expenseManager = new ExpenseManager(sqliteAdapter);
 * const recurringManager = new RecurringExpenseManager(itemAdapter);
 *
 * await expenseManager.hydrate();
 * await recurringManager.hydrate();
 *
 * const result = await recurringManager.actualize(
 *   "item-id",
 *   {
 *     saveRecord: (r) => expenseManager.save(r),
 *     isActualized: (itemId, month) => expenseManager.isActualized(itemId, month),
 *   },
 *   { month: "2025-06" },
 * );
 * ```
 */

import { ExpenseRecord } from "./expense-record";
import type { ExpenseRecordJSON } from "./types";
import type {
  ActualizationMonth,
  ActualizationResult,
  ActualizeOptions,
  RecurringExpenseItemJSON,
  RecurringExpenseItemQueryOptions,
  RecurringExpenseItemQueryResult,
} from "./recurring/types";
import { RecurringExpenseItem } from "./recurring/recurring-expense";
import {
  ActualizationConflictError,
  RecurringExpenseItemError,
} from "./recurring/errors";
import { RecurringExpenseItemStorageAdapter } from "../storage/expense/recurring/_types";
import { InMemoryRecurringExpenseItemAdapter } from "../storage/expense/recurring/adapter-memory";

// =============================================================================
// ── ACTUALIZE CALLBACKS ───────────────────────────────────────────────────────
// =============================================================================

/**
 * Callbacks passed to actualize() and actualizeAll().
 * Kept separate from ActualizeOptions so options stay serializable
 * and callbacks are clearly a runtime wiring concern.
 */
export interface ActualizeCallbacks {
  /**
   * Persist each produced ExpenseRecord.
   * Wire to ExpenseManager.save().
   */
  saveRecord: (record: ExpenseRecord) => Promise<void>;

  /**
   * Check whether (itemId, month) has already been actualized.
   * Wire to ExpenseManager.isActualized() — synchronous, cache-only.
   */
  isActualized: (itemId: string, month: ActualizationMonth) => boolean;
}

// =============================================================================
// ── RecurringExpenseManager ───────────────────────────────────────────────────
// =============================================================================

export class RecurringExpenseManager {
  private _cache = new Map<string, RecurringExpenseItem>();
  private _itemAdapter: RecurringExpenseItemStorageAdapter;

  constructor(
    itemAdapter: RecurringExpenseItemStorageAdapter = new InMemoryRecurringExpenseItemAdapter(),
  ) {
    this._itemAdapter = itemAdapter;
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get itemAdapter(): RecurringExpenseItemStorageAdapter {
    return this._itemAdapter;
  }

  setItemAdapter(adapter: RecurringExpenseItemStorageAdapter): void {
    this._itemAdapter = adapter;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Warm the in-memory cache from the item adapter.
   * Auto-transitions items whose schedule.endDate has passed to "ended"
   * and persists the transition back to the adapter.
   * Malformed items are skipped with a warning.
   */
  async hydrate(): Promise<void> {
    const nextCache = new Map<string, RecurringExpenseItem>();
    const today = new Date().toISOString().slice(0, 10);

    let rawItems: RecurringExpenseItemJSON[];
    try {
      rawItems = await this._itemAdapter.list();
    } catch (err) {
      console.error(
        "RecurringExpenseManager.hydrate: failed to list items",
        err,
      );
      throw err;
    }

    for (const json of rawItems) {
      try {
        let item = RecurringExpenseItem.fromJSON(json);

        if (
          item.status !== "ended" &&
          item.schedule.endDate &&
          today > item.schedule.endDate
        ) {
          item = item.end();
          await this._itemAdapter.save(item.toJSON());
        }

        nextCache.set(item.id, item);
      } catch (err) {
        console.warn(
          `RecurringExpenseManager.hydrate: skipping malformed item "${json?.id}"`,
          err,
        );
      }
    }

    this._cache = nextCache;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async save(item: RecurringExpenseItem): Promise<void> {
    await this._itemAdapter.save(item.toJSON());
    this._cache.set(item.id, item);
  }

  async getById(id: string): Promise<RecurringExpenseItem | null> {
    const cached = this._cache.get(id);
    if (cached) return cached;

    const json = await this._itemAdapter.getById(id);
    if (!json) return null;

    try {
      const item = RecurringExpenseItem.fromJSON(json);
      this._cache.set(id, item);
      return item;
    } catch {
      return null;
    }
  }

  /** @throws {RecurringExpenseItemError} if not found */
  async getByIdOrThrow(id: string): Promise<RecurringExpenseItem> {
    const item = await this.getById(id);
    if (!item) {
      throw new RecurringExpenseItemError(
        `Recurring expense item "${id}" not found.`,
        "id",
      );
    }
    return item;
  }

  async remove(id: string): Promise<boolean> {
    const existed = this._cache.has(id);
    this._cache.delete(id);
    await this._itemAdapter.remove(id);
    return existed;
  }

  async clear(): Promise<void> {
    this._cache.clear();
    await this._itemAdapter.clear();
  }

  async bulkSave(items: RecurringExpenseItem[]): Promise<void> {
    if (items.length === 0) return;
    const jsons = items.map((i) => i.toJSON());
    if (this._itemAdapter.bulkSave) {
      await this._itemAdapter.bulkSave(jsons);
    } else {
      for (const json of jsons) await this._itemAdapter.save(json);
    }
    for (const item of items) this._cache.set(item.id, item);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this._itemAdapter.bulkRemove) {
      await this._itemAdapter.bulkRemove(ids);
    } else {
      for (const id of ids) await this._itemAdapter.remove(id);
    }
    for (const id of ids) this._cache.delete(id);
  }

  // ── Synchronous cache reads ───────────────────────────────────────────────

  getCached(id: string): RecurringExpenseItem | undefined {
    return this._cache.get(id);
  }

  has(id: string): boolean {
    return this._cache.has(id);
  }

  listCached(): RecurringExpenseItem[] {
    return Array.from(this._cache.values());
  }

  get cachedCount(): number {
    return this._cache.size;
  }

  async count(): Promise<number> {
    return this._itemAdapter.count();
  }

  async exists(id: string): Promise<boolean> {
    if (this._cache.has(id)) return true;
    return this._itemAdapter.exists(id);
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  query(
    opts: RecurringExpenseItemQueryOptions = {},
  ): RecurringExpenseItemQueryResult {
    let items = this.listCached();

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((i) => statuses.includes(i.status));
    }
    if (opts.frequency) {
      items = items.filter((i) => i.frequency === opts.frequency);
    }
    if (opts.payeeName) {
      items = items.filter((i) => i.payee.legalName === opts.payeeName);
    }
    if (opts.paidByName) {
      items = items.filter((i) => i.paidBy.legalName === opts.paidByName);
    }

    const sortBy = opts.sortBy ?? "createdAt";
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;

    items.sort((a, b) => {
      switch (sortBy) {
        case "name":
          return mult * a.name.localeCompare(b.name);
        case "amount":
          return mult * (a.amount - b.amount);
        case "startDate":
          return (
            mult * a.schedule.startDate.localeCompare(b.schedule.startDate)
          );
        default:
          return mult * a.createdAt.localeCompare(b.createdAt);
      }
    });

    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? items.length;

    return {
      items: items.slice(offset, offset + limit).map((i) => i.toJSON()),
      total,
      offset,
      limit,
    };
  }

  listActive(): RecurringExpenseItem[] {
    return this.listCached().filter((i) => i.isActive);
  }

  listEnded(): RecurringExpenseItem[] {
    return this.listCached().filter((i) => i.isEnded);
  }

  listPaused(): RecurringExpenseItem[] {
    return this.listCached().filter((i) => i.isPaused);
  }

  // ── Status transition convenience wrappers ────────────────────────────────

  async pause(id: string): Promise<RecurringExpenseItem> {
    const item = await this.getByIdOrThrow(id);
    const updated = item.pause();
    await this.save(updated);
    return updated;
  }

  async resume(id: string): Promise<RecurringExpenseItem> {
    const item = await this.getByIdOrThrow(id);
    const updated = item.resume();
    await this.save(updated);
    return updated;
  }

  async end(id: string): Promise<RecurringExpenseItem> {
    const item = await this.getByIdOrThrow(id);
    const updated = item.end();
    await this.save(updated);
    return updated;
  }

  // ==========================================================================
  // ── ACTUALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Actualize a single RecurringExpenseItem for a specific month or range.
   *
   * For each eligible month:
   *   1. callbacks.isActualized(itemId, month) — sync check against
   *      ExpenseManager cache. Skip or throw depending on strict mode.
   *   2. item.toRecord(month, options) — produce a draft ExpenseRecord
   *   3. callbacks.saveRecord(record) — persist it via ExpenseManager
   *
   * @param itemId    - The RecurringExpenseItem to actualize
   * @param callbacks - saveRecord + isActualized wired to ExpenseManager
   * @param options   - Month or range, strict mode, BIR overrides, etc.
   */
  async actualize(
    itemId: string,
    callbacks: ActualizeCallbacks,
    options: ActualizeOptions = {},
  ): Promise<ActualizationResult> {
    const item = await this.getByIdOrThrow(itemId);
    const months = this._resolveMonths(item, options);
    return this._actualizeMonths(item, months, callbacks, options);
  }

  /**
   * Actualize all active items for a specific month or range.
   * Paused and ended items contribute to result.ineligible.
   * Returns a map of itemId → ActualizationResult.
   */
  async actualizeAll(
    callbacks: ActualizeCallbacks,
    options: ActualizeOptions = {},
  ): Promise<Map<string, ActualizationResult>> {
    const results = new Map<string, ActualizationResult>();

    for (const item of this.listCached()) {
      if (!item.isActive) {
        const months = this._resolveMonthsRaw(options);
        results.set(item.id, {
          created: [],
          skipped: [],
          ineligible: months,
          total: months.length,
        });
        continue;
      }

      const result = await this.actualize(item.id, callbacks, options);
      results.set(item.id, result);
    }

    return results;
  }

  // ==========================================================================
  // ── PRIVATE: ACTUALIZATION CORE ────────────────────────────────────────────
  // ==========================================================================

  private async _actualizeMonths(
    item: RecurringExpenseItem,
    months: ActualizationMonth[],
    callbacks: ActualizeCallbacks,
    options: ActualizeOptions,
  ): Promise<ActualizationResult> {
    const strict = options.strict ?? false;

    const created: ExpenseRecordJSON[] = [];
    const skipped: ActualizationMonth[] = [];
    const ineligible: ActualizationMonth[] = [];

    for (const month of months) {
      if (!item.isActive) {
        ineligible.push(month);
        continue;
      }

      // ── Duplicate check via ExpenseManager callback (sync) ─────────────
      const alreadyDone = callbacks.isActualized(item.id, month);
      if (alreadyDone) {
        if (strict) throw new ActualizationConflictError(item.id, month);
        skipped.push(month);
        continue;
      }

      // ── Materialize ────────────────────────────────────────────────────
      let record: ExpenseRecord;
      try {
        record = item.toRecord(month, {
          bir: options.bir,
          tags: options.tags,
          metadata: options.metadata,
          expenseDate: options.expenseDate,
        });
      } catch (err) {
        if (strict) throw err;
        ineligible.push(month);
        console.warn(
          `RecurringExpenseManager: skipping "${item.id}" for "${month}":`,
          err,
        );
        continue;
      }

      // ── Persist ────────────────────────────────────────────────────────
      await callbacks.saveRecord(record);
      created.push(record.toJSON());
    }

    return { created, skipped, ineligible, total: months.length };
  }

  // ── Month resolution ──────────────────────────────────────────────────────

  private _resolveMonths(
    item: RecurringExpenseItem,
    options: ActualizeOptions,
  ): ActualizationMonth[] {
    if (options.range) {
      return item.eligibleMonthsInRange(options.range.from, options.range.to);
    }

    const month = options.month ?? new Date().toISOString().slice(0, 7);
    RecurringExpenseItem.assertValidMonth(month);

    // For single-month actualization, bypass frequency eligibility check.
    // eligibleMonthsInRange would silently return [] for non-monthly frequencies
    // (e.g. annual item actualized in a non-anchor month). toRecord() already
    // enforces startDate/endDate bounds — frequency alignment is the caller's
    // responsibility when specifying an explicit month.
    const startMonth = item.schedule.startDate.slice(0, 7);
    const endMonth = item.schedule.endDate?.slice(0, 7);

    if (month < startMonth) return [];
    if (endMonth && month > endMonth) return [];

    return [month];
  }
  private _resolveMonthsRaw(options: ActualizeOptions): ActualizationMonth[] {
    if (options.range) {
      const months: ActualizationMonth[] = [];
      let current = options.range.from;
      while (current <= options.range.to) {
        months.push(current);
        current = RecurringExpenseManager._offsetMonth(current, 1);
      }
      return months;
    }
    return [options.month ?? new Date().toISOString().slice(0, 7)];
  }

  private static _offsetMonth(
    month: ActualizationMonth,
    offset: number,
  ): ActualizationMonth {
    const [y, m] = month.split("-").map(Number);
    const total = (y - 1) * 12 + m + offset;
    const newYear = Math.floor((total - 1) / 12) + 1;
    const newMonth = ((total - 1) % 12) + 1;
    return `${newYear}-${String(newMonth).padStart(2, "0")}`;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): RecurringExpenseItemJSON[] {
    return this.listCached().map((i) => i.toJSON());
  }

  static async fromJSON(
    jsons: RecurringExpenseItemJSON[],
    itemAdapter: RecurringExpenseItemStorageAdapter = new InMemoryRecurringExpenseItemAdapter(),
  ): Promise<RecurringExpenseManager> {
    const manager = new RecurringExpenseManager(itemAdapter);
    const valid: RecurringExpenseItem[] = [];

    for (const json of jsons) {
      try {
        valid.push(RecurringExpenseItem.fromJSON(json));
      } catch (err) {
        console.warn(
          `RecurringExpenseManager.fromJSON: skipping malformed item "${json?.id}":`,
          err,
        );
      }
    }

    if (valid.length > 0) await manager.bulkSave(valid);
    return manager;
  }
}
