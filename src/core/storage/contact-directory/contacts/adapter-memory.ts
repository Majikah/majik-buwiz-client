
import { MajikInvoiceContactStorageAdapter } from "./_types";
import { SerializedMajikInvoiceContact } from "../../../party/types";


export class InMemoryContactAdapter implements MajikInvoiceContactStorageAdapter {
  private _store: Map<string, SerializedMajikInvoiceContact> = new Map();

  async save(contact: SerializedMajikInvoiceContact): Promise<void> {
    this._store.set(contact.id, contact);
  }

  async getById(id: string): Promise<SerializedMajikInvoiceContact | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<SerializedMajikInvoiceContact[]> {
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

  async bulkSave(contacts: SerializedMajikInvoiceContact[]): Promise<void> {
    for (const inv of contacts) this._store.set(inv.id, inv);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
