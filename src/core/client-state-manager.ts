/**
 * @file client-state-manager.ts
 * @description ClientStateManager — typed read/write interface over a
 * pluggable ClientStateStorageAdapter.
 *
 * Responsibilities:
 *   - Async get / set / remove for each well-known client-state key
 *   - In-memory cache in front of the adapter (warm via hydrate())
 *   - Typed accessors for `accountOrder` and `invoiceDefaults` so callers
 *     never touch raw JSON strings
 *   - Generic `get` / `set` escape hatch for any future keys
 *   - Adapter can be swapped at runtime via setAdapter()
 *
 * Usage:
 * ```ts
 * const stateManager = new ClientStateManager(new IDBClientStateAdapter());
 * await stateManager.hydrate();
 *
 * await stateManager.setAccountOrder(["id1", "id2"]);
 * const order = await stateManager.getAccountOrder(); // ["id1", "id2"]
 * ```
 *
 * MajikBuwizClient owns this instance and calls hydrate() during its own
 * hydrate() pass. Callers should never need to hydrate() again unless the
 * adapter is swapped.
 */

import { MajikKeyClientStateManager } from "@majikah/majik-key-client";
import {
  CLIENT_STATE_KEYS,
  ClientStateStorageAdapter,
  ExpenseColumnDef,
  InvoiceColumnDef,
  InvoiceDefaults,
  UserAppPreferences,
} from "./storage/client-state/_types";
import { InMemoryClientStateAdapter } from "./storage/client-state/adapter-memory";

// ---------------------------------------------------------------------------
// ClientStateManager
// ---------------------------------------------------------------------------

export class ClientStateManager extends MajikKeyClientStateManager {
  constructor(
    adapter: ClientStateStorageAdapter = new InMemoryClientStateAdapter(),
  ) {
    super(adapter);
  }

  // ── Typed: invoice Table Columns ───────────────────────────────────────────────

