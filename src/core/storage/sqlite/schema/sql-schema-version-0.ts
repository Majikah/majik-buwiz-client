import { MAJIKAH_SQL_TABLES } from "../sql-db-tables";
import { MajikahSQLSchema } from "./_types";
import { buildSchemaSQL } from "./_utils";

export const MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_CLIENT_STATE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_KEYS: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_KEYS} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  public_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_majik_keys_timestamp
ON ${MAJIKAH_SQL_TABLES.MAJIK_KEYS}(timestamp);

CREATE INDEX IF NOT EXISTS idx_majik_keys_public_key
ON ${MAJIKAH_SQL_TABLES.MAJIK_KEYS}(public_key);
`;

export const MAJIKAH_SQL_SCHEMA_MAJIK_INVOICES: MajikahSQLSchema = `
CREATE TABLE IF NOT EXISTS ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT,
  source TEXT NOT NULL DEFAULT 'local'
    CHECK(source IN ('local', 'cloud'))
);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_created_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(created_at);


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

export const MAJIKAH_SQL_SCHEMA_FULL_V_0: MajikahSQLSchema = buildSchemaSQL([
  MAJIKAH_SQL_SCHEMA_MAJIK_CLIENT_STATE,
  MAJIKAH_SQL_SCHEMA_MAJIK_KEYS,
  MAJIKAH_SQL_SCHEMA_MAJIK_INVOICES,
  MAJIKAH_SQL_SCHEMA_MAJIK_CONTACTS,
  MAJIKAH_SQL_SCHEMA_MAJIK_CONTACT_GROUPS,
]);
