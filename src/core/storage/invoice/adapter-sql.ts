import { MajikInvoiceJSON, MajikInvoiceMode } from "@majikah/majik-invoice";
import { MajikInvoiceStorageAdapter } from "./_types";
import { SQLiteDatabase } from "../sqlite/sql-db-manager";
import { StorageQuery, StorageSource } from "../storage-adapter";
import { MAJIKAH_SQL_TABLES } from "../sqlite/sql-db-tables";
import {
  InvoiceAdvancedQueryOptions,
  InvoiceDateRangeFilter,
} from "../../invoice/invoice-manager";

export class SQLiteInvoiceAdapter implements MajikInvoiceStorageAdapter {
  constructor(private db: SQLiteDatabase) {}

  async save(
    invoice: MajikInvoiceJSON,
    source: StorageSource = "local",
  ): Promise<void> {
    const resolvedSource: StorageSource = source ?? "local";

    await this.db.run(
      `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} 
     (id, json, created_at, issued_at, public_key, mode, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoice.id,
        JSON.stringify(invoice),
        invoice.created_at,
        invoice.public.issuedAt,
        invoice.integrity.allowlistSignerId ??
          invoice.integrity.signatures[0].signerId ??
          null,
        invoice.mode,
        invoice.public.status,
        resolvedSource,
      ],
    );
  }

  async getById(
    id: string,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON | null> {
    const row = source
      ? await this.db.get<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ? AND source = ?`,
          [id, source],
        )
      : await this.db.get<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ?`,
          [id],
        );

    return row ? JSON.parse(row.json) : null;
  }

  async list(source?: StorageSource): Promise<MajikInvoiceJSON[]> {
    const rows = source
      ? await this.db.all<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE source = ?`,
          [source],
        )
      : await this.db.all<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}`,
        );

    return rows.map((r) => JSON.parse(r.json));
  }

  async remove(id: string, source?: StorageSource): Promise<boolean> {
    const exists = await this.exists(id, source);
    if (!exists) return false;

    if (source) {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ? AND source = ?`,
        [id, source],
      );
    } else {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ?`,
        [id],
      );
    }

    return true;
  }

  async clear(source?: StorageSource): Promise<void> {
    if (source) {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE source = ?`,
        [source],
      );
    } else {
      await this.db.run(`DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}`);
    }
  }

  async count(source?: StorageSource): Promise<number> {
    const row = source
      ? await this.db.get<{ n: number }>(
          `SELECT COUNT(*) as n FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE source = ?`,
          [source],
        )
      : await this.db.get<{ n: number }>(
          `SELECT COUNT(*) as n FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}`,
        );

    return row?.n ?? 0;
  }

  async exists(id: string, source?: StorageSource): Promise<boolean> {
    const row = source
      ? await this.db.get(
          `SELECT 1 FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ? AND source = ?`,
          [id, source],
        )
      : await this.db.get(
          `SELECT 1 FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ?`,
          [id],
        );

    return !!row;
  }

  async bulkSave(
    invoices: MajikInvoiceJSON[],
    source: StorageSource = "local",
  ): Promise<void> {
    if (invoices.length === 0) return;

    const resolvedSource: StorageSource = source ?? "local";

    await this.db.transaction(async (tx) => {
      for (const inv of invoices) {
        await tx.run(
          `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} 
         (id, json, created_at, issued_at, public_key, mode, status, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inv.id,
            JSON.stringify(inv),
            inv.created_at,
            inv.public.issuedAt,
            inv.integrity.allowlistSignerId ??
              inv.integrity.signatures[0].signerId ??
              null,
            inv.mode,
            inv.public.status,
            resolvedSource,
          ],
        );
      }
    });
  }

  async bulkRemove(ids: string[], source?: StorageSource): Promise<void> {
    if (ids.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const id of ids) {
        if (source) {
          await tx.run(
            `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ? AND source = ?`,
            [id, source],
          );
        } else {
          await tx.run(
            `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES} WHERE id = ?`,
            [id],
          );
        }
      }
    });
  }

  async query(
    query: StorageQuery<MajikInvoiceJSON>,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON[]> {
    const clauses: string[] = [];
    const values: any[] = [];

    if (source) {
      clauses.push("source = ?");
      values.push(source);
    }

    if (query.where) {
      for (const [key, value] of Object.entries(query.where)) {
        clauses.push(`${key} = ?`);
        values.push(value);
      }
    }

    let sql = `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}`;

    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }

    if (query.orderBy) {
      sql += ` ORDER BY ${String(query.orderBy)} ${
        query.orderDirection ?? "asc"
      }`;
    }

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
    }

    if (query.offset) {
      sql += ` OFFSET ${query.offset}`;
    }

    const rows = await this.db.all<{ json: string }>(sql, values);

    return rows.map((r) => JSON.parse(r.json));
  }

  // ── Shared SQL builder ───────────────────────────────────────────────────

  private _buildAdvancedQuery(
    opts: InvoiceAdvancedQueryOptions,
    source?: StorageSource,
  ): { sql: string; values: unknown[] } {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (source) {
      clauses.push("source = ?");
      values.push(source);
    }
    if (opts.publicKey) {
      clauses.push("public_key = ?");
      values.push(opts.publicKey);
    }

    // In _buildAdvancedQuery, after the opts.publicKey block:
    if (opts.excludePublicKey) {
      clauses.push("public_key != ?");
      values.push(opts.excludePublicKey);
    }

    if (opts.mode) {
      clauses.push("mode = ?");
      values.push(opts.mode);
    }
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      values.push(...statuses);
    }
    if (opts.issuedAt?.from) {
      clauses.push("issued_at >= ?");
      values.push(opts.issuedAt.from);
    }
    if (opts.issuedAt?.to) {
      clauses.push("issued_at <= ?");
      values.push(opts.issuedAt.to);
    }
    if (opts.createdAt?.from) {
      clauses.push("created_at >= ?");
      values.push(opts.createdAt.from);
    }
    if (opts.createdAt?.to) {
      clauses.push("created_at <= ?");
      values.push(opts.createdAt.to);
    }

    let sql = `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_INVOICES}`;
    if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;

    // Sort
    const sortCol =
      opts.sortBy === "updatedAt"
        ? "created_at" // no updated_at column — fall back
        : opts.sortBy === "dueDate"
          ? "issued_at"
          : opts.sortBy === "total"
            ? "created_at" // no total column in SQL
            : opts.sortBy === "createdAt"
              ? "created_at"
              : "created_at";
    const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC";
    sql += ` ORDER BY ${sortCol} ${sortDir}`;

    if (opts.limit != null) {
      sql += " LIMIT ?";
      values.push(opts.limit);
    }
    if (opts.offset != null) {
      sql += " OFFSET ?";
      values.push(opts.offset);
    }

    return { sql, values };
  }

  private async _runAndParse(
    sql: string,
    values: unknown[],
  ): Promise<MajikInvoiceJSON[]> {
    const rows = await this.db.all<{ json: string }>(sql, values);
    return rows.map((r) => JSON.parse(r.json));
  }

  // ── Public query methods ─────────────────────────────────────────────────

  async queryAdvanced(
    opts: InvoiceAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON[]> {
    const { sql, values } = this._buildAdvancedQuery(opts, source);
    return this._runAndParse(sql, values);
  }

  async countAdvanced(
  opts: InvoiceAdvancedQueryOptions,
  source?: StorageSource,
): Promise<number> {
  const { sql, values } = this._buildAdvancedQuery(opts, source);
  // Swap SELECT json → SELECT COUNT(*) — strip ORDER BY / LIMIT / OFFSET
  // since they're meaningless for a count and SQLite allows them but it's wasteful
  const countSql = sql
    .replace(/^SELECT json/, "SELECT COUNT(*) as n")
    .replace(/ ORDER BY .+$/, "");
  const row = await this.db.get<{ n: number }>(countSql, values);
  return row?.n ?? 0;
}

  async listByPublicKey(
    publicKey: string,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON[]> {
    return this.queryAdvanced({ publicKey }, source);
  }

  async listByIssuedAtRange(
    range: InvoiceDateRangeFilter,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON[]> {
    return this.queryAdvanced({ issuedAt: range }, source);
  }

  async listByCreatedAtRange(
    range: InvoiceDateRangeFilter,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON[]> {
    return this.queryAdvanced({ createdAt: range }, source);
  }

  async listByMode(
    mode: MajikInvoiceMode,
    source?: StorageSource,
  ): Promise<MajikInvoiceJSON[]> {
    return this.queryAdvanced({ mode }, source);
  }
}
