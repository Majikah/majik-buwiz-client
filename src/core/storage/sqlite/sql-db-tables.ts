/**
 * Centralized SQLite table registry.
 * - `as const` keeps literal types
 * - `MajikahSQLTable` becomes a strict union type
 */
export const MAJIKAH_SQL_TABLES = {
  MAJIK_CLIENT_STATE: "majik_client_state",
  MAJIK_KEYS: "majik_keys",
  MAJIK_INVOICES: "majik_invoices",
  MAJIK_CONTACTS: "majik_contacts",
  MAJIK_CONTACT_GROUPS: "majik_contact_groups",
  MAJIK_RECURRING_EXPENSES: "majik_recurring_expenses",
  MAJIK_EXPENSE_RECORDS: "majik_expense_records",
} as const;

export type MajikahSQLTable =
  (typeof MAJIKAH_SQL_TABLES)[keyof typeof MAJIKAH_SQL_TABLES];
