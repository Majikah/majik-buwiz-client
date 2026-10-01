import { MAJIKAH_SQL_SCHEMA_FULL_V_0 } from "../schema/sql-schema-version-0";
import { MAJIKAH_SQL_TABLES } from "../sql-db-tables";

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/**
 * APPEND-ONLY. Never edit or reorder existing entries.
 * Each migration runs exactly once, identified by its version number.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    sql: MAJIKAH_SQL_SCHEMA_FULL_V_0,
  },

  {
    version: 2,
    description: "Add issued_at and source index to majik_invoices",
    sql: `
      ALTER TABLE majik_invoices ADD COLUMN issued_at TEXT;

CREATE INDEX IF NOT EXISTS idx_majik_invoices_issued_at
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(issued_at);

CREATE INDEX IF NOT EXISTS idx_majik_invoices_public_key
ON ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}(public_key);
    `,
  }
];
