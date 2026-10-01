import {
  DateRangeFilter,
  ExpenseAdvancedQueryOptions,
  ExpenseCategory,
  ExpenseRecordJSON,
} from "../../../expenses/types";
import { SQLiteDatabase } from "../../sqlite/sql-db-manager";
import { MAJIKAH_SQL_TABLES } from "../../sqlite/sql-db-tables";
import { StorageQuery, StorageSource } from "../../storage-adapter";
import { ExpenseRecordStorageAdapter } from "./_types";

export class SQLiteExpenseRecordAdapter implements ExpenseRecordStorageAdapter {
  constructor(private db: SQLiteDatabase) {}

  async save(
    expense: ExpenseRecordJSON,
    source: StorageSource = "local",
  ): Promise<void> {
    const resolvedSource: StorageSource = source ?? "local";

    await this.db.run(
      `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} 
     (id, json, created_at, category, public_key, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        expense.id,
        JSON.stringify(expense),
        expense.created_at,
        expense.category,
        expense.account_id,
        expense.status,
        resolvedSource,
      ],
    );
  }

  async getById(
    id: string,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON | null> {
    const row = source
      ? await this.db.get<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ? AND source = ?`,
          [id, source],
        )
      : await this.db.get<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ?`,
          [id],
        );

    return row ? JSON.parse(row.json) : null;
  }

  async list(source?: StorageSource): Promise<ExpenseRecordJSON[]> {
    const rows = source
      ? await this.db.all<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE source = ?`,
          [source],
        )
      : await this.db.all<{ json: string }>(
          `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}`,
        );

    return rows.map((r) => JSON.parse(r.json));
  }

  async remove(id: string, source?: StorageSource): Promise<boolean> {
    const exists = await this.exists(id, source);
    if (!exists) return false;

    if (source) {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ? AND source = ?`,
        [id, source],
      );
    } else {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ?`,
        [id],
      );
    }

    return true;
  }

  async clear(source?: StorageSource): Promise<void> {
    if (source) {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE source = ?`,
        [source],
      );
    } else {
      await this.db.run(
        `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}`,
      );
    }
  }

  async count(source?: StorageSource): Promise<number> {
    const row = source
      ? await this.db.get<{ n: number }>(
          `SELECT COUNT(*) as n FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE source = ?`,
          [source],
        )
      : await this.db.get<{ n: number }>(
          `SELECT COUNT(*) as n FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}`,
        );

    return row?.n ?? 0;
  }

  async exists(id: string, source?: StorageSource): Promise<boolean> {
    const row = source
      ? await this.db.get(
          `SELECT 1 FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ? AND source = ?`,
          [id, source],
        )
      : await this.db.get(
          `SELECT 1 FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ?`,
          [id],
        );

    return !!row;
  }

  async bulkSave(
    expenses: ExpenseRecordJSON[],
    source: StorageSource = "local",
  ): Promise<void> {
    if (expenses.length === 0) return;

    const resolvedSource: StorageSource = source ?? "local";

    await this.db.transaction(async (tx) => {
      for (const exp of expenses) {
        await tx.run(
          `INSERT OR REPLACE INTO ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} 
         (id, json, created_at, category, public_key, status, source)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            exp.id,
            JSON.stringify(exp),
            exp.created_at,
            exp.category,
            exp.account_id,
            exp.status,
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
            `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ? AND source = ?`,
            [id, source],
          );
        } else {
          await tx.run(
            `DELETE FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS} WHERE id = ?`,
            [id],
          );
        }
      }
    });
  }

  async query(
    query: StorageQuery<ExpenseRecordJSON>,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]> {
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

    let sql = `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}`;

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
    opts: ExpenseAdvancedQueryOptions,
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

    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      values.push(...statuses);
    }

    if (opts.category) {
      const categories = Array.isArray(opts.category)
        ? opts.category
        : [opts.category];
      clauses.push(`category IN (${categories.map(() => "?").join(",")})`);
      values.push(...categories);
    }

    if (opts.createdAt?.from) {
      clauses.push("created_at >= ?");
      values.push(opts.createdAt.from);
    }
    if (opts.createdAt?.to) {
      clauses.push("created_at <= ?");
      values.push(opts.createdAt.to);
    }

    let sql = `SELECT json FROM ${MAJIKAH_SQL_TABLES.MAJIK_EXPENSE_RECORDS}`;
    if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;

    // Sort
    const sortCol =
      opts.sortBy === "updatedAt"
        ? "created_at" // no updated_at column — fall back
        : opts.sortBy === "totalAmount"
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
  ): Promise<ExpenseRecordJSON[]> {
    const rows = await this.db.all<{ json: string }>(sql, values);
    return rows.map((r) => JSON.parse(r.json));
  }

  // ── Public query methods ─────────────────────────────────────────────────

  async queryAdvanced(
    opts: ExpenseAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]> {
    const { sql, values } = this._buildAdvancedQuery(opts, source);
    return this._runAndParse(sql, values);
  }

  async countAdvanced(
    opts: ExpenseAdvancedQueryOptions,
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
  ): Promise<ExpenseRecordJSON[]> {
    return this.queryAdvanced({ publicKey }, source);
  }

  async listByCreatedAtRange(
    range: DateRangeFilter,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]> {
    return this.queryAdvanced({ createdAt: range }, source);
  }

  async listByCategory(
    category: ExpenseCategory,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]> {
    return this.queryAdvanced({ category }, source);
  }
}
