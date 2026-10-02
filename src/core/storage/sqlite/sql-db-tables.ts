import {
  MAJIKAH_SQL_TABLE_MAJIK_KEY,
  MAJIKAH_SQL_TABLE_MAJIK_KEY_CLIENT_STATE,
} from "@majikah/majik-key-client";

/**
 * Centralized SQLite table registry.
 * - `as const` keeps literal types
 * - `MajikahSQLTable` becomes a strict union type
 */
export const MAJIKAH_SQL_TABLES = {
  MAJIK_CLIENT_STATE: MAJIKAH_SQL_TABLE_MAJIK_KEY_CLIENT_STATE,
  MAJIK_KEYS: MAJIKAH_SQL_TABLE_MAJIK_KEY,
  MAJIK_INVOICES: "majik_invoices",
  MAJIK_CONTACTS: "majik_contacts",
  MAJIK_CONTACT_GROUPS: "majik_contact_groups",
  MAJIK_RECURRING_EXPENSES: "majik_recurring_expenses",
  MAJIK_EXPENSE_RECORDS: "majik_expense_records",
  HISTORY_LOGS: "history_logs",
  USER_ACTIVITY_LOGS: "user_activity_logs",
} as const;

export type MajikahSQLTable =
  (typeof MAJIKAH_SQL_TABLES)[keyof typeof MAJIKAH_SQL_TABLES];
