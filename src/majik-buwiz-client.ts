import { MajikKey, MajikKeyAddress, MajikKeyBackup } from "@majikah/majik-key";

import { MajikEnvelope, MajikRecipient } from "@majikah/majik-envelope";
import { MajikCompressedJSON } from "@majikah/majik-cjson";
import {
  AppBackUpData,
  MAJIK_API_RESPONSE,
  MajikMessagePublicKey,
} from "./core/types";

import {
  CSVColumn,
  CSVExportResult,
  GeneralInvoice,
  InvoiceStatus,
  MajikInvoice,
  MajikInvoiceError,
  MajikInvoiceInput,
  MajikInvoiceJSON,
  MajikInvoiceKeyError,
  MajikInvoiceMode,
  MajikInvoiceStatus,
  MajikInvoiceValidationResult,
  PublicInvoiceSummary,
} from "@majikah/majik-invoice";
import {
  ExpectedSigner,
  MajikSignature,
  SealInfo,
  SealVerificationResult,
  VerificationResult,
} from "@majikah/majik-signature";
import {
  InvoiceAdvancedQueryOptions,
  InvoiceDateRangeFilter,
  InvoiceQueryOptions,
  InvoiceQueryResult,
  MajikInvoiceManager,
} from "./core/invoice/invoice-manager";
import { MajikInvoiceStorageAdapter } from "./core/storage/invoice/_types";
import { ClientStateManager } from "./core/client-state-manager";
import {
  ClientStateStorageAdapter,
  ExpenseColumnDef,
  InvoiceColumnDef,
  InvoiceDefaults,
  UserAppPreferences,
} from "./core/storage/client-state/_types";
import { InMemoryClientStateAdapter } from "./core/storage/client-state/adapter-memory";
import {
  MajikInvoiceContactManager,
  MajikInvoiceContactManagerAdapters,
} from "./core/party/majik-invoice-contact-manager";
import { MajikInvoiceContact } from "./core/party/majik-invoice-contact";
import { MajikInvoiceContactGroup } from "./core/party/majik-invoice-contact-group";
import {
  MajikInvoiceContactGroupMeta,
  MajikInvoiceContactManagerJSON,
  MajikInvoiceContactMeta,
} from "./core/party/types";
import {
  BatchDecryptResult,
  InvoiceDecryptionResult,
} from "@majikah/majik-invoice/dist/core/majik-invoice";
import { prependMagic, readBackupBlob } from "./core/backup/utils";
import {
  MAJIK_BUWIZ_BACKUP_MAGIC,
  MAJIK_BUWIZ_BACKUP_MAGIC_SIZE,
} from "./core/backup/constants";
import { AppDataSnapshot, ContactManagerSnapshot } from "./core/backup/types";

import {
  HistoryLogStorageAdapter,
  InMemoryInvoiceAdapter,
  StorageSource,
  UserActivityLogStorageAdapter,
} from "./core/storage";
import {
  InMemoryRecurringExpenseItemAdapter,
  RecurringExpenseManager,
} from "./core/expenses/recurring-expense-manager";
import { ExpenseManager } from "./core/expenses/expense-manager";
import { ExpenseRecordStorageAdapter } from "./core/storage/expense/expense-records/_types";
import { InMemoryExpenseRecordAdapter } from "./core/storage/expense/expense-records/adapter-memory";
import { ExpenseRecord } from "./core/expenses/expense-record";
import {
  ActualizationResult,
  ActualizeOptions,
} from "./core/expenses/recurring/types";
import {
  DateRangeFilter,
  ExpenseAdvancedQueryOptions,
  ExpenseCategory,
  ExpenseQueryOptions,
  ExpenseQueryResult,
  ExpenseRecordInput,
  ExpenseRecordJSON,
  ExpenseRecordStatus,
} from "./core/expenses/types";
import { ExpenseRecordError } from "./core/expenses/errors";
import { RecurringExpenseItemStorageAdapter } from "./core/storage/expense/recurring/_types";
import {
  MajikKeyClient,
  MajikKeyClientBaseEvents,
  MajikKeyClientConfig,
} from "@majikah/majik-key-client";
import {
  AuditActions,
  CreateHistoryLogOptions,
  CreateUserActivityLogOptions,
  HistoryLog,
  HistoryLogManager,
  UserActivityLog,
  UserActivityLogManager,
} from "./core/log";
import { arrayToBase64 } from "./core/utils/utilities";
import { MajikFileIdentity } from "@majikah/majik-file";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

type MajikBuwizClientEvents =
  | MajikKeyClientBaseEvents
  | "new-contact"
  | "removed-contact"
  | "updated-contact"
  | "new-contact-group"
  | "removed-contact-group"
  | "contact-group-change"
  | "invoice-created"
  | "invoice-updated"
  | "invoice-removed"
  | "invoice-signed"
  | "invoice-sealed"
  | "invoice-closed"
  | "invoice-verified"
  | "invoice-decrypted"
  | "invoice-reissued"
  | "invoice-decrypted-batch"
  | "invoice-export-csv"
  | "invoice-export-pdf"
  | "invoice-export-mjki"
  | "invoice-clear"
  | "expense-created"
  | "expense-updated"
  | "expense-removed"
  | "expense-actualized"
  | "expense-clear"
  | "history-log"
  | "activity-log";

type EventCallback = (...args: unknown[]) => void;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MajikBuwizClientConfig extends MajikKeyClientConfig {
  /** Buwiz-specific client state manager. */
  clientStateManager?: ClientStateManager;
  /** Shared contact directory manager. */
  contactManager?: MajikInvoiceContactManager;

  invoiceManager?: MajikInvoiceManager;
  expenseManager?: ExpenseManager;
  recurringExpenseManager?: RecurringExpenseManager;
  /** History log manager used for persisted audit/history records. */
  historyManager?: HistoryLogManager;
  /** User activity log manager used for persisted activity records. */
  activityManager?: UserActivityLogManager;
  /** Storage adapters used when the corresponding manager is not injected. */
  adapters?: MajikKeyClientConfig["adapters"] & {
    /** Contact directory storage adapters. */
    contacts?: MajikInvoiceContactManagerAdapters;
    /** Encrypted stamp storage adapter. */
    invoices?: MajikInvoiceStorageAdapter;
    expenses?: ExpenseRecordStorageAdapter;
    recurringExpenses?: RecurringExpenseItemStorageAdapter;
    /** History log storage adapter. */
    historyLogs?: HistoryLogStorageAdapter;
    /** User activity log storage adapter. */
    userActivityLogs?: UserActivityLogStorageAdapter;
  };
}

// ---------------------------------------------------------------------------
// MajikBuwizClient
// ---------------------------------------------------------------------------

/**
 * MajikBuwizClient
 * ---
 *
 * High-level wrapper client for MajikBuwiz + MajikInvoice.
 *
 * Persistence model (post-adapter refactor):
 *   Each domain is owned by its adapter — there is no whole-client blob save.
 *   On startup, call `await client.hydrate()` to load all domains.
 *
 *   Client-level state (account order, invoice defaults, and any future
 *   additions) is owned by ClientStateManager, which is backed by a
 *   pluggable ClientStateStorageAdapter. Pass one via config.adapters.clientState
 *   or let it default to InMemoryClientStateAdapter.
 */

export class MajikBuwizClient extends MajikKeyClient<
  MajikInvoiceContact,
  MajikInvoiceContactMeta,
  MajikBuwizClientEvents,
  ClientStateManager
