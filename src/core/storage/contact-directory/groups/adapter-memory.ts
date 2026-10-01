



import { SerializedMajikInvoiceContactGroup } from "../../../party/types";
import { MajikInvoiceContactGroupStorageAdapter } from "./_types";



export class InMemoryContactGroupAdapter implements MajikInvoiceContactGroupStorageAdapter {
  private _store: Map<string, SerializedMajikInvoiceContactGroup> = new Map();

  async save(invoice: SerializedMajikInvoiceContactGroup): Promise<void> {
    this._store.set(invoice.id, invoice);
  }

  async getById(id: string): Promise<SerializedMajikInvoiceContactGroup | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<SerializedMajikInvoiceContactGroup[]> {
    return Array.from(this._store.values());
  }

  async remove(id: string): Promise<boolean> {
    return this._store.delete(id);
  }

  async clear(): Promise<void> {
    this._store.clear();
  }

  async count(): Promise<number> {
    return this._store.size;
  }

  async exists(id: string): Promise<boolean> {
    return this._store.has(id);
  }

  async bulkSave(invoices: SerializedMajikInvoiceContactGroup[]): Promise<void> {
    for (const inv of invoices) this._store.set(inv.id, inv);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