  /**
   * Retrieve user-configured invoice table columns.
   * Returns `null` if none have been saved yet.
   */
  async getInvoiceTableColumns(): Promise<InvoiceColumnDef[] | null> {
    const raw = await this.get(CLIENT_STATE_KEYS.INVOICE_TABLE_COLUMNS);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as InvoiceColumnDef[];
    } catch {
      console.warn(
        "ClientStateManager: malformed invoice table columns — discarding.",
      );
      return null;
    }
  }

  /**
   * Persist user-configured invoice table columns.
   */
  async setInvoiceTableColumns(defaults: InvoiceColumnDef[]): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.INVOICE_TABLE_COLUMNS,
      JSON.stringify(defaults),
    );
  }

  /**
   * Remove the persisted invoice table columns.
   */
  async removeInvoiceTableColumns(): Promise<void> {
    await this.remove(CLIENT_STATE_KEYS.INVOICE_TABLE_COLUMNS);
  }

  // ── Typed: Expense Table Columns ───────────────────────────────────────────────

  /**
   * Retrieve user-configured expense table columns.
   * Returns `null` if none have been saved yet.
   */
  async getExpenseTableColumns(): Promise<ExpenseColumnDef[] | null> {
    const raw = await this.get(CLIENT_STATE_KEYS.EXPENSE_TABLE_COLUMNS);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ExpenseColumnDef[];
    } catch {
      console.warn(
        "ClientStateManager: malformed expense table columns — discarding.",
      );
      return null;
    }
  }

  /**
   * Persist user-configured expense table columns.
   */
  async setExpenseTableColumns(defaults: ExpenseColumnDef[]): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.EXPENSE_TABLE_COLUMNS,
      JSON.stringify(defaults),
    );
  }

  /**
   * Remove the persisted expense table columns.
   */
  async removeExpenseTableColumns(): Promise<void> {
    await this.remove(CLIENT_STATE_KEYS.EXPENSE_TABLE_COLUMNS);
  }

  // ── Typed: invoice defaults ───────────────────────────────────────────────

  /**
   * Retrieve user-configured invoice defaults.
   * Returns `null` if none have been saved yet.
   */
  async getInvoiceDefaults(): Promise<InvoiceDefaults | null> {
    const raw = await this.get(CLIENT_STATE_KEYS.INVOICE_DEFAULTS);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as InvoiceDefaults;
    } catch {
      console.warn(
        "ClientStateManager: malformed invoice defaults — discarding.",
      );
      return null;
    }
  }

  /**
   * Persist user-configured invoice defaults.
   */
  async setInvoiceDefaults(defaults: InvoiceDefaults): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.INVOICE_DEFAULTS,
      JSON.stringify(defaults),
    );
  }

  /**
   * Remove the persisted invoice defaults.
   */
  async removeInvoiceDefaults(): Promise<void> {
    await this.remove(CLIENT_STATE_KEYS.INVOICE_DEFAULTS);
  }

  async currentInvoiceNumber(): Promise<number> {
    const current = await this.getInvoiceDefaults();
    const counter = current?.invoiceNumberCounter ?? 0;
    return counter;
  }

  async incrementInvoiceNumber(): Promise<number> {
    // 1. Get current defaults
    const current = await this.getInvoiceDefaults();

    // 2. Initialize safely if missing
    const counter = current?.invoiceNumberCounter ?? 0;

    const updated: InvoiceDefaults = {
      ...(current ?? {
        currency: "PHP" as any, // fallback — adjust if you have a real default
      }),
      invoiceNumberCounter: counter + 1,
    };

    // 3. Persist
    await this.setInvoiceDefaults(updated);

    // 4. Return the new value (useful for generating invoice number)
    return updated.invoiceNumberCounter!;
  }

  async decrementInvoiceNumber(): Promise<number> {
    // 1. Get current defaults
    const current = await this.getInvoiceDefaults();

    // 2. Initialize safely if missing
    const counter = current?.invoiceNumberCounter ?? 0;

    const updated: InvoiceDefaults = {
      ...(current ?? {
        currency: "PHP" as any, // fallback — adjust if you have a real default
      }),
      invoiceNumberCounter: counter - 1,
    };

    // 3. Persist
    await this.setInvoiceDefaults(updated);

    // 4. Return the new value (useful for generating invoice number)
    return updated.invoiceNumberCounter!;
  }

  /**
   * Retrieve user app preferences.
   * Returns `null` if none have been saved yet.
   */
  async getUserAppPreferences(): Promise<UserAppPreferences> {
    const raw = await this.get(CLIENT_STATE_KEYS.USER_APP_PREFERENCES);
    if (raw === null) {
      await this.resetUserAppPreferences();
      return DEFAULT_USER_APP_PREFERENCES;
    }
    try {
      return JSON.parse(raw) as UserAppPreferences;
    } catch (e) {
      console.warn(
        "ClientStateManager: Problem retrieving user app preferences: ",
        e,
      );
      return DEFAULT_USER_APP_PREFERENCES;
    }
  }

  /**
   * Persist user app preferences.
   */
  async setUserAppPreferences(preferences: UserAppPreferences): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.USER_APP_PREFERENCES,
      JSON.stringify(preferences),
    );
  }

  /**
   * Persist user app preferences.
   */
  async resetUserAppPreferences(): Promise<void> {
    await this.set(
      CLIENT_STATE_KEYS.USER_APP_PREFERENCES,
      JSON.stringify(DEFAULT_USER_APP_PREFERENCES),
    );
  }

  /**
   * Remove user app preferences.
   */
  async removeUserAppPreferences(): Promise<void> {
    await this.remove(CLIENT_STATE_KEYS.USER_APP_PREFERENCES);
  }
}

export const DEFAULT_USER_APP_PREFERENCES: UserAppPreferences = {
  general: {
    history: {
      enabled: true,
      maxCount: 100,
    },
  },
  dashboard: {
    autodecrypt: false,
  },
  invoices: {
    autodecrypt: false,
  },
  privacy: {
    shareAnalytics: true,
  },
  security: {
    key: {
      autoLockOnMinimize: false,
      onetimeUnlock: true,
    },
  },
};