> {
  private _contacts: MajikInvoiceContactManager;
  private _invoices: MajikInvoiceManager;

  private _expenses: ExpenseManager;
  private _recurringExpenses: RecurringExpenseManager;
  /** History log manager used for non-blocking audit/history records. */
  private _history: HistoryLogManager;
  /** User activity log manager used for non-blocking activity records. */
  private _activity: UserActivityLogManager;

  /**
   * Creates a Majik Buwiz client with the supplied managers and storage adapters.
   *
   * Use `create()` when the client should be hydrated before first use.
   *
   * @param config - Client configuration, including optional managers and storage adapters.
   */
  constructor(config: MajikBuwizClientConfig) {
    super(config);

    this._contacts =
      config.contactManager ??
      new MajikInvoiceContactManager(
        undefined,
        undefined,
        config.adapters?.contacts,
      );

    this._invoices =
      config.invoiceManager ??
      new MajikInvoiceManager(
        config.adapters?.invoices ?? new InMemoryInvoiceAdapter(),
      );

    this._expenses =
      config.expenseManager ??
      new ExpenseManager(
        config.adapters?.expenses ?? new InMemoryExpenseRecordAdapter(),
      );

    this._recurringExpenses =
      config.recurringExpenseManager ??
      new RecurringExpenseManager(
        config.adapters?.recurringExpenses ??
          new InMemoryRecurringExpenseItemAdapter(),
      );

    this._history =
      config.historyManager ??
      new HistoryLogManager(config.adapters?.historyLogs);

    this._activity =
      config.activityManager ??
      new UserActivityLogManager(config.adapters?.userActivityLogs);

    this._registerEventNames([
      "new-contact",
      "removed-contact",
      "updated-contact",

      "new-contact-group",
      "removed-contact-group",
      "contact-group-change",

      "invoice-created",
      "invoice-updated",
      "invoice-removed",
      "invoice-signed",
      "invoice-sealed",
      "invoice-closed",
      "invoice-verified",
      "invoice-decrypted",
      "invoice-reissued",
      "invoice-decrypted-batch",
      "invoice-export-csv",
      "invoice-export-pdf",
      "invoice-export-mjki",
      "invoice-clear",

      "expense-created",
      "expense-updated",
      "expense-removed",
      "expense-actualized",
      "expense-clear",

      "history-log",
      "activity-log",
    ]);
  }

  /**
   * Override — without this, MajikKeyClient's constructor falls back to
   * building a plain MajikKeyClientStateManager (ACCOUNT_ORDER only),
   * and every call to getUserAppPreferences() etc. throws at runtime.
   * @param adapter - Optional storage adapter used for persisted client state.
   * @returns The result of the create default state manager operation (`ClientStateManager`).
   */
  protected _createDefaultStateManager(
    adapter?: ClientStateStorageAdapter,
  ): ClientStateManager {
    return new ClientStateManager(adapter ?? new InMemoryClientStateAdapter());
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get invoiceCount(): number {
    return this._invoices.cachedCount;
  }

  get invoiceManager(): MajikInvoiceManager {
    return this._invoices;
  }

  get expenseManager(): ExpenseManager {
    return this._expenses;
  }

  get recurringExpenseManager(): RecurringExpenseManager {
    return this._recurringExpenses;
  }

  /**
   * Returns the history log manager used by this client.
   * @returns The configured `HistoryLogManager` instance.
   */
  get historyManager(): HistoryLogManager {
    return this._history;
  }

  /**
   * Returns the user activity log manager used by this client.
   * @returns The configured `UserActivityLogManager` instance.
   */
  get activityManager(): UserActivityLogManager {
    return this._activity;
  }

  // ==========================================================================
  // ── MajikKeyClient HOOKS ──────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Converts a MajikKey into the MajikInvoiceContact representation used by this client.
   * @param key - MajikKey used as the cryptographic identity for the operation.
   * @param meta - Optional metadata associated with the contact, account, or group.
   * @returns The result of the build own account contact operation (`MajikInvoiceContact`).
   */
  protected _buildOwnAccountContact(
    key: MajikKey,
    meta?: Partial<MajikInvoiceContactMeta>,
  ): MajikInvoiceContact {
    const mlKeyBase64 = arrayToBase64(key.mlKemPublicKey);

    return new MajikInvoiceContact({
      id: key.fingerprint,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      meta: meta,
      mlKey: mlKeyBase64,
      edPublicKeyBase64: key.edPublicKey
        ? arrayToBase64(key.edPublicKey)
        : undefined,
      mlDsaPublicKeyBase64: key.mlDsaPublicKey
        ? arrayToBase64(key.mlDsaPublicKey)
        : undefined,
    });
  }

  /**
   * Synchronizes a newly registered own account into the shared contact directory.
   * @param contact - Majik contact record to add, export, or otherwise operate on.
   * @returns Completes when the operation has finished.
   */
  protected async _onAccountRegistered(
    contact: MajikInvoiceContact,
  ): Promise<void> {
    if (!this._contacts.hasContact(contact.id)) {
      await this._contacts.addContact(contact);
    }
  }

  /**
   * Removes an own account from the shared contact directory.
   * @param id - Unique identifier of the target entity.
   * @returns Completes when the operation has finished.
   */
  protected async _onAccountRemoved(id: string): Promise<void> {
    await this._contacts.removeContact(id);
  }

  /**
   * Clears Signature-specific key-derived data while preserving audit history.
   * @returns Completes when the operation has finished.
   */
  protected async _onResetKeyData(): Promise<void> {
    await this._contacts.clear();
    await this._invoices.clear();

    await this._expenses.clear();
    await this._recurringExpenses.clear();

    // Deliberately NOT clearing _history/_activity here — see class docblock
    // note above. Audit trail must survive a key-data reset; record the
    // reset itself instead of erasing what came before it.
    await this._recordActivity(undefined, {
      reference_id: "key-data-reset",
      action: AuditActions.KEY_DATA_RESET, // ⚠️ verify this member exists
      metadata: { at: new Date().toISOString() },
    });
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Load all domains from their adapters and restore client state.
   * Call once on startup.
   *
   * Order matters: contacts/stamps must be hydrated before own-account
   * hydration, since _onAccountRegistered() syncs derived accounts into
   * the contact directory.
   *
   * ```ts
   * const client = new MajikBuwizClient({ adapters: { keys: idbAdapter, ... } });
   * await client.hydrate();
   * ```
   * @returns Completes when the operation has finished.
   */
  async hydrate(): Promise<void> {
    await this._hydrateKeys();
    await this._contacts.hydrate();
    await this._invoices.hydrate();
    await this._expenses.hydrate();
    await this._recurringExpenses.hydrate();
    await this._history.hydrate();
    await this._activity.hydrate();
    await this._hydrateState();
    await this._hydrateOwnAccounts();
    await this._restoreAccountOrder();
  }

  /**
   * Constructs a client and immediately hydrates it.
   *
   * @typeParam T - Concrete `MajikBuwizClient` subtype returned by the constructor.
   * @param config - Client configuration, including optional managers and storage adapters.
   * @returns The result of the create operation (`Promise<T>`).
   */
  static async create<T extends MajikBuwizClient>(
    this: new (config: MajikBuwizClientConfig) => T,
    config: MajikBuwizClientConfig = {},
  ): Promise<T> {
    const client = new this(config);
    await client.hydrate();
    return client;
  }

  // ── Logging (private, non-throwing) ─────────────────────────────────────

  /**
   * Lists history log entries associated with the currently active account.
   * @returns The result of the list history for active account operation (`HistoryLog[]`).
   */
  listHistoryForActiveAccount(): HistoryLog[] {
    const key = this.getActiveAccountKey();
    if (!key) return [];
    return this._history.listByFingerprint(key.fingerprint);
  }

  /**
   * Lists user activity log entries associated with the currently active account.
   * @returns The result of the list activity for active account operation (`UserActivityLog[]`).
   */
  listActivityForActiveAccount(): UserActivityLog[] {
    const key = this.getActiveAccountKey();
    if (!key) return [];
    return this._activity.listByFingerprint(key.fingerprint);
  }

  /**
   * Builds a MajikFileIdentity directly from an already-resolved, in-scope key —
   * never re-looks-up "the active account." Returns undefined (not throw) when
   * the key can't support envelope encryption, since logging must never block
   * the operation it's attached to.
   * @param key - MajikKey used as the cryptographic identity for the operation.
   * @returns The result of the identity from key operation (`MajikFileIdentity | undefined`).
   */
  private _identityFromKey(key: MajikKey): MajikFileIdentity | undefined {
    if (key.isLocked) return undefined;
    const mlKemSecretKey = this._keys.getMlKemSecretKey(key.id);
    if (!mlKemSecretKey) return undefined;
    return {
      publicKey: key.publicKeyBase64,
      fingerprint: key.fingerprint,
      mlKemPublicKey: key.mlKemPublicKey,
      mlKemSecretKey,
    };
  }

  /**
   * Writes a HistoryLog entry. Never throws — a logging failure must not fail
   * the signing/verification/seal operation it's attached to. `fingerprint` is
   * the caller's responsibility: pass the fingerprint of whichever key actually
   * performed the operation, not whatever happens to be the active account.
   * @param fingerprint - Majik identity fingerprint used to identify the owning cryptographic account.
   * @param options - Optional operation-specific settings.
   * @returns The result of the record history operation (`Promise<HistoryLog | null>`).
   */
  protected async _recordHistory(
    fingerprint: string | undefined,
    options: Omit<CreateHistoryLogOptions, "id" | "timestamp" | "fingerprint">,
  ): Promise<HistoryLog | null> {
    try {
      // 1. Fetch user app preferences
      const prefs = await this.getUserAppPreferences();
      const historyPrefs = prefs.general?.history;

      // 2. Abort if the user disabled history logging
      if (historyPrefs?.enabled === false) {
        return null;
      }

      // 3. Create the new log entry
      const entry = await this._history.create({ ...options, fingerprint });
      this._emit("history-log", entry);

      // 4. Enforce the maxCount limit
      const maxCount = historyPrefs?.maxCount ?? 100;

      if (fingerprint && maxCount > 0) {
        // Fetch all logs for this specific fingerprint
        const userLogs = this._history.listByFingerprint(fingerprint);

        if (userLogs.length > maxCount) {
          // Sort logs chronologically (oldest first) based on the timestamp string
          userLogs.sort(
            (a, b) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );

          // Identify the oldest logs that exceed the maxCount threshold
          const excessCount = userLogs.length - maxCount;
          const logsToDelete = userLogs.slice(0, excessCount);
          const idsToDelete = logsToDelete.map((log) => log.id);

          // Batch delete the old logs from cache and storage adapter
          await this._history.bulkRemove(idsToDelete);
        }
      }

      return entry;
    } catch (err) {
      console.warn("MajikBuwizClient: failed to record history log", err);
      return null;
    }
  }

  async recordActivity(
    fingerprint: string | undefined,
    options: Omit<
      CreateUserActivityLogOptions,
      "id" | "timestamp" | "fingerprint"
    >,
  ): Promise<UserActivityLog | null> {
    return this._recordActivity(fingerprint, options);
  }

  /**
   * Records a user activity entry without allowing logging failures to interrupt the calling operation.
   * @param fingerprint - Majik identity fingerprint used to identify the owning cryptographic account.
   * @param options - Optional operation-specific settings.
   * @returns The result of the record activity operation (`Promise<UserActivityLog | null>`).
   */
  protected async _recordActivity(
    fingerprint: string | undefined,
    options: Omit<
      CreateUserActivityLogOptions,
      "id" | "timestamp" | "fingerprint"
    >,
  ): Promise<UserActivityLog | null> {
    try {
      const entry = await this._activity.create({ ...options, fingerprint });
      this._emit("activity-log", entry);

      // Enforce the hardcoded 5000 log limit
      const MAX_ACTIVITY_LOGS = 5000;

      if (fingerprint) {
        const userLogs = this._activity.listByFingerprint(fingerprint);

        if (userLogs.length > MAX_ACTIVITY_LOGS) {
          // Sort logs chronologically (oldest first)
          userLogs.sort(
            (a, b) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );

          // Identify and bulk delete the oldest excess logs
          const excessCount = userLogs.length - MAX_ACTIVITY_LOGS;
          const logsToDelete = userLogs.slice(0, excessCount);
          const idsToDelete = logsToDelete.map((log) => log.id);

          await this._activity.bulkRemove(idsToDelete);
        }
      }

      return entry;
    } catch (err) {
      console.warn("MajikBuwizClient: failed to record activity log", err);
      return null;
    }
  }

  /**
   * Clears only the history logs for the active account.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async clearHistoryLogsForActiveAccount(): Promise<void> {
    const key = this.getActiveAccountKey();
    if (!key) {
      throw new Error("No active account — call setActiveAccount() first");
    }

    const fingerprint = key.fingerprint;
    const historyLogs = this._history.listByFingerprint(fingerprint);

    if (historyLogs.length > 0) {
      const historyIds = historyLogs.map((log) => log.id);
      await this._history.bulkRemove(historyIds);
    }
  }

  /**
   * Clears only the activity logs for the active account.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async clearActivityLogsForActiveAccount(): Promise<void> {
    const key = this.getActiveAccountKey();
    if (!key) {
      throw new Error("No active account — call setActiveAccount() first");
    }

    const fingerprint = key.fingerprint;
    const activityLogs = this._activity.listByFingerprint(fingerprint);

    if (activityLogs.length > 0) {
      const activityIds = activityLogs.map((log) => log.id);
      await this._activity.bulkRemove(activityIds);
    }
  }

  /**
   * Unified method: Clears both history and activity logs for the active account,
   * then seeds a new log acknowledging the reset.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async restartLogsForActiveAccount(): Promise<void> {
    const key = this.getActiveAccountKey();
    if (!key) {
      throw new Error("No active account — call setActiveAccount() first");
    }

    // Call the separated clear methods
    await this.clearHistoryLogsForActiveAccount();
    await this.clearActivityLogsForActiveAccount();

    // Record the restart action itself as the new initial log
    await this._recordActivity(key.fingerprint, {
      reference_id: "logs-restarted",
      action: AuditActions.KEY_DATA_RESET, // Adjust if you have a specific LOGS_CLEARED action
      metadata: {
        at: new Date().toISOString(),
        message: "History and activity logs restarted",
      },
    });
  }

  /**
   * Hydrate history + activity logs scoped to the active account's
   * fingerprint. Mirrors hydrateStampsForActiveAccount() — separate from
   * the general hydrate() above because it needs an unlocked active
   * account and is typically called after unlockAccount(), not at startup.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async hydrateLogsForActiveAccount(): Promise<void> {
    const key = this.getActiveAccountKey();
    if (!key)
      throw new Error("No active account — call setActiveAccount() first");
    await this._history.hydrateForFingerprint(key.fingerprint);
    await this._activity.hydrateForFingerprint(key.fingerprint);
  }

  // ── Private hydration helpers ─────────────────────────────────────────────

  private async _hydrateInvoices(decrypt = false): Promise<void> {
    const account = this.getActiveAccount();

    // Try to resolve an unlocked key early
    let key: MajikKey | undefined;

    if (account) {
      try {
        await this.ensureIdentityUnlocked(account.id);
        key = this._keys.get(account.id);
      } catch {
        // Ignore unlock failures — fallback to unfiltered hydration
      }
    }

    // Hydrate using scoped key when available
    await this._invoices.hydrate(key);

    // Stop here if caller only wants cached raw invoices
    if (!decrypt || !key) return;

    try {
      const { decrypted } = await MajikInvoice.batchDecrypt(
        this._invoices.listCached(),
        key,
      );

      await Promise.all(
        decrypted.map((invoice) => this._invoices.save(invoice)),
      );
    } catch {
      // Non-fatal — encrypted/raw invoices remain cached
    }
  }

  // ==========================================================================
  // ── INVOICE DEFAULTS ──────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Retrieve persisted invoice defaults, or `null` if none have been saved.
   */
  async getInvoiceDefaults(): Promise<InvoiceDefaults | null> {
    return this._state.getInvoiceDefaults();
  }

  /**
   * Persist invoice defaults. These are applied by callers when pre-filling
   * the invoice creation form; MajikBuwizClient does not auto-apply them.
   */
  async setInvoiceDefaults(defaults: InvoiceDefaults): Promise<void> {
    await this._state.setInvoiceDefaults(defaults);
  }

  /**
   * Remove persisted invoice defaults.
   */
  async removeInvoiceDefaults(): Promise<void> {
    await this._state.removeInvoiceDefaults();
  }

  // ==========================================================================
  // ── INVOICE TABLE COLUMNS ──────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Retrieve persisted invoice table columns, or `null` if none have been saved.
   */
  async getExpenseTableColumns(): Promise<ExpenseColumnDef[] | null> {
    return this._state.getExpenseTableColumns();
  }

  /**
   * Persist expense table columns.
   */
  async setExpenseTableColumns(defaults: ExpenseColumnDef[]): Promise<void> {
    await this._state.setExpenseTableColumns(defaults);
  }

  /**
   * Remove persisted expense table columns.
   */
  async resetExpenseTableColumns(): Promise<void> {
    await this._state.removeExpenseTableColumns();
  }

  // ==========================================================================
  // ── INVOICE TABLE COLUMNS ──────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Retrieve persisted invoice table columns, or `null` if none have been saved.
   */
  async getInvoiceTableColumns(): Promise<InvoiceColumnDef[] | null> {
    return this._state.getInvoiceTableColumns();
  }

  /**
   * Persist invoice table columns.
   */
  async setInvoiceTableColumns(defaults: InvoiceColumnDef[]): Promise<void> {
    await this._state.setInvoiceTableColumns(defaults);
  }

  /**
   * Remove persisted invoice defaults.
   */
  async resetInvoiceTableColumns(): Promise<void> {
    await this._state.removeInvoiceTableColumns();
  }

  // ==========================================================================
  // ── USER APP PREFERENCES ──────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Retrieve persisted user app prefernces, or `null` if none have been saved.
   */
  async getUserAppPreferences(): Promise<UserAppPreferences> {
    return this._state.getUserAppPreferences();
  }

  /**
   * Persist user app prefernces.
   */
  async setUserAppPreferences(preferences: UserAppPreferences): Promise<void> {
    await this._state.setUserAppPreferences(preferences);
  }

  /**
   * Remove persisted user app prefernces.
   */
  async removeUserAppPreferences(): Promise<void> {
    await this._state.removeUserAppPreferences();
  }

  /**
   * Reset persisted user app prefernces to default settings.
   */
  async resetUserAppPreferences(): Promise<void> {
    await this._state.resetUserAppPreferences();
  }

  async isAnalyticsEnabled(): Promise<boolean> {
    const appPreferences = await this._state.getUserAppPreferences();
    return appPreferences.privacy.shareAnalytics ?? false;
  }

  async isAutoDecryptInvoicesEnabled(): Promise<boolean> {
    const appPreferences = await this._state.getUserAppPreferences();
    return appPreferences.invoices.autodecrypt ?? false;
  }

  async exportActiveAccountKey(seed: string[]): Promise<Blob | null> {
    if (!this._ownAccountsOrder.length) return null;

    const activeKey = this.getActiveAccountKey();
    if (!activeKey) return null;

    if (activeKey.isLocked)
      throw new Error("Account must be unlocked before exporting.");

    const jsonData = activeKey.toMnemonicJSON(seed.join(" "));

    const backup = MajikKeyBackup.create({
      seed: jsonData.seed,
      id: jsonData.id,
      language: jsonData.language || "en",
    });
    const zipBlob = await backup.toZIP();

    return zipBlob;
  }

  /**
   * Checks whether keys are automatically locked when the application is minimized.
   * @returns The result of the is auto lock on minimize enabled operation (`Promise<boolean>`).
   */
  async isAutoLockOnMinimizeEnabled(): Promise<boolean> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.security?.key?.autoLockOnMinimize ?? false;
  }

  /**
   * Returns the configured automatic key-lock interval, when one is configured.
   * @returns The result of the auto lock interval operation (`Promise<number | undefined>`).
   */
  async autoLockInterval(): Promise<number | undefined> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.security?.key?.autoLockInterval;
  }

  /**
   * Checks whether one-time unlock behavior is enabled.
   * @returns The result of the is onetime unlock enabled operation (`Promise<boolean>`).
   */
  async isOnetimeUnlockEnabled(): Promise<boolean> {
    const appPreferences = await this.stateManager.getUserAppPreferences();
    return appPreferences.security?.key?.onetimeUnlock ?? true;
  }

  // ==========================================================================
  // ── ACCOUNT MANAGEMENT (overrides / additions on top of MajikKeyClient) ──
  // ==========================================================================

  /**
   * Update the metadata (e.g., label) of an owned account.
   * This updates both the contact directory and the local ownAccounts cache.
   * @param id - Unique identifier of the target entity.
   * @param meta - Optional metadata associated with the contact, account, or group.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async updateOwnAccountMeta(
    id: string,
    meta: Partial<MajikInvoiceContactMeta>,
  ): Promise<void> {
    if (!this._ownAccounts.has(id)) {
      throw new Error(`Account not found in own accounts: "${id}"`);
    }

    // 1. Update the contact record in the shared directory
    await this._contacts.updateContactMeta(id, meta);
    if (meta.label && meta.label.trim()) {
      await this.keyManager.updateLabel(id, meta.label);
    }

    // 2. Fetch the updated contact and sync the local _ownAccounts map
    const updatedContact = this._contacts.getContact(id);
    if (updatedContact) {
      this._ownAccounts.set(id, updatedContact);
    }
  }

  /**
   * Checks whether an identity with the supplied fingerprint exists in the key manager.
   * @param fingerprint - Majik identity fingerprint used to identify the owning cryptographic account.
   * @returns The result of the has own identity operation (`Promise<boolean>`).
   */
  async hasOwnIdentity(fingerprint: string): Promise<boolean> {
    return this.keyManager.has(fingerprint);
  }

  // ==========================================================================
  // ── CONTACT MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Returns a contact by its unique identifier.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the get contact by i d operation (`MajikInvoiceContact | null`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  getContactByID(id: string): MajikInvoiceContact | null {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.getContact(id) ?? null;
  }

  /**
   * Checks whether a contact with the supplied identifier exists.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the has contact operation (`boolean`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  hasContact(id: string): boolean {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.hasContact(id);
  }

  /**
   * Checks whether a contact exists for the supplied public-key address.
   * @param publicKey - Public-key address or key material used to identify or resolve a signer.
   * @returns The result of the has contact by address operation (`Promise<boolean>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async hasContactByAddress(publicKey: MajikKeyAddress): Promise<boolean> {
    if (!publicKey?.trim())
      throw new Error("Invalid contact public key address");
    return await this._contacts.hasContactByAddress(publicKey);
  }

  /**
   * Returns a contact associated with the supplied public-key address.
   * @param address - Public-key address used to identify a contact or signer.
   * @returns The result of the get contact by address operation (`Promise<MajikInvoiceContact | null>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async getContactByAddress(
    address: MajikKeyAddress,
  ): Promise<MajikInvoiceContact | null> {
    if (!address?.trim()) throw new Error("Invalid public key address");
    return (await this._contacts.getContactByAddress(address)) ?? null;
  }

  /**
   * Returns contacts matching the supplied identifiers.
   * @param ids - Collection of entity identifiers to resolve.
   * @param strict - Whether missing or unmatched entities should be treated as an error instead of being skipped.
   * @returns The result of the get contacts by i d operation (`MajikInvoiceContact[]`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  getContactsByID(ids: string[], strict = false): MajikInvoiceContact[] {
    if (!ids?.length) throw new Error("At least 1 id is required");
    return this._contacts.getContactsByIds(ids, strict);
  }

  /**
   * Returns contacts matching the supplied public keys.
   * @param publicKeys - Collection of public keys used to resolve contacts or verify signatures.
   * @returns The result of the get contacts by public key operation (`Promise<MajikInvoiceContact[]>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async getContactsByPublicKey(
    publicKeys: string[],
  ): Promise<MajikInvoiceContact[]> {
    if (!publicKeys?.length)
      throw new Error("At least 1 public key is required");
    return await this._contacts.getContactsByPublicKeys(publicKeys);
  }

  /**
   * Exports a contact as a JSON string suitable for storage or transport.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the export contact as j s o n operation (`Promise<string | null>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async exportContactAsJSON(id: string): Promise<string | null> {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.exportContactAsJSON(id);
  }

  /**
   * Exports a contact using the contact manager string representation.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the export contact as string operation (`Promise<string | null>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async exportContactAsString(id: string): Promise<string | null> {
    if (!id?.trim()) throw new Error("Invalid contact ID");
    return this._contacts.exportContactAsString(id);
  }

  /**
   * Imports a contact from its JSON representation.
   * @param jsonStr - Serialized contact JSON string.
   * @returns The result of the import contact from j s o n operation (`Promise<MAJIK_API_RESPONSE>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async importContactFromJSON(jsonStr: string): Promise<MAJIK_API_RESPONSE> {
    if (!jsonStr?.trim()) throw new Error("Invalid contact JSON");
    return this._contacts.importContactFromJSON(jsonStr);
  }

  /**
   * Imports a contact from the contact manager string representation.
   * @param base64Str - Base64-encoded serialized contact or backup value.
   * @returns The result of the import contact from string operation (`Promise<MAJIK_API_RESPONSE>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async importContactFromString(
    base64Str: string,
  ): Promise<MAJIK_API_RESPONSE> {
    if (!base64Str?.trim()) throw new Error("Invalid contact string");

    const response = await this._contacts.importContactFromString(base64Str);

    if (response.success) {
      this._emit("new-contact", response.data);
    } else {
      this._emit("error", response.message);
    }

    return response;
  }

  /**
   * Exports a contact as a compressed, portable base64 representation.
   * @param contact - Majik contact record to add, export, or otherwise operate on.
   * @returns The result of the export contact compressed operation (`Promise<string>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async exportContactCompressed(contact: MajikInvoiceContact): Promise<string> {
    if (!contact?.id?.trim()) throw new Error("Invalid contact");
    return this._contacts.exportContactCompressed(contact);
  }

  /**
   * Imports a contact from a compressed base64 representation.
   * @param base64Str - Base64-encoded serialized contact or backup value.
   * @returns The result of the import contact compressed operation (`Promise<MajikInvoiceContact>`).
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async importContactCompressed(
    base64Str: string,
  ): Promise<MajikInvoiceContact> {
    if (!base64Str?.trim()) throw new Error("Invalid contact string");
    return this._contacts.importContactCompressed(base64Str);
  }

  /**
   * Adds a contact to the shared contact directory and records the corresponding activity event.
   * @param contact - Majik contact record to add, export, or otherwise operate on.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async addContact(contact: MajikInvoiceContact): Promise<void> {
    if (
      !contact?.id ||
      !contact?.publicKey ||
      !contact?.fingerprint ||
      !contact?.mlKey
    ) {
      throw new Error("Invalid contact — missing required fields");
    }
    await this._contacts.addContact(contact);

    this._recordActivity(this.getActiveAccountKey()?.fingerprint, {
      reference_id: contact.id,
      action: AuditActions.CONTACT_ADDED, // ⚠️ verify member name
      metadata: { contactFingerprint: contact.fingerprint },
    });

    this._emit("new-contact", contact);
  }

  /**
   * Removes a contact from the shared contact directory.
   * @param id - Unique identifier of the target entity.
   * @returns Completes when the operation has finished.
   * @throws {Error} When validation fails, required local data is unavailable, or the underlying operation cannot be completed.
   */
  async removeContact(id: string): Promise<void> {
    const result = await this._contacts.removeContact(id);
    if (!result.success) throw new Error(result.message);

    this._recordActivity(this.getActiveAccountKey()?.fingerprint, {
      reference_id: id,
      action: AuditActions.CONTACT_DELETED, // ⚠️
    });

    this._emit("removed-contact", id);
  }

  /**
   * Lists contacts, optionally including the client’s own accounts and restricting results to Majikah contacts.
   * @param includeOwnAccounts - Whether the returned contact collection should include the client’s own accounts.
   * @param majikahOnly - Whether to restrict results to Majikah contacts.
   * @returns The result of the list contacts operation (`MajikInvoiceContact[]`).
   */
  listContacts(
    includeOwnAccounts = false,
    majikahOnly: boolean = false,
  ): MajikInvoiceContact[] {
    const contacts = this._contacts.listContacts(true, majikahOnly);
    if (includeOwnAccounts) return contacts;
    const ownIds = new Set(this.listOwnAccounts().map((a) => a.id));
    return contacts.filter((c) => !ownIds.has(c.id));
  }

  /**
   * Updates metadata for a contact in the shared directory.
   * @param id - Unique identifier of the target entity.
   * @param meta - Optional metadata associated with the contact, account, or group.
   * @returns Completes when the operation has finished.
   */
  async updateContactMeta(
    id: string,
    meta: Partial<MajikInvoiceContactMeta>,
  ): Promise<void> {
    await this._contacts.updateContactMeta(id, meta);
  }

  /**
   * Creates a contact group and optionally populates it with initial members.
   * @param id - Unique identifier of the target entity.
   * @param name - Human-readable name for the new or existing asset.
   * @param meta - Optional metadata associated with the contact, account, or group.
   * @param initialMemberIds - Optional contact identifiers to add when the group is created.
   * @returns The result of the create group operation (`Promise<this>`).
   */
  async createGroup(
    id: string,
    name: string,
    meta?: Partial<Omit<MajikInvoiceContactGroupMeta, "name">>,
    initialMemberIds?: string[],
  ): Promise<this> {
    const newGroup = await this._contacts.createGroup(
      id,
      name,
      meta,
      initialMemberIds,
    );
    this._emit("new-contact-group", newGroup);
    return this;
  }

  /**
   * Adds an existing contact group to the directory.
   * @param group - Value used by the add group operation.
   * @returns The result of the add group operation (`Promise<this>`).
   */
  async addGroup(group: MajikInvoiceContactGroup): Promise<this> {
    await this._contacts.addGroup(group);
    this._emit("new-contact-group", group);
    return this;
  }

  /**
   * Removes a contact group from the directory.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the remove group operation (`Promise<MAJIK_API_RESPONSE>`).
   */
  async removeGroup(id: string): Promise<MAJIK_API_RESPONSE> {
    const response = await this._contacts.removeGroup(id);
    this._emit(
      "removed-contact-group",
      response.data as MajikInvoiceContactGroup,
    );
    return response;
  }

  /**
   * Returns a contact group by identifier, or undefined when it is not present.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the get contact group operation (`MajikInvoiceContactGroup | undefined`).
   */
  getContactGroup(id: string): MajikInvoiceContactGroup | undefined {
    return this._contacts.getGroup(id);
  }

  /**
   * Returns a contact group by identifier and throws when it cannot be found.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the get group or throw operation (`MajikInvoiceContactGroup`).
   */
  getGroupOrThrow(id: string): MajikInvoiceContactGroup {
    return this._contacts.getGroupOrThrow(id);
  }

  /**
   * Checks whether a contact group exists.
   * @param id - Unique identifier of the target entity.
   * @returns The result of the has group operation (`boolean`).
   */
  hasGroup(id: string): boolean {
    return this._contacts.hasGroup(id);
  }

  /**
   * Lists contact groups with optional inclusion of system groups and name sorting.
   * @param includeSystem - Whether system-managed groups should be included.
   * @param sortedByName - Whether groups should be sorted by display name.
   * @returns The result of the list contact groups operation (`MajikInvoiceContactGroup[]`).
   */
  listContactGroups(
    includeSystem = true,
    sortedByName = false,
  ): MajikInvoiceContactGroup[] {
    return this._contacts.listGroups(includeSystem, sortedByName);
  }

  /**
   * Lists user-created contact groups.
   * @param sortedByName - Whether groups should be sorted by display name.
   * @returns The result of the list user groups operation (`MajikInvoiceContactGroup[]`).
   */
  listUserGroups(sortedByName = true): MajikInvoiceContactGroup[] {
    return this._contacts.listGroups(false, sortedByName);
  }

  /**
   * Lists system-managed contact groups.
   * @returns The result of the list system groups operation (`MajikInvoiceContactGroup[]`).
   */
  listSystemGroups(): MajikInvoiceContactGroup[] {
    return this._contacts.listGroups(true).filter((g) => g.isSystem);
  }

  /**
   * Updates mutable metadata for a contact group.
   * @param id - Unique identifier of the target entity.
   * @param meta - Optional metadata associated with the contact, account, or group.
   * @returns The result of the update group meta operation (`Promise<this>`).
   */
  async updateGroupMeta(
    id: string,
    meta: Partial<
      Pick<MajikInvoiceContactGroupMeta, "name" | "description" | "color">
    >,
  ): Promise<this> {
    const updatedGroup = await this._contacts.updateGroupMeta(id, meta);
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Adds one contact to a contact group.
   * @param groupID - Identifier of the target contact group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the add contact to group operation (`Promise<this>`).
   */
  async addContactToGroup(groupID: string, contactID: string): Promise<this> {
    const updatedGroup = await this._contacts.addContactToGroup(
      groupID,
      contactID,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Adds multiple contacts to a contact group.
   * @param groupID - Identifier of the target contact group.
   * @param contactIds - Collection of contact identifiers to add to the group.
   * @returns The result of the add contacts to group operation (`Promise<this>`).
   */
  async addContactsToGroup(
    groupID: string,
    contactIds: string[],
  ): Promise<this> {
    const updatedGroup = await this._contacts.addContactsToGroup(
      groupID,
      contactIds,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Removes one contact from a contact group.
   * @param groupID - Identifier of the target contact group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the remove contact from group operation (`Promise<this>`).
   */
  async removeContactFromGroup(
    groupID: string,
    contactID: string,
  ): Promise<this> {
    const updatedGroup = await this._contacts.removeContactFromGroup(
      groupID,
      contactID,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Moves a contact from one group to another.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @param fromGroupId - Identifier of the source contact group.
   * @param toGroupId - Identifier of the destination contact group.
   * @returns The result of the move contact between groups operation (`Promise<this>`).
   */
  async moveContactBetweenGroups(
    contactID: string,
    fromGroupId: string,
    toGroupId: string,
  ): Promise<this> {
    const updatedGroup = await this._contacts.moveContactBetweenGroups(
      contactID,
      fromGroupId,
      toGroupId,
    );
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Returns contacts belonging to a contact group.
   * @param groupID - Identifier of the target contact group.
   * @returns The result of the get contacts in group operation (`MajikInvoiceContact[]`).
   */
  getContactsInGroup(groupID: string): MajikInvoiceContact[] {
    return this._contacts.getContactsInGroup(groupID);
  }

  /**
   * Returns contacts belonging to a contact group in sorted order.
   * @param groupID - Identifier of the target contact group.
   * @returns The result of the get contacts in group sorted operation (`MajikInvoiceContact[]`).
   */
  getContactsInGroupSorted(groupID: string): MajikInvoiceContact[] {
    return this._contacts.getContactsInGroupSorted(groupID);
  }

  /**
   * Checks whether a contact belongs to a contact group.
   * @param groupID - Identifier of the target contact group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the is contact in group operation (`boolean`).
   */
  isContactInGroup(groupID: string, contactID: string): boolean {
    return this._contacts.isContactInGroup(groupID, contactID);
  }

  /**
   * Returns all groups containing the specified contact.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the get groups for contact operation (`MajikInvoiceContactGroup[]`).
   */
  getGroupsForContact(contactID: string): MajikInvoiceContactGroup[] {
    return this._contacts.getGroupsForContact(contactID);
  }

  /**
   * Returns the identifiers of groups containing the specified contact.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the get group ids for contact operation (`string[]`).
   */
  getGroupIdsForContact(contactID: string): string[] {
    return this._contacts.getGroupIdsForContact(contactID);
  }

  /**
   * Adds a contact to the built-in favorites group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the add contact to favorites operation (`Promise<this>`).
   */
  async addContactToFavorites(contactID: string): Promise<this> {
    const updatedGroup = await this._contacts.addToFavorites(contactID);
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Removes a contact from the built-in favorites group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the remove contact from favorites operation (`Promise<this>`).
   */
  async removeContactFromFavorites(contactID: string): Promise<this> {
    const updatedGroup = await this._contacts.removeFromFavorites(contactID);
    this._emit("contact-group-change", updatedGroup);
    return this;
  }

  /**
   * Checks whether a contact is in the favorites group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the is contact favorite operation (`boolean`).
   */
  isContactFavorite(contactID: string): boolean {
    return this._contacts.isFavorite(contactID);
  }
  /**
   * Checks whether a contact is in the blocked group.
   * @param contactID - Contact identifier used to resolve the member being updated.
   * @returns The result of the is contact blocked operation (`boolean`).
   */
  isContactBlocked(contactID: string): boolean {
    return this._contacts.isContactBlocked(contactID);
  }
  /**
   * Returns the built-in favorites group.
   * @returns The result of the get favorites group operation (`MajikInvoiceContactGroup`).
   */
  getFavoritesGroup(): MajikInvoiceContactGroup {
    return this._contacts.getFavoritesGroup();
  }
  /**
   * Returns the built-in blocked group.
   * @returns The result of the get blocked group operation (`MajikInvoiceContactGroup`).
   */
  getBlockedGroup(): MajikInvoiceContactGroup {
    return this._contacts.getBlockedGroup();
  }

  /**
   * Returns all contacts in the favorites group.
   * @returns The result of the get favorite contacts operation (`MajikInvoiceContact[]`).
   */
  getFavoriteContacts(): MajikInvoiceContact[] {
    return this._contacts.getContactsInGroup(
      this._contacts.getFavoritesGroup().id,
    );
  }

  /**
   * Returns all contacts in the blocked group.
   * @returns The result of the get blocked contacts operation (`MajikInvoiceContact[]`).
   */
  getBlockedContacts(): MajikInvoiceContact[] {
    return this._contacts.getContactsInGroup(
      this._contacts.getBlockedGroup().id,
    );
  }

  /**
   * Clears the shared contact directory and returns the client for chaining.
   * @returns The result of the clear directory operation (`Promise<this>`).
   */
  async clearDirectory(): Promise<this> {
    await this._contacts.clear();
    return this;
  }

  /**
   * Resolves a human-readable signer label from owned accounts or the contact directory.
   * @param signerId - Signer identifier whose display label should be resolved.
   * @returns The result of the resolve signer label operation (`string`).
   */
  resolveSignerLabel(signerId: string): string {
    const ownAccount = this._ownAccounts.get(signerId);
    if (ownAccount?.meta?.label) return ownAccount.meta.label;
    const contact = this._contacts.getContact(signerId);
    if (contact?.meta?.label) return contact.meta.label;
    return `${signerId.slice(0, 16)}…`;
  }

  async getContactByPublicKey(
    publicKeyBase64: string,
  ): Promise<MajikInvoiceContact | null> {
    if (!publicKeyBase64?.trim()) throw new Error("Invalid public key");
    return (await this._contacts.getContactByAddress(publicKeyBase64)) ?? null;
  }

  async getMajikRecipientsByPublicKey(
    publicKeys: string[],
    strict?: boolean,
  ): Promise<MajikRecipient[]> {
    return await this._contacts.getMajikRecipients(
      "public_key",
      publicKeys,
      strict,
    );
  }

  async getExpectedSignersByPublicKey(
    publicKeys: string[],
    strict?: boolean,
  ): Promise<ExpectedSigner[]> {
    return await this._contacts.getExpectedSigners(
      "public_key",
      publicKeys,
      strict,
    );
  }

  async getMajikahInvoiceDataByPublicKey(
    publicKeys: string[],
    strict?: boolean,
  ): Promise<{
    recipients: MajikRecipient[];
    signers: ExpectedSigner[];
    publicKeys: MajikMessagePublicKey[];
  }> {
    return await this._contacts.getMajikahInvoiceData(
      "public_key",
      publicKeys,
      strict,
    );
  }

  async getMajikRecipientsByIDs(
    ids: string[],
    strict?: boolean,
  ): Promise<MajikRecipient[]> {
    return await this._contacts.getMajikRecipients("id", ids, strict);
  }

  async getExpectedSignersByIDs(
    ids: string[],
    strict?: boolean,
  ): Promise<ExpectedSigner[]> {
    return await this._contacts.getExpectedSigners("id", ids, strict);
  }

  async getMajikahInvoiceDataByID(
    ids: string[],
    strict?: boolean,
  ): Promise<{
    recipients: MajikRecipient[];
    signers: ExpectedSigner[];
    publicKeys: MajikMessagePublicKey[];
  }> {
    return await this._contacts.getMajikahInvoiceData("id", ids, strict);
  }

  async updateActiveAccountMeta(
    meta: Partial<MajikInvoiceContactMeta>,
  ): Promise<void> {
    const active = this.getActiveAccount();
    if (!active) throw new Error("No active account to update");
    const updatedContact = await this._contacts.updateContactMeta(
      active?.id,
      meta,
    );
    this._emit("updated-contact", updatedContact);
  }

  // ==========================================================================
  // ── INVOICE MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  async createInvoice(
    input: Omit<MajikInvoiceInput, "signerKey" | "recipients">,
    options?: {
      accountId?: string;
      recipientContacts?: MajikInvoiceContact[];
      expectedSigners?: ExpectedSigner[];
      skipStore?: boolean;
    },
  ): Promise<MajikInvoice> {
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "createInvoice",
    );
    let recipients: MajikRecipient[] | undefined;
    if (input.mode === "encrypted-and-signed") {
      const keyRecipients = MajikInvoiceContact.toMajikContacts(
        options?.recipientContacts,
      );
      recipients =
        await MajikEnvelope.buildMajikRecipientsFromContacts(keyRecipients);
    }
    try {
      const invoice = await MajikInvoice.create({
        ...input,
        signerKey,
        recipients,
        expectedSigners: options?.expectedSigners,
      });
      if (!options?.skipStore) {
        // 🔥 increment here (ONLY if you're assigning number here)
        await this._state.incrementInvoiceNumber();
        await this._invoices.save(invoice);
      }

      this._emit("invoice-created", invoice);
      return invoice;
    } catch (err) {
      this._emit("error", err, { context: "createInvoice" });
      throw err;
    }
  }

  async getInvoice(id: string): Promise<MajikInvoice | undefined> {
    return this._invoices.getById(id);
  }

  async getInvoiceOrThrow(id: string): Promise<MajikInvoice> {
    const invoice = await this._invoices.getByIdOrThrow(id);
    if (!invoice)
      throw new MajikInvoiceError(`Invoice "${id}" not found in store.`);
    return invoice;
  }

  async clearInvoices(): Promise<void> {
    await this._invoices.clear();
    this._emit("invoice-clear");
  }

  listInvoices(): MajikInvoice[] {
    return this._invoices.query({ sortBy: "createdAt", sortDir: "desc" }).items;
  }

  queryInvoices(opts: InvoiceQueryOptions = {}): InvoiceQueryResult {
    return this._invoices.query(opts);
  }

  async queryInvoicesAdvanced(
    opts: InvoiceAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<InvoiceQueryResult> {
    return this._invoices.queryAdvanced(opts, source);
  }

  /** Invoices signed/owned by the active account. */
  async listInvoicesByActiveAccount(
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    const key = this.getActiveAccountKey();
    if (!key) return [];
    return this._invoices.listByPublicKey(key.fingerprint, source);
  }

  async listInvoicesByIssuedAtRange(
    range: InvoiceDateRangeFilter,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return this._invoices.listByIssuedAtRange(range, source);
  }

  async listInvoicesByCreatedAtRange(
    range: InvoiceDateRangeFilter,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return this._invoices.listByCreatedAtRange(range, source);
  }

  async listInvoicesByMode(
    mode: MajikInvoiceMode,
    source?: StorageSource,
  ): Promise<MajikInvoice[]> {
    return this._invoices.listByMode(mode, source);
  }

  listInvoicesByIssuer(issuerName: string): MajikInvoice[] {
    return this._invoices.query({ issuerName }).items;
  }

  listInvoicesByRecipient(recipientName: string): MajikInvoice[] {
    return this._invoices.query({ recipientName }).items;
  }

  listInvoicesByStatus(
    status: MajikInvoiceStatus | MajikInvoiceStatus[],
  ): MajikInvoice[] {
    return this._invoices.query({ status }).items;
  }

  hasInvoice(id: string): boolean {
    return this._invoices.has(id);
  }

  async storeInvoice(invoice: MajikInvoice): Promise<void> {
    const exists = this.hasInvoice(invoice.id); // check BEFORE save

    await this._invoices.save(invoice);

    if (!exists) {
      await this._state.incrementInvoiceNumber();
      this._emit("invoice-created", invoice);
    } else {
      this._emit("invoice-updated", invoice);
    }
  }

  async removeInvoice(id: string): Promise<boolean> {
    const removed = await this._invoices.remove(id);
    if (removed) this._emit("invoice-removed", id);
    return removed;
  }

  // ── INVOICE OWNERSHIP QUERIES ─────────────────────────────────────────────

  /**
   * Returns all invoices in the store that are not associated with the
   * active account's key fingerprint. Useful for notifying the user that
   * invoices from other accounts are present.
   *
   * Returns an empty array if there is no active account.
   */
  async getInvoicesNotOwnedByActiveAccount(): Promise<MajikInvoice[]> {
    const key = this.getActiveAccountKey();
    if (!key) return [];
    const result = await this._invoices.queryAdvanced({
      excludePublicKey: key.fingerprint,
    });
    return result.items;
  }

  /**
   * Returns the count of invoices not associated with the active account's
   * key fingerprint. Lightweight — hits COUNT(*) at the SQL level when
   * backed by the SQLite adapter.
   *
   * Returns 0 if there is no active account.
   */
  async countInvoicesNotOwnedByActiveAccount(): Promise<number> {
    const key = this.getActiveAccountKey();
    if (!key) return 0;
    return this._invoices.countAdvanced({
      excludePublicKey: key.fingerprint,
    });
  }

  async signInvoice(
    invoiceOrId: string | MajikInvoice,
    options?: {
      accountId?: string;
      expectedSigners?: ExpectedSigner[];
      timestamp?: string;
    },
  ): Promise<MajikInvoice> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    const signerKey = this._resolveSignerKey(options?.accountId, "signInvoice");

    try {
      const signed = await invoice.sign(signerKey, {
        expectedSigners: options?.expectedSigners,
        timestamp: options?.timestamp,
      });
      await this._invoices.save(signed); // always save the result
      this._emit("invoice-signed", signed);
      return signed;
    } catch (err) {
      this._emit("error", err, { context: "signInvoice", invoiceOrId });
      throw err;
    }
  }

  /**
   * Sign a file and embed the signature directly into it using the active account.
   *
   * Format is auto-detected from magic bytes — PDF stays PDF, WAV stays WAV, etc.
   * Strips any existing signature before signing (idempotent re-signing).
   * The active account is unlocked automatically if needed.
   *
   * @example
   *   const { blob: signedPdf } = await majik.signFile(pdfBlob);
   *   // signedPdf is a valid PDF with the signature embedded in its metadata
   *
   * @example — non-active account
   *   const { blob } = await majik.signFile(wavBlob, { accountId: "acc_xyz" });
   */
  async signFile(
    file: Blob,
    options?: {
      contentType?: string;
      timestamp?: string;
      mimeType?: string;
      accountId?: string;
      expectedSigners?: ExpectedSigner[]; // add this
    },
  ): Promise<{
    blob: Blob;
    signature: MajikSignature;
    handler: string;
    mimeType: string;
  }> {
    const id = options?.accountId ?? this.getActiveAccount()?.id;
    if (!id)
      throw new Error("No active account — call setActiveAccount() first");

    try {
      await this._keys.ensureUnlocked(id);
      const key = this._keys.get(id);
      if (!key) throw new Error(`Account not found in keystore: "${id}"`);
      if (!key.hasSigningKeys) {
        throw new Error(
          `Account "${id}" has no signing keys. ` +
            `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
        );
      }

      return MajikSignature.signFile(file, key, {
        contentType: options?.contentType,
        timestamp: options?.timestamp,
        mimeType: options?.mimeType,
        expectedSigners: options?.expectedSigners,
      });
    } catch (err) {
      this._emit("error", err, { context: "signFile" });
      throw err;
    }
  }

  async signExternalInvoice(
    invoice: MajikInvoice,
    options?: {
      accountId?: string;
      expectedSigners?: ExpectedSigner[];
      timestamp?: string;
    },
  ): Promise<MajikInvoice> {
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "signExternalInvoice",
    );
    try {
      return await invoice.sign(signerKey, {
        expectedSigners: options?.expectedSigners,
        timestamp: options?.timestamp,
      });
    } catch (err) {
      this._emit("error", err, { context: "signExternalInvoice" });
      throw err;
    }
  }

  async sealInvoice(
    invoiceOrId: string | MajikInvoice,
    options?: { accountId?: string; timestamp?: string },
  ): Promise<MajikInvoice> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    const key = this._resolveKey(options?.accountId, "sealInvoice");
    try {
      const sealed = await invoice.seal(key, { timestamp: options?.timestamp });
      await this._invoices.save(sealed);
      this._emit("invoice-sealed", sealed);
      return sealed;
    } catch (err) {
      this._emit("error", err, { context: "sealInvoice", invoiceOrId });
      throw err;
    }
  }

  async decryptInvoice(
    invoiceOrId: string | MajikInvoice,
    options?: { accountId?: string },
  ): Promise<InvoiceDecryptionResult> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    const key = this._resolveKey(options?.accountId, "decryptInvoice");
    try {
      const decryptionResult = await invoice.decrypt(key);
      // Update the stored invoice so the cache persists in the manager
      await this._invoices.save(decryptionResult.instance);
      this._emit(
        "invoice-decrypted",
        decryptionResult.instance,
        decryptionResult.invoice,
      );
      return decryptionResult;
    } catch (err) {
      this._emit("error", err, { context: "decryptInvoice", invoiceOrId });
      throw err;
    }
  }

  async batchExportInvoicesToCSV(
    invoices: MajikInvoice[],
    options?: { accountId?: string; columns?: CSVColumn[] },
  ): Promise<CSVExportResult> {
    const key = this._resolveKey(options?.accountId, "decryptInvoice");
    try {
      const result = await MajikInvoice.batchExportToCSV(invoices, {
        columns: options?.columns,
        decryptKey: key,
      });

      this._emit("invoice-export-csv", result);
      return result;
    } catch (err) {
      this._emit("error", err, { context: "exportInvoicesCSV", invoices });
      throw err;
    }
  }

  // ── New public method ─────────────────────────────────────────────────────

  /**
   * Decrypts all cached invoices using the active (or specified) account key.
   * Call this after a successful unlock to populate decrypted caches.
   *
   * Emits "invoice-decrypted-batch" with the BatchDecryptResult on completion.
   * Throws if the account is missing or the key cannot be unlocked.
   */
  async decryptCachedInvoices(accountId?: string): Promise<BatchDecryptResult> {
    const account = accountId
      ? this.getOwnAccountById(accountId)
      : this.getActiveAccount();

    if (!account) {
      throw new MajikInvoiceError(
        "decryptCachedInvoices: no account found. " +
          "Pass an accountId or set an active account first.",
      );
    }

    await this.ensureIdentityUnlocked(account.id);

    const key = this._keys.get(account.id);
    if (!key) {
      throw new MajikInvoiceError(
        `decryptCachedInvoices: key for account "${account.id}" not found in keystore.`,
      );
    }

    const result = await MajikInvoice.batchDecrypt(
      this._invoices.listCached(),
      key,
    );

    await Promise.all(
      result.decrypted.map((instance) => this._invoices.save(instance)),
    );

    this._emit("invoice-decrypted-batch", result);
    return result;
  }

  /**
   * Decrypts all provided invoices using the active (or specified) account key.
   * Call this after a successful unlock to populate decrypted caches.
   *
   * Emits "invoice-decrypted-batch" with the BatchDecryptResult on completion.
   * Throws if the account is missing or the key cannot be unlocked.
   */
  async decryptInvoices(
    invoices: MajikInvoice[],
    accountId?: string,
  ): Promise<BatchDecryptResult> {
    const account = accountId
      ? this.getOwnAccountById(accountId)
      : this.getActiveAccount();

    if (!account) {
      throw new MajikInvoiceError(
        "decryptCachedInvoices: no account found. " +
          "Pass an accountId or set an active account first.",
      );
    }

    await this.ensureIdentityUnlocked(account.id);

    const key = this._keys.get(account.id);
    if (!key) {
      throw new MajikInvoiceError(
        `decryptCachedInvoices: key for account "${account.id}" not found in keystore.`,
      );
    }

    const result = await MajikInvoice.batchDecrypt(invoices, key);

    await Promise.all(
      result.decrypted.map((instance) => this._invoices.save(instance)),
    );

    this._emit("invoice-decrypted-batch", result);
    return result;
  }

  async unlockInvoice(
    invoiceOrId: string | MajikInvoice,
    options?: { accountId?: string },
  ): Promise<MajikInvoice> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    const key = this._resolveKey(options?.accountId, "decryptInvoice");
    try {
      const { instance } = await invoice.decrypt(key);
      this._emit("invoice-decrypted", instance);
      return instance;
    } catch (err) {
      this._emit("error", err, { context: "decryptInvoice", invoiceOrId });
      throw err;
    }
  }

  async duplicateInvoice(
    invoiceOrId: string | MajikInvoice,
    options?: { account?: string | MajikKey },
  ): Promise<MajikInvoice> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    const key = this._resolveKey(options?.account, "duplicateInvoice");
    try {
      const duplicatedInvoice = await invoice.duplicate(key);
      const withFreshCache = duplicatedInvoice.isEncrypted
        ? duplicatedInvoice.withDecryptedCache(invoice.invoice, key.fingerprint)
        : duplicatedInvoice;
      return withFreshCache;
    } catch (err) {
      this._emit("error", err, { context: "duplicateInvoice", invoiceOrId });
      throw err;
    }
  }

  async canDecryptInvoice(
    invoiceOrId: string | MajikInvoice,
    accountId?: string,
  ): Promise<boolean> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    if (!invoice) return false;
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id) return false;
    const key = this._keys.get(id);
    if (!key) return false;
    return invoice.canDecrypt(key);
  }

  async verifyInvoiceSignatures(
    invoiceOrId: string | MajikInvoice,
  ): Promise<VerificationResult[]> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    try {
      const results = await invoice.verifySignatures();
      this._emit("invoice-verified", invoice, results);
      return results;
    } catch (err) {
      this._emit("error", err, {
        context: "verifyInvoiceSignatures",
        invoiceOrId,
      });
      throw err;
    }
  }

  async verifyInvoiceSignature(
    invoiceOrId: string | MajikInvoice,
    signerId: string,
  ): Promise<VerificationResult> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    try {
      const result = await invoice.verifySignature(signerId);
      this._emit("invoice-verified", invoice, result);
      return result;
    } catch (err) {
      this._emit("error", err, {
        context: "verifyInvoiceSignature",
        invoiceOrId,
      });
      throw err;
    }
  }

  async verifyInvoiceSeal(
    invoiceOrId: string | MajikInvoice,
  ): Promise<SealVerificationResult> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    try {
      return await invoice.verifySeal();
    } catch (err) {
      this._emit("error", err, { context: "verifyInvoiceSeal", invoiceOrId });
      throw err;
    }
  }

  async validateInvoice(
    invoiceId: string,
  ): Promise<MajikInvoiceValidationResult> {
    return (await this.getInvoiceOrThrow(invoiceId)).validate();
  }

  async reissueInvoice(
    invoiceOrId: string | MajikInvoice,
    updatedInvoice: GeneralInvoice,
    options?: {
      accountId?: string;
      recipientContactIds?: string[];
    },
  ): Promise<MajikInvoice> {
    const original = await this._resolveInvoice(invoiceOrId);
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "reissueInvoice",
    );

    const { publicKeys, recipients, signers } =
      await this._contacts.getMajikahInvoiceData(
        "id",
        options?.recipientContactIds || [],
        false,
      );
    try {
      const reissued = await original.reissue(updatedInvoice, {
        signerKey,
        recipients,
        expectedSigners: signers,
        recipientPublicKeys: publicKeys,
      });

      // For encrypted invoices: the reissued instance carries the OLD decrypted
      // cache from the original. Stamp the updated GeneralInvoice as the fresh
      // cache so callers get the correct content without needing to re-decrypt.
      const withFreshCache = reissued.isEncrypted
        ? reissued.withDecryptedCache(updatedInvoice, signerKey.fingerprint)
        : reissued;

      await this._invoices.save(withFreshCache);
      this._emit("invoice-reissued", withFreshCache, original);
      return withFreshCache;
    } catch (err) {
      this._emit("error", err, { context: "reissueInvoice", invoiceOrId });
      throw err;
    }
  }

  async restartInvoice(
    invoiceOrId: string | MajikInvoice,
    options?: {
      accountId?: string;
    },
  ): Promise<MajikInvoice> {
    const original = await this._resolveInvoice(invoiceOrId);
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "reissueInvoice",
    );
    try {
      if (original.isEncrypted) {
        const convertedSigned = await original.toSignedOnly(
          signerKey,
          signerKey,
          {
            dropSignatures: true,
          },
        );
        const newInvoice = await convertedSigned.restartInvoice(signerKey);
        await this._invoices.save(newInvoice);
        this._emit("invoice-reissued", newInvoice, original);
        return newInvoice;
      } else {
        const newInvoice = await original.restartInvoice(signerKey);
        await this._invoices.save(newInvoice);
        this._emit("invoice-reissued", newInvoice, original);
        return newInvoice;
      }
    } catch (err) {
      this._emit("error", err, { context: "reissueInvoice", invoiceOrId });
      throw err;
    }
  }

  async setInvoiceMode(
    invoiceOrId: string | MajikInvoice,
    newMode: MajikInvoiceMode,
    options?: {
      accountId?: string;
      recipientContacts?: MajikInvoiceContact[];
      expectedSigners?: ExpectedSigner[];
    },
  ): Promise<MajikInvoice> {
    const original = await this._resolveInvoice(invoiceOrId);
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "reissueInvoice",
    );
    let recipients: MajikRecipient[] | undefined;
    if (original.mode === "encrypted-and-signed") {
      const keyRecipients = MajikInvoiceContact.toMajikContacts(
        options?.recipientContacts,
      );
      recipients =
        await MajikEnvelope.buildMajikRecipientsFromContacts(keyRecipients);
    }
    try {
      const reissued = await original.setMode(newMode, {
        signerKey,
        recipients,
        expectedSigners: options?.expectedSigners,
        decryptKey: signerKey,
      });
      await this._invoices.save(reissued);
      this._emit("invoice-reissued", reissued, original);
      return reissued;
    } catch (err) {
      this._emit("error", err, { context: "setInvoiceMode", invoiceOrId });
      throw err;
    }
  }

  async canSignInvoice(
    invoiceOrId: string | MajikInvoice,
    accountId?: string,
  ): Promise<{ permitted: boolean; reason?: string }> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    if (!invoice)
      return {
        permitted: false,
        reason: `Invoice "${invoiceOrId}" not found.`,
      };
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id) return { permitted: false, reason: "No active account." };
    const key = this._keys.get(id);
    if (!key)
      return {
        permitted: false,
        reason: `Account "${id}" not found in keystore.`,
      };

    const canSignResult = invoice.canSign(key);
    const hasSignedResult = invoice.hasSigned(key);
    const finalResponse = {
      permitted: canSignResult.permitted && !hasSignedResult,
      reason: hasSignedResult
        ? "Invoice already signed."
        : canSignResult.reason,
    };

    return finalResponse;
  }

  async canSealInvoice(
    invoiceOrId: string | MajikInvoice,
    accountId?: string,
  ): Promise<{ permitted: boolean; reason?: string }> {
    const invoice = await this._resolveInvoice(invoiceOrId);
    if (!invoice)
      return {
        permitted: false,
        reason: `Invoice "${invoiceOrId}" not found.`,
      };
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id) return { permitted: false, reason: "No active account." };
    const key = this._keys.get(id);
    if (!key)
      return {
        permitted: false,
        reason: `Account "${id}" not found in keystore.`,
      };
    return invoice.canSeal(key);
  }

  async getInvoicePublicSummary(
    invoiceId: string,
  ): Promise<PublicInvoiceSummary> {
    return (await this.getInvoiceOrThrow(invoiceId)).public;
  }

  async getInvoiceSealInfo(invoiceId: string): Promise<SealInfo | undefined> {
    return (await this.getInvoiceOrThrow(invoiceId)).integrity.sealInfo;
  }

  importInvoice(json: string | MajikInvoiceJSON): MajikInvoice {
    const invoice = MajikInvoice.fromJSON(json);
    this._invoices.save(invoice);
    this._emit("invoice-updated", invoice);
    return invoice;
  }

  static expectedSignerFromKey(key: MajikKey): ExpectedSigner {
    return MajikSignature.expectedSignerFromKey(key);
  }

  expectedSignerFromContact(contactId: string): ExpectedSigner {
    const contact = this._contacts.getContact(contactId);
    if (!contact) throw new Error(`Contact "${contactId}" not found.`);
    if (!contact.edPublicKeyBase64 || !contact.mlDsaPublicKeyBase64) {
      throw new Error(
        `Contact "${contactId}" has no signing public keys. ` +
          `They need to share an updated contact card.`,
      );
    }
    return {
      signerId: contact.fingerprint,
      edPublicKey: contact.edPublicKeyBase64,
      mlDsaPublicKey: contact.mlDsaPublicKeyBase64,
    };
  }

  getInvoiceStats(): {
    total: number;
    draft: number;
    issued: number;
    paid: number;
    overdue: number;
    void: number;
  } {
    const all = this._invoices.query({}).items;
    return {
      total: all.length,
      draft: all.filter((i) => i.status === "draft").length,
      issued: all.filter((i) => i.status === "issued" || i.status === "sent")
        .length,
      paid: all.filter((i) => i.status === "paid").length,
      overdue: all.filter((i) => i.status === "overdue").length,
      void: all.filter((i) => i.status === "void").length,
    };
  }

  // ==========================================================================
  // ── INVOICE ORCHESTRATION (Panel-facing) ──────────────────────────────────
  // ==========================================================================

  /**
   * Reissues a MajikInvoice with an updated GeneralInvoice draft, re-signs it,
   * and stores the result. This is the shared core of save-changes,
   * status transitions, and payment recording.
   *
   * Resolves recipients and expected signers from contact IDs so the caller
   * never has to build MajikRecipient[] / ExpectedSigner[] manually.
   *
   * @returns The resigned, stored MajikInvoice.
   */
  async reissueSignAndStore(
    invoice: MajikInvoice,
    updatedDraft: GeneralInvoice,
    recipientContactIds: string[],
    options?: { accountId?: string },
  ): Promise<MajikInvoice> {
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "reissueSignAndStore",
    );

    const { publicKeys, recipients, signers } =
      await this._contacts.getMajikahInvoiceData(
        "id",
        recipientContactIds,
        true,
      );

    try {
      const reissued = await invoice.reissue(updatedDraft, {
        signerKey,
        recipients,
        expectedSigners: signers,
        recipientPublicKeys: publicKeys,
      });

      const signed = await reissued.sign(signerKey, {
        expectedSigners: signers,
      });

      // Stamp the updated GeneralInvoice as the fresh decrypted cache
      // so the panel renders the correct content without a re-decrypt round-trip.
      const withFreshCache = signed.isEncrypted
        ? signed.withDecryptedCache(updatedDraft, signerKey.fingerprint)
        : signed;

      await this._invoices.save(withFreshCache);
      this._emit("invoice-updated", withFreshCache);
      return withFreshCache;
    } catch (err) {
      this._emit("error", err, { context: "reissueSignAndStore" });
      throw err;
    }
  }

  /**
   * Creates a new MajikInvoice from a GeneralInvoice draft, signs it, stores
   * it, and increments the invoice counter — the full finalization pipeline.
   *
   * Replaces the direct MajikInvoice.create() call in InvoicePanel so the
   * panel never needs to build signerKey / recipients / expectedSigners itself.
   *
   * @returns The signed, stored MajikInvoice.
   */
  async finalizeInvoice(
    draft: GeneralInvoice,
    mode: MajikInvoiceMode,
    recipientContactIds: string[],
    options?: {
      accountId?: string;
      userId?: string;
      accountOwnerId?: string;
      status?: InvoiceStatus;
    },
  ): Promise<MajikInvoice> {
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "finalizeInvoice",
    );

    if (mode === "encrypted-and-signed" && recipientContactIds.length === 0) {
      throw new MajikInvoiceError(
        "At least one recipient contact is required for encrypted-and-signed mode.",
      );
    }

    const { publicKeys, recipients, signers } =
      await this._contacts.getMajikahInvoiceData(
        "id",
        recipientContactIds,
        true,
      );

    try {
      const invoiceInput = draft.toMajikInvoiceInput();

      const created = await MajikInvoice.create({
        ...invoiceInput,
        mode,
        signerKey,
        recipients,
        status: options?.status ?? "issued",
        userId: options?.userId,
        accountId: options?.accountOwnerId ?? options?.userId,
        expectedSigners: signers,
        recipientPublicKeys: publicKeys,
      });

      const signed = await created.sign(signerKey, {
        expectedSigners: signers,
      });

      await this._state.incrementInvoiceNumber();
      await this._invoices.save(signed);
      this._emit("invoice-created", signed);
      return signed;
    } catch (err) {
      this._emit("error", err, { context: "finalizeInvoice" });
      throw err;
    }
  }

  /**
   * Switches a finalized MajikInvoice between "signed-only" and
   * "encrypted-and-signed" modes, re-signs, and stores the result.
   *
   * Resolves recipients from contact IDs. For signed-only mode,
   * recipientContactIds is used only for expectedSigners (no encryption).
   *
   * @returns The updated, resigned, stored MajikInvoice.
   */
  async switchInvoiceMode(
    invoice: MajikInvoice,
    newMode: MajikInvoiceMode,
    recipientContactIds?: string[],
    options?: { accountId?: string; dropSignatures?: boolean },
  ): Promise<MajikInvoice> {
    // if (invoice.isSealed) {
    //   throw new MajikInvoiceError("Cannot switch mode on a sealed invoice.");
    // }

    if (invoice.mode === newMode) return invoice;

    const finalContactIds = recipientContactIds || invoice.recipients || [];

    if (newMode === "encrypted-and-signed" && finalContactIds.length === 0) {
      throw new MajikInvoiceError(
        "At least one recipient contact is required when switching to encrypted-and-signed mode.",
      );
    }

    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "switchInvoiceMode",
    );

    const isContactId = recipientContactIds && recipientContactIds.length > 0;

    const { publicKeys, recipients, signers } =
      await this._contacts.getMajikahInvoiceData(
        isContactId ? "id" : "public_key",
        isContactId ? recipientContactIds : invoice.recipients!,
        true,
      );

    const dropSignatures = options?.dropSignatures ?? false;

    let finalInvoice = invoice;

    try {
      if (dropSignatures) {
        const updated = await invoice.setMode(newMode, {
          signerKey,
          recipients:
            newMode === "encrypted-and-signed" ? recipients : undefined,
          decryptKey: signerKey,
          recipientPublicKeys: publicKeys,
          expectedSigners: signers,
          dropSignatures: true,
        });

        finalInvoice = await updated.sign(signerKey, {
          expectedSigners: signers,
        });
      } else {
        finalInvoice = await invoice.setMode(newMode, {
          recipients:
            newMode === "encrypted-and-signed" ? recipients : undefined,
          decryptKey: signerKey,
          recipientPublicKeys: publicKeys,
          dropSignatures: false,
        });
      }

      await this._invoices.save(finalInvoice);
      this._emit("invoice-updated", finalInvoice);
      return finalInvoice;
    } catch (err) {
      this._emit("error", err, { context: "switchInvoiceMode" });
      throw err;
    }
  }
  // ==========================================================================
  // ── Backup App Data ───────────────────────────────────────────────────────
  // ==========================================================================

  backupInvoices(): Blob {
    const invoices = this.listInvoices();
    const listJSON = invoices.map((inv) => inv.toJSON());
    const cj = MajikCompressedJSON.create<MajikInvoiceJSON>(listJSON);
    const payload = cj.toBinary();
    const stamped = prependMagic(MAJIK_BUWIZ_BACKUP_MAGIC.invoices, payload);
    return new Blob([stamped as BlobPart], {
      type: "application/octet-stream",
    });
  }

  backupExpenses(): Blob {
    const expenses = this.listExpenses();
    const listJSON = expenses.map((exp) => exp.toJSON());
    const cj = MajikCompressedJSON.create<ExpenseRecordJSON>(listJSON);
    const payload = cj.toBinary();
    const stamped = prependMagic(MAJIK_BUWIZ_BACKUP_MAGIC.expenses, payload);
    return new Blob([stamped as BlobPart], {
      type: "application/octet-stream",
    });
  }

  async backupContacts(): Promise<Blob> {
    // Use toJSON() so groups are included alongside contacts
    const managerJSON = await this._contacts.toJSON();
    const cj =
      MajikCompressedJSON.create<MajikInvoiceContactManagerJSON>(managerJSON);
    const payload = cj.toBinary();
    const stamped = prependMagic(MAJIK_BUWIZ_BACKUP_MAGIC.contacts, payload);
    return new Blob([stamped as BlobPart], {
      type: "application/octet-stream",
    });
  }

  async backupAppData(): Promise<Blob> {
    const invoices = this.listInvoices();
    const invoicesJSON = invoices.map((inv) => inv.toJSON());

    const expenses = this.listExpenses();
    const expensesJSON = expenses.map((exp) => exp.toJSON());
    const contactsJSON = await this._contacts.toJSON();
    const defaultSettings = await this.getInvoiceDefaults();
    const userPref = await this.getUserAppPreferences();

    const backupJSON: AppBackUpData = {
      contacts: contactsJSON,
      invoices: invoicesJSON,
      expenses: expensesJSON,
      invoiceDefaults: defaultSettings ?? undefined,
      preferences: userPref ?? undefined,
    };

    const cj = MajikCompressedJSON.create<AppBackUpData>(backupJSON);
    const payload = cj.toBinary();
    const stamped = prependMagic(MAJIK_BUWIZ_BACKUP_MAGIC.appData, payload);
    return new Blob([stamped as BlobPart], {
      type: "application/octet-stream",
    });
  }

  // ==========================================================================
  // ── EXPENSE MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  async createExpense(
    input: ExpenseRecordInput,
    options?: {
      accountId?: string;
      skipStore?: boolean;
    },
  ): Promise<ExpenseRecord> {
    const signerKey = this._resolveSignerKey(
      options?.accountId,
      "createExpense",
    );

    try {
      const expense = ExpenseRecord.create({
        ...input,
        accountId: signerKey.fingerprint,
      });
      if (!options?.skipStore) {
        await this._expenses.save(expense);
      }

      this._emit("expense-created", expense);
      return expense;
    } catch (err) {
      this._emit("error", err, { context: "createExpense" });
      throw err;
    }
  }

  async duplicateExpense(
    expenseOrId: string | ExpenseRecord,
    options?: { account?: string | MajikKey },
  ): Promise<ExpenseRecord> {
    const expense = await this._resolveExpense(expenseOrId);
    const key = this._resolveKey(options?.account, "duplicateExpense");
    try {
      const duplicatedExpense = expense.duplicate(key.fingerprint);

      return duplicatedExpense;
    } catch (err) {
      this._emit("error", err, { context: "duplicateExpense", expenseOrId });
      throw err;
    }
  }

  async getExpense(id: string): Promise<ExpenseRecord | undefined> {
    return this._expenses.getById(id);
  }

  async getExpenseOrThrow(id: string): Promise<ExpenseRecord> {
    const expense = await this._expenses.getByIdOrThrow(id);
    if (!expense)
      throw new ExpenseRecordError(`Expense "${id}" not found in store.`);
    return expense;
  }

  async clearExpenses(): Promise<void> {
    await this._expenses.clear();
    this._emit("expense-clear");
  }

  listExpenses(): ExpenseRecord[] {
    return this._expenses.query({ sortBy: "createdAt", sortDir: "desc" }).items;
  }

  queryExpenses(opts: ExpenseQueryOptions = {}): ExpenseQueryResult {
    return this._expenses.query(opts);
  }

  async queryExpensesAdvanced(
    opts: ExpenseAdvancedQueryOptions,
  ): Promise<ExpenseQueryResult> {
    return this._expenses.queryAdvanced(opts);
  }

  /** Expenses owned by the active account. */
  async listExpensesByActiveAccount(): Promise<ExpenseRecord[]> {
    const key = this.getActiveAccountKey();
    if (!key) return [];
    return this._expenses.listByPublicKey(key.fingerprint);
  }

  async listExpensesByCreatedAtRange(
    range: DateRangeFilter,
  ): Promise<ExpenseRecord[]> {
    return this._expenses.listByCreatedAtRange(range);
  }

  async listExpensesByCategory(
    category: ExpenseCategory,
  ): Promise<ExpenseRecord[]> {
    return this._expenses.listByCategory(category);
  }

  listExpensesByStatus(
    status: ExpenseRecordStatus | ExpenseRecordStatus[],
  ): ExpenseRecord[] {
    return this._expenses.query({ status }).items;
  }

  /**
   * Returns all expenses in the store that are not associated with the
   * active account's key fingerprint. Useful for notifying the user that
   * expenses from other accounts are present.
   *
   * Returns an empty array if there is no active account.
   */
  async getExpensesNotOwnedByActiveAccount(): Promise<ExpenseRecord[]> {
    const key = this.getActiveAccountKey();
    if (!key) return [];
    const result = await this._expenses.queryAdvanced({
      excludePublicKey: key.fingerprint,
    });
    return result.items;
  }

  /**
   * Returns the count of expenses not associated with the active account's
   * key fingerprint. Lightweight — hits COUNT(*) at the SQL level when
   * backed by the SQLite adapter.
   *
   * Returns 0 if there is no active account.
   */
  async countExpensesNotOwnedByActiveAccount(): Promise<number> {
    const key = this.getActiveAccountKey();
    if (!key) return 0;
    return this._expenses.countAdvanced({
      excludePublicKey: key.fingerprint,
    });
  }

  hasExpense(id: string): boolean {
    return this._expenses.has(id);
  }

  async storeExpense(record: ExpenseRecord): Promise<void> {
    const exists = this._expenses.has(record.id);
    await this._expenses.save(record);
    this._emit(exists ? "expense-updated" : "expense-created", record);
  }

  async removeExpense(id: string): Promise<boolean> {
    const removed = await this._expenses.remove(id);
    if (removed) this._emit("expense-removed", id);
    return removed;
  }

  async actualizeRecurringExpense(
    itemId: string,
    options: ActualizeOptions = {},
  ): Promise<ActualizationResult> {
    const result = await this._recurringExpenses.actualize(
      itemId,
      {
        saveRecord: (r) => this.storeExpense(r),
        isActualized: (id, month) => this._expenses.isActualized(id, month),
      },
      options,
    );
    this._emit("expense-actualized", itemId, result);
    return result;
  }

  async actualizeAllRecurringExpenses(
    options: ActualizeOptions = {},
  ): Promise<Map<string, ActualizationResult>> {
    const results = await this._recurringExpenses.actualizeAll(
      {
        saveRecord: (r) => this._expenses.save(r),
        isActualized: (id, month) => this._expenses.isActualized(id, month),
      },
      options,
    );
    this._emit("expense-actualized", null, results);
    return results;
  }

  // ==========================================================================
  // ── Restore App Data ──────────────────────────────────────────────────────
  // ==========================================================================

  // ── Private parsers (no side-effects) ─────────────────────────────────────

  private async _parseInvoicesBackup(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<MajikInvoice[]> {
    const payload = await readBackupBlob(
      input,
      MAJIK_BUWIZ_BACKUP_MAGIC.invoices,
      "invoices",
    );
    const cj =
      await MajikCompressedJSON.fromMJKCJSON<MajikInvoiceJSON[]>(payload);
    return cj.payload.map((json) => MajikInvoice.fromJSON(json));
  }

  /**
   * Parses a contacts backup blob into a ContactManagerSnapshot —
   * the raw JSON plus pre-hydrated contact instances and group list.
   * No side-effects; nothing is written to the live store.
   */
  private async _parseContactsBackup(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<ContactManagerSnapshot> {
    const payload = await readBackupBlob(
      input,
      MAJIK_BUWIZ_BACKUP_MAGIC.contacts,
      "contacts",
    );
    const cj =
      await MajikCompressedJSON.fromMJKCJSON<MajikInvoiceContactManagerJSON>(
        payload,
      );

    const managerJSON = cj.payload;

    // Hydrate a throw-away manager so callers get real instances, not raw JSON
    const tempManager = await MajikInvoiceContactManager.fromJSON(managerJSON);

    const contacts = tempManager.listContacts(false);
    // listGroups(false) = user groups only, no system groups
    const groups = tempManager.listGroups(false);

    return { managerJSON, contacts, groups };
  }

  // ── Public restore (saves to store) ───────────────────────────────────────

  async restoreInvoices(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<{ restored: number }> {
    const invoices = await this._parseInvoicesBackup(input);
    await Promise.all(invoices.map((inv) => this._invoices.save(inv)));
    return { restored: invoices.length };
  }

  /**
   * Restores contacts (and optionally groups) from a contacts backup blob.
   *
   * @param overwriteContacts  When true, existing contacts with matching IDs
   *                           are replaced. When false, only new contacts are
   *                           added and duplicates are skipped.
   * @param includeGroups      When true, user-defined groups from the backup
   *                           are merged into the live store. System groups
   *                           (Favorites, Blocked) are never overwritten.
   */
  async restoreContacts(
    input: Blob | ArrayBufferLike | ArrayBufferView,
    options: {
      overwriteContacts?: boolean;
      includeGroups?: boolean;
    } = {},
  ): Promise<{ contacts: number; groups: number }> {
    const { overwriteContacts = true, includeGroups = true } = options;

    const { contacts, groups } = await this._parseContactsBackup(input);

    let contactCount = 0;
    for (const contact of contacts) {
      const exists = !!this._contacts.getContact(contact.id);
      if (exists && !overwriteContacts) continue;
      await this.addContact(contact);
      contactCount++;
    }

    let groupCount = 0;
    if (includeGroups) {
      for (const group of groups) {
        // Skip system groups — Favorites / Blocked must never be replaced
        if (group.isSystem) continue;

        if (!this._contacts.hasGroup(group.id)) {
          await this._contacts.addGroup(group);
        } else {
          // Merge membership only — don't clobber name/meta
          for (const memberId of group.listMemberIds()) {
            // Only add members that were actually restored
            if (this._contacts.hasContact(memberId)) {
              await this._contacts.addContactToGroupIfAbsent(
                group.id,
                memberId,
              );
            }
          }
        }
        groupCount++;
      }
    }

    return { contacts: contactCount, groups: groupCount };
  }

  // ── Public read (no side-effects) ─────────────────────────────────────────

  async readInvoicesBackup(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<MajikInvoice[]> {
    return this._parseInvoicesBackup(input);
  }

  /**
   * Parses a contacts backup without writing anything to the live store.
   * Returns contacts and user-defined groups for the caller to preview.
   */
  async readContactsBackup(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<ContactManagerSnapshot> {
    return this._parseContactsBackup(input);
  }

  /**
   * Restores all data from a full backup blob produced by `backupAppData()`.
   * Contacts and groups are restored before invoices so recipients resolve
   * correctly.
   */
  async restoreAppData(blob: Blob): Promise<{
    contacts: number;
    groups: number;
    invoices: number;
  }> {
    const payload = await readBackupBlob(
      blob,
      MAJIK_BUWIZ_BACKUP_MAGIC.appData,
      "app data",
    );
    const cj = await MajikCompressedJSON.fromMJKCJSON<AppBackUpData>(payload);
    const data = cj.payload;

    // 1. Contacts
    const tempManager = await MajikInvoiceContactManager.fromJSON(
      data.contacts,
    );
    const contacts = tempManager.listContacts(false);
    const groups = tempManager.listGroups(false);

    for (const contact of contacts) {
      await this._contacts.addContact(contact);
    }

    for (const group of groups) {
      if (group.isSystem) continue;
      if (!this._contacts.hasGroup(group.id)) {
        await this._contacts.addGroup(group);
      } else {
        for (const memberId of group.listMemberIds()) {
          if (this._contacts.hasContact(memberId)) {
            await this._contacts.addContactToGroupIfAbsent(group.id, memberId);
          }
        }
      }
    }

    // 2. Invoices
    await Promise.all(
      (data.invoices ?? []).map((json) => {
        const invoice = MajikInvoice.fromJSON(json);
        return this._invoices.save(invoice);
      }),
    );

    // 3. Defaults
    if (data.invoiceDefaults) {
      await this.setInvoiceDefaults(data.invoiceDefaults);
    }

    if (data.preferences) {
      await this.setUserAppPreferences(data.preferences);
    }

    return {
      contacts: contacts.length,
      groups: groups.filter((g) => !g.isSystem).length,
      invoices: data.invoices?.length ?? 0,
    };
  }

  /**
   * Probes the first bytes of a blob and returns which backup type it is,
   * without fully parsing it. Useful for file-picker validation UI.
   *
   * @returns `"invoices" | "contacts" | "appData" | "unknown"`
   */
  static async probeBackupType(
    blob: Blob,
  ): Promise<"invoices" | "contacts" | "expenses" | "appData" | "unknown"> {
    const header = new Uint8Array(
      await blob.slice(0, MAJIK_BUWIZ_BACKUP_MAGIC_SIZE).arrayBuffer(),
    );

    for (const [type, magic] of Object.entries(MAJIK_BUWIZ_BACKUP_MAGIC) as [
      keyof typeof MAJIK_BUWIZ_BACKUP_MAGIC,
      Uint8Array,
    ][]) {
      if (magic.every((byte, i) => header[i] === byte)) return type;
    }

    return "unknown";
  }

  // ── Private parser ─────────────────────────────────────────────────────────

  /**
   * Parses an app data backup blob into an AppDataSnapshot.
   * No side-effects; nothing is written to the live store.
   */
  private async _parseAppDataBackup(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<AppDataSnapshot> {
    const payload = await readBackupBlob(
      input,
      MAJIK_BUWIZ_BACKUP_MAGIC.appData,
      "app data",
    );
    const cj = await MajikCompressedJSON.fromMJKCJSON<AppBackUpData>(payload);
    const data = cj.payload;

    const tempManager = await MajikInvoiceContactManager.fromJSON(
      data.contacts,
    );
    const contacts = tempManager.listContacts(false);
    const groups = tempManager.listGroups(false);
    const invoices = (data.invoices ?? []).map((json) =>
      MajikInvoice.fromJSON(json),
    );

    const expenses = (data.expenses ?? []).map((json) =>
      ExpenseRecord.fromJSON(json),
    );

    return {
      invoices,
      expenses,
      contacts,
      groups,
      invoiceDefaults: data.invoiceDefaults ?? null,
      preferences: data.preferences ?? null,
      // Keep raw manager JSON for the restore path
      _contactsManagerJSON: data.contacts,
    };
  }

  // ── Public read (no side-effects) ─────────────────────────────────────────

  /**
   * Parses an app data backup without writing anything to the live store.
   * Returns a full snapshot for the caller to preview and selectively restore.
   */
  async readAppDataBackup(
    input: Blob | ArrayBufferLike | ArrayBufferView,
  ): Promise<AppDataSnapshot> {
    return this._parseAppDataBackup(input);
  }

  // ── Public restore (selective) ────────────────────────────────────────────

  /**
   * Restores selected sections from an app data backup snapshot.
   * The caller controls exactly which domains are written.
   */
  async restoreAppDataSelective(
    snapshot: AppDataSnapshot,
    options: {
      invoices?: boolean;
      expenses?: boolean;
      contacts?: boolean;
      groups?: boolean;
      invoiceDefaults?: boolean;
      preferences?: boolean;
      overwriteContacts?: boolean;
    } = {},
  ): Promise<{
    invoices: number;
    expenses: number;
    contacts: number;
    groups: number;
    invoiceDefaults: boolean;
    preferences: boolean;
  }> {
    const {
      invoices: doInvoices = true,
      expenses: doExpenses = true,
      contacts: doContacts = true,
      groups: doGroups = true,
      invoiceDefaults: doDefaults = true,
      preferences: doPreferences = true,
      overwriteContacts = true,
    } = options;

    let invoiceCount = 0;
    let expenseCount = 0;
    let contactCount = 0;
    let groupCount = 0;
    let defaultsRestored = false;
    let preferencesRestored = false;

    // 1. Contacts first — invoices may reference them
    if (doContacts) {
      for (const contact of snapshot.contacts) {
        const exists = !!this._contacts.getContact(contact.id);
        if (exists && !overwriteContacts) continue;
        await this.addContact(contact);
        contactCount++;
      }
    }

    // 2. Groups — only members that landed in the store are linked
    if (doGroups) {
      for (const group of snapshot.groups) {
        if (group.isSystem) continue;
        if (!this._contacts.hasGroup(group.id)) {
          await this.addGroup(group);
        } else {
          for (const memberId of group.listMemberIds()) {
            if (this._contacts.hasContact(memberId)) {
              await this._contacts.addContactToGroupIfAbsent(
                group.id,
                memberId,
              );
            }
          }
        }
        groupCount++;
      }
    }

    // 3. Invoices
    if (doInvoices) {
      await Promise.all(
        snapshot.invoices.map((inv) => this._invoices.save(inv)),
      );
      invoiceCount = snapshot.invoices.length;
    }

    if (doExpenses) {
      await Promise.all(
        snapshot.expenses.map((exp) => this._expenses.save(exp)),
      );
      expenseCount = snapshot.expenses.length;
    }

    // 4. Invoice defaults
    if (doDefaults && snapshot.invoiceDefaults) {
      await this.setInvoiceDefaults(snapshot.invoiceDefaults);
      defaultsRestored = true;
    }

    // 5. App preferences
    if (doPreferences && snapshot.preferences) {
      await this.setUserAppPreferences(snapshot.preferences);
      preferencesRestored = true;
    }
    const restoredData = {
      invoices: invoiceCount,
      expenses: expenseCount,
      contacts: contactCount,
      groups: groupCount,
      invoiceDefaults: defaultsRestored,
      preferences: preferencesRestored,
    };

    this._emit("restore-backup", restoredData);

    return restoredData;
  }

  // ==========================================================================
  // ── EVENTS ────────────────────────────────────────────────────────────────
  // ==========================================================================

  on(event: MajikBuwizClientEvents, callback: EventCallback): void {
    this._listeners.get(event)?.push(callback);
  }

  off(event: MajikBuwizClientEvents, callback?: EventCallback): void {
    const cbs = this._listeners.get(event);
    if (!cbs?.length) return;
    if (callback) {
      const i = cbs.indexOf(callback);
      if (i !== -1) cbs.splice(i, 1);
    } else {
      this._listeners.set(event, []);
    }
  }

  // ==========================================================================
  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────
  // ==========================================================================

  // Private helper — add once, use in every invoice method
  private async _resolveInvoice(
    invoiceOrId: string | MajikInvoice,
  ): Promise<MajikInvoice> {
    if (typeof invoiceOrId === "string") {
      return this.getInvoiceOrThrow(invoiceOrId);
    }
    return invoiceOrId;
  }

  // Private helper — add once, use in every expense method
  private async _resolveExpense(
    expenseOrId: string | ExpenseRecord,
  ): Promise<ExpenseRecord> {
    if (typeof expenseOrId === "string") {
      return this.getExpenseOrThrow(expenseOrId);
    }
    return expenseOrId;
  }

  private _resolveSignerKey(
    accountId: string | undefined,
    operation: string,
  ): MajikKey {
    const key = this._resolveKey(accountId, operation);
    if (!key.hasSigningKeys) {
      throw new MajikInvoiceKeyError(
        `Cannot ${operation}: account "${key.id}" has no signing keys. ` +
          `Re-import via importAccountFromMnemonicBackup() to enable signing.`,
      );
    }
    if (key.isLocked) {
      throw new MajikInvoiceKeyError(
        `Cannot ${operation}: account "${key.id}" is locked. Call unlockAccount() first.`,
      );
    }
    return key;
  }

  private _resolveKey(
    account: string | MajikKey | undefined,
    operation: string,
  ): MajikKey {
    // Already a key instance — use directly, skip the keystore lookup
    if (account instanceof MajikKey) return account;

    const id = account ?? this.getActiveAccount()?.id;
    if (!id) {
      throw new MajikInvoiceError(
        `Cannot ${operation}: no active account. Call setActiveAccount() first.`,
      );
    }
    const key = this._keys.get(id);
    if (!key) {
      throw new MajikInvoiceError(
        `Cannot ${operation}: account "${id}" not found in keystore.`,
      );
    }
    return key;
  }
}
