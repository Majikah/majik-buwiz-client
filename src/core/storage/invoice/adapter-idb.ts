import { MajikInvoiceJSON, MajikInvoiceMode } from "@majikah/majik-invoice";
import { IDBGenericAdapter } from "../idb-adapter";
import { MajikInvoiceStorageAdapter } from "./_types";

import { InvoiceAdvancedQueryOptions, InvoiceDateRangeFilter } from "../../invoice/invoice-manager";

const IDB_DB_NAME = "majik-invoices";
const IDB_STORE_NAME = "invoices";
const IDB_VERSION = 1;

export const IDB_ADAPTER_INVOICE = new IDBGenericAdapter<MajikInvoiceJSON>(
  IDB_DB_NAME,
  IDB_STORE_NAME,
  IDB_VERSION,
);



class IDBInvoiceAdapterExtended implements MajikInvoiceStorageAdapter {
  private base = IDB_ADAPTER_INVOICE;

  // ── delegate all base methods ────────────────────────────────────────────
  save   = this.base.save.bind(this.base);
  getById= this.base.getById.bind(this.base);
  list   = this.base.list.bind(this.base);
  remove = this.base.remove.bind(this.base);
  clear  = this.base.clear.bind(this.base);
  count  = this.base.count.bind(this.base);
  exists = this.base.exists.bind(this.base);
  bulkSave   = this.base.bulkSave.bind(this.base);
  bulkRemove = this.base.bulkRemove.bind(this.base);
  // query      = this.base.query?.bind(this.base);

  // ── advanced query (in-memory filter) ───────────────────────────────────

  private _inRange(value: string | undefined | null, range: InvoiceDateRangeFilter): boolean {
    if (!value) return false;
    if (range.from && value < range.from) return false;
    if (range.to   && value > range.to)   return false;
    return true;
  }

  async queryAdvanced(
    opts: InvoiceAdvancedQueryOptions,
  ): Promise<MajikInvoiceJSON[]> {
    let items = await this.base.list();

    if (opts.publicKey) {
      items = items.filter((inv) =>
        (inv.integrity.allowlistSignerId ?? inv.integrity.signatures[0]?.signerId) === opts.publicKey,
      );
    }
    if (opts.mode) {
      items = items.filter((inv) => inv.mode === opts.mode);
    }
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((inv) => statuses.includes(inv.public.status as any));
    }
    if (opts.issuedAt && (opts.issuedAt.from || opts.issuedAt.to)) {
      items = items.filter((inv) => this._inRange(inv.public.issuedAt, opts.issuedAt!));
    }
    if (opts.createdAt && (opts.createdAt.from || opts.createdAt.to)) {
      items = items.filter((inv) => this._inRange(inv.created_at, opts.createdAt!));
    }

    // sort
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;
    items.sort((a, b) => {
      const av = opts.sortBy === "dueDate" ? (a.public.dueDate ?? "") : a.created_at;
      const bv = opts.sortBy === "dueDate" ? (b.public.dueDate ?? "") : b.created_at;
      return mult * av.localeCompare(bv);
    });

    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit)  items = items.slice(0, opts.limit);

    return items;
  }

  async listByPublicKey(publicKey: string) {
    return this.queryAdvanced({ publicKey });
  }
  async listByIssuedAtRange(range: InvoiceDateRangeFilter) {
    return this.queryAdvanced({ issuedAt: range });
  }
  async listByCreatedAtRange(range: InvoiceDateRangeFilter) {
    return this.queryAdvanced({ createdAt: range });
  }
  async listByMode(mode: MajikInvoiceMode) {
    return this.queryAdvanced({ mode });
  }
}

export const IDB_ADAPTER_INVOICE_EXTENDED = new IDBInvoiceAdapterExtended();