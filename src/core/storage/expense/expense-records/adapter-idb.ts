import { ExpenseRecordStorageAdapter } from "./_types";
import { IDBGenericAdapter } from "../../idb-adapter";
import {
  DateRangeFilter,
  ExpenseAdvancedQueryOptions,
  ExpenseRecordJSON,
} from "../../../expenses/types";

const IDB_DB_NAME = "majik-buwiz";
const IDB_STORE_NAME = "expense-records";
const IDB_VERSION = 1;

export const IDB_ADAPTER_EXPENSE_RECORDS =
  new IDBGenericAdapter<ExpenseRecordJSON>(
    IDB_DB_NAME,
    IDB_STORE_NAME,
    IDB_VERSION,
  );

class IDBExpenseRecordAdapterExtended implements ExpenseRecordStorageAdapter {
  private base = IDB_ADAPTER_EXPENSE_RECORDS;

  // ── delegate all base methods ────────────────────────────────────────────
  save = this.base.save.bind(this.base);
  getById = this.base.getById.bind(this.base);
  list = this.base.list.bind(this.base);
  remove = this.base.remove.bind(this.base);
  clear = this.base.clear.bind(this.base);
  count = this.base.count.bind(this.base);
  exists = this.base.exists.bind(this.base);
  bulkSave = this.base.bulkSave.bind(this.base);
  bulkRemove = this.base.bulkRemove.bind(this.base);
  // query      = this.base.query?.bind(this.base);

  // ── advanced query (in-memory filter) ───────────────────────────────────

  private _inRange(
    value: string | undefined | null,
    range: DateRangeFilter,
  ): boolean {
    if (!value) return false;
    if (range.from && value < range.from) return false;
    if (range.to && value > range.to) return false;
    return true;
  }

  async queryAdvanced(
    opts: ExpenseAdvancedQueryOptions,
  ): Promise<ExpenseRecordJSON[]> {
    let items = await this.base.list();

    if (opts.publicKey) {
      items = items.filter((rExp) => rExp.account_id === opts.publicKey);
    }

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      items = items.filter((rExp) => statuses.includes(rExp.status));
    }

    if (opts.createdAt && (opts.createdAt.from || opts.createdAt.to)) {
      items = items.filter((rExp) =>
        this._inRange(rExp.created_at, opts.createdAt!),
      );
    }

    // sort
    const mult = (opts.sortDir ?? "desc") === "asc" ? 1 : -1;
    items.sort((a, b) => {
      const av = a.created_at;
      const bv = b.created_at;
      return mult * av.localeCompare(bv);
    });

    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit) items = items.slice(0, opts.limit);

    return items;
  }

  async listByPublicKey(publicKey: string) {
    return this.queryAdvanced({ publicKey });
  }

  async listByCreatedAtRange(range: DateRangeFilter) {
    return this.queryAdvanced({ createdAt: range });
  }
}

export const IDB_ADAPTER_EXPENSE_RECORDS_EXTENDED =
  new IDBExpenseRecordAdapterExtended();
