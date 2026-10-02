/**
 * @file _types.ts
 * @description Shared types for the ClientState storage layer.
 *
 * The adapter is intentionally minimal — it is a generic key/value store
 * where each entry carries a plain JSON-serialisable `value`. The
 * ClientStateManager owns all serialisation / deserialisation logic; the
 * adapter only moves bytes.
 */

import type {
  CurrencyCode,
  TaxDetail,
  PaymentTerms,
  Party,
  MajikInvoice,
} from "@majikah/majik-invoice";
import { MajikStorageAdapter } from "../storage-adapter";
import { ExpenseRecord } from "../../expenses/expense-record";

// ---------------------------------------------------------------------------
// Storage entry — the unit that adapters read and write
// ---------------------------------------------------------------------------

export interface ClientStateEntry {
  /** Stable string key that identifies this piece of state. */
  id: string;
  /** JSON-serialised value. Always a string on the wire / in storage. */
  value: string;
  /** ISO 8601 datetime — set by the adapter on every write where supported. */
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Well-known state keys
// ---------------------------------------------------------------------------

export const CLIENT_STATE_KEYS = {
  ACCOUNT_ORDER: "user_account_order",
  INVOICE_DEFAULTS: "invoice_defaults",
  INVOICE_TABLE_COLUMNS: "invoice_table_columns",
  EXPENSE_TABLE_COLUMNS: "expense_table_columns",
  USER_APP_PREFERENCES: "user_app_preferences",
} as const;

export type ClientStateKey =
  (typeof CLIENT_STATE_KEYS)[keyof typeof CLIENT_STATE_KEYS];

// ---------------------------------------------------------------------------
// Typed value shapes
// ---------------------------------------------------------------------------

/**
 * Ordered list of own account IDs. The head of the array is the active
 * account. Stored as a JSON array: `["id1", "id2", ...]`.
 */
export type AccountOrderValue = string[];

/**
 * User-configured defaults applied when creating new invoices.
 */
export interface InvoiceDefaults {
  currency: CurrencyCode;
  defaultTaxes?: TaxDetail[];
  paymentTerms?: PaymentTerms;
  issuer?: Partial<Party>;
  invoiceNumberPrefix?: string;
  invoiceNumberCounter?: number;
  notes?: string;
  tagline?: string;
}

/**
 * User-configured app-wide preferences.
 */
export interface UserAppPreferences {
  general: GeneralPreferences;
  invoices: InvoicePreferences;
  dashboard: DashboardPreferences;
  privacy: PrivacyPreferences;
  security: SecurityPreferences;
}

export interface GeneralPreferences {
  history?: HistoryPreferences;
}

export interface HistoryPreferences {
  enabled?: boolean;
  maxCount?: number;
}

export interface InvoicePreferences {
  autodecrypt?: boolean;
}

export interface DashboardPreferences {
  autodecrypt?: boolean;
}

export interface PrivacyPreferences {
  shareAnalytics?: boolean;
}

export interface SecurityPreferences {
  key?: KeyPreferences;
}

export interface KeyPreferences {
  autoLockOnMinimize?: boolean;
  autoLockInterval?: number;
  onetimeUnlock?: boolean;
}

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

export type SortType = "alpha" | "numeric" | "date";

export interface InvoiceColumnDef {
  key: string;
  header: string;
  render: (invoice: MajikInvoice) => any;
  sortValue?: (invoice: MajikInvoice) => string | number | null | undefined;
  sortable?: SortType | false;
  minWidth?: string;
  align?: "left" | "center" | "right";
}

export interface ExpenseColumnDef {
  key: string;
  header: string;
  render: (record: ExpenseRecord) => any;
  sortValue?: (record: ExpenseRecord) => string | number | null | undefined;
  sortable?: SortType | false;
  minWidth?: string;
  align?: "left" | "center" | "right";
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Pluggable persistence backend for client-level state.
 *
 * Implementations must provide IDB, SQLite, and in-memory variants.
 * All methods are async for uniformity — in-memory may resolve immediately.
 *
 * The store is deliberately flat: every piece of state is a `ClientStateEntry`
 * keyed by a stable string ID. There is no relational structure.
 */
export type ClientStateStorageAdapter = MajikStorageAdapter<ClientStateEntry>;
