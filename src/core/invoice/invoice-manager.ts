/**
 * @file majik-invoice-manager.ts
 * @description MajikInvoiceManager — async invoice store backed by a pluggable
 * MajikInvoiceStorageAdapter.
 *
 * Responsibilities:
 *   - Async CRUD backed by whichever adapter is injected (IDB, SQLite, memory)
 *   - In-memory cache (Map) in front of the adapter so reads are instant after
 *     the initial hydrate() call
 *   - Query with filtering, sorting, and pagination — all done in memory on
 *     the cache so the adapter stays simple
 *   - Adapter can be swapped at any time via setAdapter() — migrations are
 *     the caller's responsibility
 *
 * Design:
 *   - Always call hydrate() once after construction to warm the cache from the
 *     adapter. MajikBuwizClient does this automatically in loadState().
 *   - All write methods (save, remove, clear, bulkSave, bulkRemove) write to
 *     both the cache and the adapter atomically from the caller's perspective
 *     (await both in sequence — no partial commit).
 *   - The manager never imports MajikBuwizClient — direction is one-way.
 */

import {
  MajikInvoice,
  MajikInvoiceError,
  type MajikInvoiceJSON,
  type MajikInvoiceMode,
  type MajikInvoiceStatus,
} from "@majikah/majik-invoice";
import { MajikInvoiceStorageAdapter } from "../storage/invoice/_types";
import { InMemoryInvoiceAdapter } from "../storage/invoice/adapter-memory";
import { StorageSource } from "../storage";
import { MajikKey } from "@majikah/majik-key";

// ---------------------------------------------------------------------------
// Query types (re-exported so callers only need one import)
// ---------------------------------------------------------------------------

export interface InvoiceQueryOptions {
  /** Filter by one or more statuses. */
  status?: MajikInvoiceStatus | MajikInvoiceStatus[];
  /** Filter by mode. */
  mode?: MajikInvoiceMode;
  /** Filter by issuerName (exact match against public summary). */
  issuerName?: string;
  /** Filter by recipientName (exact match against public summary). */
  recipientName?: string;
  /**
   * Filter by tag — only works on signed-only or already-decrypted invoices.
   * Encrypted-and-not-decrypted invoices are silently excluded when this
   * filter is active.
   */
  tag?: string;
  /** Sort field — defaults to "createdAt" descending. */
  sortBy?: "createdAt" | "updatedAt" | "total" | "dueDate";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface InvoiceQueryResult {
  items: MajikInvoice[];
  /** Total matching items before pagination. */
  total: number;
  offset: number;
  limit: number;
}

// Add to InvoiceQueryOptions interface
export interface InvoiceDateRangeFilter {
  from?: string; // ISO date string
  to?: string; // ISO date string
}

export interface InvoiceAdvancedQueryOptions extends InvoiceQueryOptions {
  /** Filter by signer public key fingerprint (matches public_key column) */
  publicKey?: string;
  /** Filter out invoices matching this public key */
  excludePublicKey?: string;
  /** Filter by issued_at date range */
  issuedAt?: InvoiceDateRangeFilter;
  /** Filter by created_at date range */
  createdAt?: InvoiceDateRangeFilter;
}

// ---------------------------------------------------------------------------
// MajikInvoiceManager
// ---------------------------------------------------------------------------

export class MajikInvoiceManager {
  /** In-memory cache — warmed by hydrate(), kept in sync on every write. */
  private _cache: Map<string, MajikInvoice> = new Map();
  private _adapter: MajikInvoiceStorageAdapter;

