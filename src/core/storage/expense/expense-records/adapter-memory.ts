// ---------------------------------------------------------------------------
// InMemoryExpenseRecordAdapter — default, zero-config, non-persistent
// ---------------------------------------------------------------------------

import { ExpenseRecordJSON } from "../../../expenses/types";
import { ExpenseRecordStorageAdapter } from "./_types";

/**
 * In-memory adapter backed by a plain Map.
 * Default adapter when no other is provided.
 * Does not persist across page loads or restarts.
 *
 * @example
 *   const manager = new ExpenseManager();
 *   // InMemoryExpenseRecordAdapter is used automatically
 */
export class InMemoryExpenseRecordAdapter implements ExpenseRecordStorageAdapter {
  private _store: Map<string, ExpenseRecordJSON> = new Map();

  async save(expense: ExpenseRecordJSON): Promise<void> {
    this._store.set(expense.id, expense);
  }

  async getById(id: string): Promise<ExpenseRecordJSON | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<ExpenseRecordJSON[]> {
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

  async bulkSave(expenses: ExpenseRecordJSON[]): Promise<void> {
    for (const exp of expenses) this._store.set(exp.id, exp);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
