import {
  MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE,
  MAJIKAH_SQL_SCHEMA_MAJIK_KEYS,
} from "@majikah/majik-key-client";
import { MAJIKAH_SQL_TABLES } from "../sql-db-tables";
import { MajikahSQLSchema } from "./_types";
import { buildSchemaSQL } from "./_utils";

export const MAJIKAH_SQL_SCHEMA_MAJIK_INVOICES: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  issued_at TEXT,
  mode TEXT NOT NULL,
  status TEXT,
  source TEXT NOT NULL DEFAULT 'local'
    CHECK(source IN ('local', 'cloud')),
  public_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(created_at);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_issued_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(issued_at);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_public_key
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(public_key);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_mode
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(mode);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_status
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(status);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_source
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(source);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_CONTACTS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fingerprint TEXT,
  label TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_majik_contacts_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_CONTACTS}(created_at);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_CONTACT_GROUPS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  name TEXT,
  created_at TEXT,
  updated_at TEXT,
  is_system INTEGER DEFAULT 0 CHECK(is_system IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_majik_contact_groups_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_CONTACT_GROUPS}(created_at);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_RECURRING_EXPENSES: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_RECURRING_EXPENSES} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT,
  source TEXT NOT NULL DEFAULT 'local'
    CHECK(source IN ('local', 'cloud')),
  public_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_majik_recurring_expenses_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_RECURRING_EXPENSES}(created_at);


CREATE INDEX IF NOT EXISTS idx_majik_recurring_expenses_public_key
ON ${MAJIKAH_SQL_TABLES.MAJIK_RECURRING_EXPENSES}(public_key);


CREATE INDEX IF NOT EXISTS idx_majik_recurring_expenses_status
ON ${MAJIKAH_SQL_TABLES.MAJIK_RECURRING_EXPENSES}(status);

CREATE INDEX IF NOT EXISTS idx_majik_recurring_expenses_source
ON ${MAJIKAH_SQL_TABLES.MAJIK_RECURRING_EXPENSES}(source);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_EXPENSE_RECORDS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  status TEXT,
  source TEXT NOT NULL DEFAULT 'local'
    CHECK(source IN ('local', 'cloud')),
  public_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_majik_expense_records_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}(created_at);


CREATE INDEX IF NOT EXISTS idx_majik_expense_records_public_key
ON ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}(public_key);

CREATE INDEX IF NOT EXISTS idx_majik_expense_records_category
ON ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}(category);


CREATE INDEX IF NOT EXISTS idx_majik_expense_records_status
ON ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}(status);

CREATE INDEX IF NOT EXISTS idx_majik_expense_records_source
ON ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}(source);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_BUWIZ_HISTORY_LOG: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.HISTORY_LOGS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  type TEXT NOT NULL,
  fingerprint TEXT,
  version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  historyType TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  network TEXT,
  transactionId TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_logs_reference_id
ON ${MAJIKAH_SQL_TABLES.HISTORY_LOGS}(reference_id);

CREATE INDEX IF NOT EXISTS idx_history_logs_fingerprint
ON ${MAJIKAH_SQL_TABLES.HISTORY_LOGS}(fingerprint);

CREATE INDEX IF NOT EXISTS idx_history_logs_history_type
ON ${MAJIKAH_SQL_TABLES.HISTORY_LOGS}(historyType);

CREATE INDEX IF NOT EXISTS idx_history_logs_status
ON ${MAJIKAH_SQL_TABLES.HISTORY_LOGS}(status);

CREATE INDEX IF NOT EXISTS idx_history_logs_timestamp
ON ${MAJIKAH_SQL_TABLES.HISTORY_LOGS}(timestamp);

CREATE INDEX IF NOT EXISTS idx_history_logs_fingerprint_history_type
ON ${MAJIKAH_SQL_TABLES.HISTORY_LOGS}(fingerprint, historyType);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_BUWIZ_USER_ACTIVITY_LOG: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.USER_ACTIVITY_LOGS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  type TEXT NOT NULL,
  fingerprint TEXT,
  version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_reference_id
ON ${MAJIKAH_SQL_TABLES.USER_ACTIVITY_LOGS}(reference_id);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_fingerprint
ON ${MAJIKAH_SQL_TABLES.USER_ACTIVITY_LOGS}(fingerprint);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_action
ON ${MAJIKAH_SQL_TABLES.USER_ACTIVITY_LOGS}(action);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_timestamp
ON ${MAJIKAH_SQL_TABLES.USER_ACTIVITY_LOGS}(timestamp);

CREATE INDEX IF NOT EXISTS idx_user_activity_logs_fingerprint_action
ON ${MAJIKAH_SQL_TABLES.USER_ACTIVITY_LOGS}(fingerprint, action);
`;

export const MAJIKAH_SQL_SCHEMA_FULL_V_1: MajikahSQLSchema = buildSchemaSQL([
  MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE,
  MAJIKAH_SQL_SCHEMA_MAJIK_KEYS,
  MAJIKAH_SQL_SCHEMA_MAJIK_INVOICES,
  MAJIKAH_SQL_SCHEMA_MAJIK_CONTACTS,
  MAJIKAH_SQL_SCHEMA_MAJIK_CONTACT_GROUPS,
  MAJIKAH_SQL_SCHEMA_MAJIK_RECURRING_EXPENSES,
  MAJIKAH_SQL_SCHEMA_MAJIK_EXPENSE_RECORDS,
  MAJIKAH_SQL_SCHEMA_MAJIK_BUWIZ_HISTORY_LOG,
  MAJIKAH_SQL_SCHEMA_MAJIK_BUWIZ_USER_ACTIVITY_LOG,
]);
