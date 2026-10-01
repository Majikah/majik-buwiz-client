import { RecurringExpenseItemJSON } from "../../../expenses/recurring/types";
import { RecurringExpenseItemStorageAdapter } from "./_types";

// ---------------------------------------------------------------------------
// InMemoryRecurringExpenseItemAdapter — default, zero-config, non-persistent
// ---------------------------------------------------------------------------

/**
 * In-memory adapter backed by a plain Map.
 * Default adapter when no other is provided.
 * Does not persist across page loads or restarts.
 *
 * @example
 *   const manager = new ExpenseManager();
 *   // InMemoryRecurringExpenseItemAdapter is used automatically
 */
export class InMemoryRecurringExpenseItemAdapter implements RecurringExpenseItemStorageAdapter {
  private _store: Map<string, RecurringExpenseItemJSON> = new Map();

  async save(expense: RecurringExpenseItemJSON): Promise<void> {
    this._store.set(expense.id, expense);
  }

  async getById(id: string): Promise<RecurringExpenseItemJSON | null> {
    return this._store.get(id) ?? null;
  }

  async list(): Promise<RecurringExpenseItemJSON[]> {
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

  async bulkSave(expenses: RecurringExpenseItemJSON[]): Promise<void> {
    for (const exp of expenses) this._store.set(exp.id, exp);
  }

  async bulkRemove(ids: string[]): Promise<void> {
    for (const id of ids) this._store.delete(id);
  }
}