  /**
   * @param adapter — Defaults to InMemoryInvoiceAdapter (non-persistent).
   *                  Pass an IDBInvoiceAdapter or custom implementation for
   *                  persistence.
   */
  constructor(
    adapter: MajikInvoiceStorageAdapter = new InMemoryInvoiceAdapter(),
  ) {
    this._adapter = adapter;
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get adapter(): MajikInvoiceStorageAdapter {
    return this._adapter;
  }

  /**
   * Swap the storage adapter at runtime.
   *
   * This replaces the adapter reference only — it does NOT migrate existing
   * data. If you need to migrate, call toJSON() before swapping, swap the
   * adapter, call hydrate() to warm from the new store, then bulkSave() the
   * old data.
   *
   * Typical migration pattern:
   * ```ts
   * const snapshots = manager.toJSON();
   * manager.setAdapter(new IDBInvoiceAdapter());
   * await manager.hydrate();
   * await manager.bulkSave(snapshots.map(MajikInvoice.fromJSON));
   * ```
   */
  setAdapter(adapter: MajikInvoiceStorageAdapter): void {
    this._adapter = adapter;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Hydrate the in-memory cache from the current adapter.
   *
   * If a MajikKey is provided, only invoices associated with the
   * key fingerprint are loaded.
   *
   * Existing cache contents are replaced only after hydration succeeds.
   * Malformed invoices are skipped silently with a warning.
   */
  async hydrate(key?: MajikKey): Promise<void> {
    const nextCache = new Map<string, MajikInvoice>();

    try {
      const invoices = key?.fingerprint?.trim()
        ? await this.listByPublicKey(key.fingerprint)
        : (await this._adapter.list()).flatMap((json) => {
            try {
              return [MajikInvoice.fromJSON(json)];
            } catch (err) {
              console.warn(
                `MajikInvoiceManager.hydrate: skipping malformed invoice "${json?.id}"`,
                err,
              );
              return [];
            }
          });

      for (const invoice of invoices) {
        nextCache.set(invoice.id, invoice);
      }

      // Only replace cache after successful hydration
      this._cache = nextCache;
    } catch (err) {
      console.error(
        "MajikInvoiceManager.hydrate: failed to hydrate invoices",
        err,
      );

      throw err;
    }
  }
  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Persist a MajikInvoice — upsert semantics on both cache and adapter.
   * Awaits the adapter write before returning.
   */
  async save(invoice: MajikInvoice): Promise<void> {
    const json = invoice.toJSON();
    await this._adapter.save(json);
    this._cache.set(invoice.id, invoice);
  }

  /**
   * Get a stored invoice by ID.
   * Checks cache first; falls back to adapter only if cache miss
   * (should not happen after hydrate() but defensive for safety).
   * Returns undefined if not found.
   */
  async getById(id: string): Promise<MajikInvoice | undefined> {
    const cached = this._cache.get(id);
    if (cached) return cached;

    const json = await this._adapter.getById(id);
    if (!json) return undefined;

    try {
      const invoice = MajikInvoice.fromJSON(json);
      this._cache.set(id, invoice); // warm cache
      return invoice;
    } catch {
      return undefined;
    }
  }

  /**
   * Get a stored invoice by ID.
   * @throws {MajikInvoiceError} if not found.
   */
  async getByIdOrThrow(id: string): Promise<MajikInvoice> {
    const invoice = await this.getById(id);
    if (!invoice) {
      throw new MajikInvoiceError(`Invoice "${id}" not found in store.`);
    }
    return invoice;
  }

  /**
   * Remove a stored invoice by ID.
   * Returns true if it existed and was removed, false if not found.
   */
  async remove(id: string): Promise<boolean> {
    const existed = this._cache.has(id);
    this._cache.delete(id);
    await this._adapter.remove(id);
    return existed;
  }

  /**
   * Remove all stored invoices.
   */
  async clear(): Promise<void> {
    this._cache.clear();
    await this._adapter.clear();
  }

  /**
   * Persist multiple invoices in one call.
   * Uses the adapter's bulkSave() for transactional writes where supported.
   */
  async bulkSave(invoices: MajikInvoice[]): Promise<void> {
    if (invoices.length === 0) return;
    const jsons = invoices.map((inv) => inv.toJSON());
    await this._adapter.bulkSave(jsons);
    for (const inv of invoices) this._cache.set(inv.id, inv);
  }

  /**
   * Remove multiple invoices by ID in one call.
   * Uses the adapter's bulkRemove() for transactional deletes where supported.
   */
  async bulkRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this._adapter.bulkRemove(ids);
    for (const id of ids) this._cache.delete(id);
  }

  // ── Synchronous reads (cache-only) ────────────────────────────────────────
  // These are safe to call after hydrate() without awaiting.

  /**
   * Synchronous cache read — returns undefined if not cached.
   * Prefer getById() when in doubt.
   */
  getCached(id: string): MajikInvoice | undefined {
    return this._cache.get(id);
  }

  /** Whether the cache contains an invoice with this id. */
  has(id: string): boolean {
    return this._cache.has(id);
  }

  /** All cached invoices as an array. */
  listCached(): MajikInvoice[] {
    return Array.from(this._cache.values());
  }

  /** Count of cached invoices. May differ from adapter count before hydrate(). */
  get cachedCount(): number {
    return this._cache.size;
  }

  // ── Async count / exists ──────────────────────────────────────────────────

  /** Total invoice count from the adapter (authoritative). */
  async count(): Promise<number> {
    return this._adapter.count();
  }

  /**
   * Returns the count of invoices matching the given advanced query options.
   * Falls back to in-memory filtering when the adapter doesn't implement countAdvanced().
   */
  async countAdvanced(
    opts: InvoiceAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<number> {
    if (this._adapter.countAdvanced) {
      return this._adapter.countAdvanced(opts, source);
    }
    // Fallback: reuse in-memory advanced query, just count the result
    return (await this._queryAdvancedInMemory(opts)).total;
  }

  /** Whether an invoice with this id exists (checks adapter). */
  async exists(id: string): Promise<boolean> {
    if (this._cache.has(id)) return true;
    return this._adapter.exists(id);
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Query cached invoices with filtering, sorting, and pagination.
   * Operates on the in-memory cache — always call hydrate() first.
   *
   * @example
   *   const { items, total } = manager.query({
   *     status: ["sealed", "unsigned"],
   *     sortBy: "total",
   *     sortDir: "desc",
   *     limit: 10,
   *     offset: 0,
   *   });
   */
  query(opts: InvoiceQueryOptions = {}): InvoiceQueryResult {
    let items = this.listCached();

    // ── Filters ───────────────────────────────────────────────────────────

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((inv) => statuses.includes(inv.integrityStatus));
    }

    if (opts.mode) {
      items = items.filter((inv) => inv.mode === opts.mode);
    }

    if (opts.issuerName) {
      items = items.filter((inv) => inv.public.issuerName === opts.issuerName);
    }

    if (opts.recipientName) {
      items = items.filter(
        (inv) => inv.public.recipientName === opts.recipientName,
      );
    }

    if (opts.tag) {
      const tag = opts.tag;
      items = items.filter((inv) => {
        try {
          return inv.invoice.tags?.includes(tag) ?? false;
        } catch {
          // Encrypted invoice not yet decrypted — skip silently
          return false;
        }
      });
    }

    // ── Sort ──────────────────────────────────────────────────────────────

    const sortBy = opts.sortBy ?? "createdAt";
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;

    items.sort((a, b) => {
      switch (sortBy) {
        case "updatedAt":
          return mult * a.updatedAt.localeCompare(b.updatedAt);
        case "total":
          return (
            mult * ((a.public.totalAmount || 0) - (b.public.totalAmount || 0))
          );
        case "dueDate": {
          const ad = a.public.dueDate ?? "";
          const bd = b.public.dueDate ?? "";
          return mult * ad.localeCompare(bd);
        }
        default: // createdAt
          return mult * a.createdAt.localeCompare(b.createdAt);
      }
    });

    // ── Paginate ──────────────────────────────────────────────────────────

    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? items.length;

    return {
      items: items.slice(offset, offset + limit),
      total,
      offset,
      limit,
    };
  }

  // Add after the existing query() method

  /**
   * Advanced query — supports publicKey, date ranges, mode, status, sort, and
   * pagination. Falls back to in-memory filtering when the adapter doesn't
   * implement queryAdvanced().
   */
  async queryAdvanced(
    opts: InvoiceAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<InvoiceQueryResult> {
    if (this._adapter.queryAdvanced) {
      const jsons = await this._adapter.queryAdvanced(opts, source);
      return {
        items: jsons.map((j) => MajikInvoice.fromJSON(j)),
        total: jsons.length,
        offset: opts.offset ?? 0,
        limit: opts.limit ?? jsons.length,
      };
    }
    // Fallback: in-memory filter on cache
    return this._queryAdvancedInMemory(opts);
  }

  private _queryAdvancedInMemory(
    opts: InvoiceAdvancedQueryOptions,
  ): InvoiceQueryResult {
    let items = this.listCached();

    if (opts.publicKey) {
      items = items.filter((inv) => {
        const json = inv.toJSON();
        const pk =
          json.integrity.allowlistSignerId ??
          json.integrity.signatures[0]?.signerId;
        return pk === opts.publicKey;
      });
    }

    // After the existing opts.publicKey block:
    if (opts.excludePublicKey) {
      const excl = opts.excludePublicKey;
      items = items.filter((inv) => {
        const json = inv.toJSON();
        const pk =
          json.integrity.allowlistSignerId ??
          json.integrity.signatures[0]?.signerId;
        return pk !== excl;
      });
    }

    if (opts.mode) items = items.filter((i) => i.mode === opts.mode);
    if (opts.status) {
      const ss = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((i) => ss.includes(i.integrityStatus));
    }
    if (opts.issuedAt?.from || opts.issuedAt?.to) {
      items = items.filter((inv) => {
        const v = inv.public.issuedAt ?? "";
        if (opts.issuedAt!.from && v < opts.issuedAt!.from) return false;
        if (opts.issuedAt!.to && v > opts.issuedAt!.to) return false;
        return true;
      });
    }
    if (opts.createdAt?.from || opts.createdAt?.to) {
      items = items.filter((inv) => {
        const v = inv.createdAt;
        if (opts.createdAt!.from && v < opts.createdAt!.from) return false;
        if (opts.createdAt!.to && v > opts.createdAt!.to) return false;
        return true;
      });
    }

    // reuse existing sort from query()
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;
    items.sort((a, b) => {
      switch (opts.sortBy) {
        case "dueDate":
          return (
            mult *
            (a.public.dueDate ?? "").localeCompare(b.public.dueDate ?? "")
          );
        case "updatedAt":
          return mult * a.updatedAt.localeCompare(b.updatedAt);
        default:
          return mult * a.createdAt.localeCompare(b.createdAt);
      }
    });

    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? items.length;
    return { items: items.slice(offset, offset + limit), total, offset, limit };
  }

  /** All invoices belonging to a specific account fingerprint. */
  async listByPublicKey(
    publicKey: string,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return (await this.queryAdvanced({ publicKey }, source)).items;
  }

  async listByIssuedAtRange(
    range: InvoiceDateRangeFilter,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return (await this.queryAdvanced({ issuedAt: range }, source)).items;
  }

  async listByCreatedAtRange(
    range: InvoiceDateRangeFilter,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return (await this.queryAdvanced({ createdAt: range }, source)).items;
  }

  async listByMode(
    mode: MajikInvoiceMode,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return (await this.queryAdvanced({ mode }, source)).items;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize all cached invoices to JSON.
   * Used by MajikBuwizClient.toJSON() to embed invoices in the persisted state.
   */
  toJSON(): MajikInvoiceJSON[] {
    return this.listCached().map((inv) => inv.toJSON());
  }

  /**
   * Hydrate a manager from a JSON snapshot, using the provided adapter.
   * Writes all invoices to the adapter and warms the cache.
   *
   * Prefer calling hydrate() on a fresh manager in most cases.
   * Use this when you have a JSON blob and want to bootstrap from it.
   */
  static async fromJSON(
    jsons: MajikInvoiceJSON[],
    adapter: MajikInvoiceStorageAdapter = new InMemoryInvoiceAdapter(),
  ): Promise<MajikInvoiceManager> {
    const manager = new MajikInvoiceManager(adapter);
    const valid: MajikInvoice[] = [];

    for (const json of jsons) {
      try {
        valid.push(MajikInvoice.fromJSON(json));
      } catch (err) {
        console.warn(
          `MajikInvoiceManager.fromJSON: skipping malformed invoice "${json?.id}":`,
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
