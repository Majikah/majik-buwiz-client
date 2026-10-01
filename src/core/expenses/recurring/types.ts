/**
 * @file recurring-expense-types.ts
 * @description All types, interfaces, and enums for RecurringExpenseItem
 * and RecurringExpenseManager.
 *
 * Design notes:
 *   - RecurringExpenseItem is a template — never persisted as an ExpenseRecord
 *     by itself. It is actualized into ExpenseRecord instances on demand.
 *   - Status lifecycle: active → paused → active (reversible), active/paused → ended
 *     "ended" is terminal — represents a natural contract/lease expiry.
 *     "cancelled" is intentionally omitted — use ended for explicit termination.
 *   - RecurrenceSchedule carries both the frequency and the anchor (day-of-month,
 *     day-of-week, etc.) so the item knows exactly when in a period it fires.
 *   - Duration is optional — open-ended recurring items have no endDate.
 *   - Two separate adapter interfaces: one for RecurringExpenseItem templates,
 *     one for the actualization log (tracks which periods have been actualized).
 */

import type {
  Party,
  PaymentTerms,
  CurrencyCode,
  ISODateString,
  ISODateTimeString,
  LineItemInput,
} from "@majikah/majik-invoice";
import {
  BIRContext,
  ExpenseCategory,
  ExpenseDocumentType,
  ExpenseRecordJSON,
} from "../types";

// =============================================================================
// ── RECURRENCE FREQUENCY ──────────────────────────────────────────────────────
// =============================================================================

export type RecurrenceFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "semi-annual"
  | "annual";

// =============================================================================
// ── RECURRENCE ANCHOR ─────────────────────────────────────────────────────────
// =============================================================================

/**
 * Anchor for daily recurrence.
 * No extra fields — fires every calendar day.
 */
export interface DailyAnchor {
  frequency: "daily";
}

/**
 * Anchor for weekly recurrence.
 * dayOfWeek: 0 = Sunday, 1 = Monday … 6 = Saturday.
 */
export interface WeeklyAnchor {
  frequency: "weekly";
  /** 0 (Sunday) through 6 (Saturday) */
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Anchor for monthly recurrence.
 * dayOfMonth: 1–28 (capped at 28 to avoid month-end ambiguity).
 * Use 28 as a proxy for "end of month" if needed.
 */
export interface MonthlyAnchor {
  frequency: "monthly";
  /** 1–28 */
  dayOfMonth: number;
}

/**
 * Anchor for quarterly recurrence.
 * monthOfQuarter: 1 = first month of quarter, 2 = second, 3 = third.
 * dayOfMonth: which day within that month (1–28).
 *
 * @example Q1 Jan 15 → { monthOfQuarter: 1, dayOfMonth: 15 }
 * @example Q1 Mar 1  → { monthOfQuarter: 3, dayOfMonth: 1 }
 */
export interface QuarterlyAnchor {
  frequency: "quarterly";
  /** 1 | 2 | 3 — which month within the quarter */
  monthOfQuarter: 1 | 2 | 3;
  /** 1–28 */
  dayOfMonth: number;
}

/**
 * Anchor for semi-annual recurrence.
 * monthOfHalf: 1–6 (which month within the 6-month cycle).
 * dayOfMonth: which day within that month (1–28).
 */
export interface SemiAnnualAnchor {
  frequency: "semi-annual";
  /** 1–6 — which month within the half-year cycle */
  monthOfHalf: 1 | 2 | 3 | 4 | 5 | 6;
  /** 1–28 */
  dayOfMonth: number;
}

/**
 * Anchor for annual recurrence.
 * month: 1–12 (calendar month it fires).
 * dayOfMonth: which day within that month (1–28).
 *
 * @example Annual on Jan 1 → { month: 1, dayOfMonth: 1 }
 * @example Annual on Dec 15 → { month: 12, dayOfMonth: 15 }
 */
export interface AnnualAnchor {
  frequency: "annual";
  /** 1–12 */
  month: number;
  /** 1–28 */
  dayOfMonth: number;
}

/**
 * Discriminated union of all recurrence anchors.
 * The `frequency` field is the discriminant.
 */
export type RecurrenceAnchor =
  | DailyAnchor
  | WeeklyAnchor
  | MonthlyAnchor
  | QuarterlyAnchor
  | SemiAnnualAnchor
  | AnnualAnchor;

// =============================================================================
// ── RECURRENCE SCHEDULE ───────────────────────────────────────────────────────
// =============================================================================

/**
 * Full recurrence schedule attached to a RecurringExpenseItem.
 * Combines the anchor (when it fires within a period) with an optional
 * duration (when it stops).
 */
export interface RecurrenceSchedule {
  /** Anchor — defines frequency and exact timing within each period */
  anchor: RecurrenceAnchor;

  /**
   * The date this recurring item first becomes active.
   * The first actualization opportunity falls on or after this date.
   */
  startDate: ISODateString;

  /**
   * Optional end date for contract/lease-bound recurrences.
   * When set and today is past this date, the item is considered ended.
   * The manager will auto-transition status to "ended" on hydration
   * when this date has passed.
   *
   * Omit for open-ended recurring items.
   */
  endDate?: ISODateString;
}

// =============================================================================
// ── RECURRING EXPENSE ITEM STATUS ────────────────────────────────────────────
// =============================================================================

/**
 * Lifecycle status of a RecurringExpenseItem.
 *
 *   active  ⟷  paused   (reversible)
 *   active  →   ended   (terminal — natural expiry or explicit end)
 *   paused  →   ended   (terminal)
 *
 * "ended" is terminal. Items are never deleted — they remain in the store
 * for historical reference.
 */
export type RecurringExpenseItemStatus = "active" | "paused" | "ended";

// =============================================================================
// ── ACTUALIZATION PERIOD ──────────────────────────────────────────────────────
// =============================================================================

/**
 * A single YYYY-MM month string used as the atomic unit of actualization.
 * e.g. "2025-06"
 */
export type ActualizationMonth = string;

/**
 * Optional date range for bulk actualization.
 * Both from and to are inclusive YYYY-MM strings.
 *
 * @example Actualize all of Q1 2025:
 *   { from: "2025-01", to: "2025-03" }
 */
export interface ActualizationRange {
  from: ActualizationMonth;
  to: ActualizationMonth;
}

/**
 * Options passed to actualize() or actualizeAll().
 */
export interface ActualizeOptions {
  /**
   * Single month to actualize.
   * Mutually exclusive with range — if both are set, range takes precedence.
   */
  month?: ActualizationMonth;

  /**
   * Date range for bulk actualization (inclusive both ends).
   * When set, all eligible months in the range are actualized.
   */
  range?: ActualizationRange;

  /**
   * When true, throw immediately on the first already-actualized conflict
   * rather than skipping and continuing.
   * Default: false — skip conflicts and record them in result.skipped.
   */
  strict?: boolean;

  /**
   * BIR context override for this actualization call.
   * Merged over the item's default BIR context (override wins).
   */
  bir?: BIRContext;

  /**
   * Override the expense date on the produced ExpenseRecord.
   * Defaults to the anchor-resolved date for the actualization month.
   */
  expenseDate?: ISODateString;

  /**
   * Extra tags to attach to the produced ExpenseRecord(s).
   * Merged with item-level tags.
   */
  tags?: string[];

  /**
   * Extra metadata to merge into the produced ExpenseRecord(s).
   */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// ── ACTUALIZATION RESULT ──────────────────────────────────────────────────────
// =============================================================================

/**
 * Result returned by actualize() and actualizeAll().
 * Always returned regardless of strict mode — in strict mode the call throws
 * before a result is assembled if any conflict is found.
 */
export interface ActualizationResult {
  /** ExpenseRecord JSON objects produced and saved in this call */
  created: ExpenseRecordJSON[];

  /**
   * Months that were skipped because they were already actualized.
   * Empty in strict mode (the call would have thrown instead).
   */
  skipped: ActualizationMonth[];

  /**
   * Months that were skipped because the item was paused or ended
   * during that period.
   */
  ineligible: ActualizationMonth[];

  /** Total months processed (created + skipped + ineligible) */
  total: number;
}

// =============================================================================
// ── ACTUALIZATION LOG ENTRY ───────────────────────────────────────────────────
// =============================================================================

/**
 * A single entry in the actualization log.
 * Stored by the ActualizationLogAdapter to track which months have been
 * actualized for a given RecurringExpenseItem.
 */
export interface ActualizationLogEntry {
  /** Composite key: "{itemId}::{YYYY-MM}" */
  key: string;
  /** The RecurringExpenseItem id */
  itemId: string;
  /** The actualized month in YYYY-MM format */
  month: ActualizationMonth;
  /** The ExpenseRecord id produced for this month */
  expenseRecordId: string;
  /** ISO timestamp of when actualization occurred */
  actualizedAt: ISODateTimeString;
}

// =============================================================================
// ── RECURRING EXPENSE ITEM INPUT ─────────────────────────────────────────────
// =============================================================================

/**
 * Input for creating a RecurringExpenseItem.
 */
export interface RecurringExpenseItemInput {
  /** Optional — auto-generated (UUID) if omitted */
  id?: string;

  accountId?: string;

  /**
   * Human-readable name for this recurring template.
   * @example "Monthly Office Rent", "Adobe Creative Cloud", "Meralco Bill"
   */
  name: string;

  /**
   * Default description stamped onto each actualized ExpenseRecord.
   * Can reference the month via a placeholder if desired — the manager
   * will substitute "{month}" with the actualization month string.
   * @example "Office Rent — {month}"
   */
  description: string;

  /**
   * The category to which this recurring expense belongs.
   * @example "Office Expenses", "Software Subscriptions"
   */
  category: ExpenseCategory;

  /** The vendor / supplier being paid on each occurrence */
  payee: Party;

  /** The entity making the payment */
  paidBy: Party;

  /** ISO 4217 currency code */
  currency: CurrencyCode;

  /**
   * Default amount per occurrence.
   * Can be overridden per-actualization call via ActualizeOptions.
   */
  amount: number;

  /** Document type to stamp on each actualized record */
  documentType: ExpenseDocumentType;

  /** Full recurrence schedule including anchor and optional duration */
  schedule: RecurrenceSchedule;

  /** Initial status — defaults to "active" */
  status?: RecurringExpenseItemStatus;

  /**
   * Optional default BIR context.
   * Stamped onto every actualized ExpenseRecord unless overridden
   * in the ActualizeOptions.bir at call time.
   */
  bir?: BIRContext;

  /** Default payment terms carried to each actualized record */
  paymentTerms?: PaymentTerms;

  /** Default tags merged onto each actualized record */
  tags?: string[];

  /** Arbitrary metadata bag */
  metadata?: Record<string, unknown>;

  /**
   * Optional itemized line items — reuses GeneralInvoice's LineItemInput shape.
   * When provided, totalAmount is derived from the line items.
   * Compatible with GeneralInvoice.lineItems for round-trip conversion.
   */
  lineItems?: LineItemInput[];
}

// =============================================================================
// ── RECURRING EXPENSE ITEM JSON ───────────────────────────────────────────────
// =============================================================================

/**
 * Plain-object JSON representation of a RecurringExpenseItem.
 * This is what gets written to / read from the RecurringExpenseItemAdapter.
 */
export interface RecurringExpenseItemJSON {
  readonly version: string;
  readonly id: string;
  readonly account_id: string | null;
  readonly name: string;
  readonly description: string;
  readonly category: ExpenseCategory;
  readonly line_items?: LineItemInput[];
  readonly payee: Party;
  readonly paid_by: Party;
  readonly currency: CurrencyCode;
  readonly amount: number;
  readonly document_type: ExpenseDocumentType;
  readonly schedule: RecurrenceSchedule;
  readonly status: RecurringExpenseItemStatus;
  readonly bir?: BIRContext;
  readonly payment_terms?: PaymentTerms;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
  readonly created_at: ISODateTimeString;
  readonly updated_at: ISODateTimeString;
}

// =============================================================================
// ── INTERNAL STATE ────────────────────────────────────────────────────────────
// =============================================================================

/** @internal */
export interface RecurringExpenseItemInternalState {
  readonly id: string;
  readonly accountId?: string | null;
  readonly name: string;
  readonly description: string;
  readonly category: ExpenseCategory;
  readonly lineItems?: LineItemInput[];
  readonly payee: Party;
  readonly paidBy: Party;
  readonly currency: CurrencyCode;
  readonly amount: number;
  readonly documentType: ExpenseDocumentType;
  readonly schedule: RecurrenceSchedule;
  readonly status: RecurringExpenseItemStatus;
  readonly bir?: BIRContext;
  readonly paymentTerms?: PaymentTerms;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;
}

// =============================================================================
// ── ADAPTER INTERFACES ────────────────────────────────────────────────────────
// =============================================================================

/**
 * Storage adapter for the actualization log.
 * Tracks which (itemId, month) pairs have already been actualized
 * to prevent duplicate ExpenseRecord creation.
 *
 * Kept separate from the item adapter so the log can be stored in a
 * different table/store without coupling.
 */
export interface ActualizationLogAdapter {
  /** Save a log entry */
  save(entry: ActualizationLogEntry): Promise<void>;
  /** Check if a specific (itemId, month) has been actualized */
  isActualized(itemId: string, month: ActualizationMonth): Promise<boolean>;
  /** Get the log entry for a specific (itemId, month) */
  getEntry(
    itemId: string,
    month: ActualizationMonth,
  ): Promise<ActualizationLogEntry | undefined>;
  /** List all log entries for a given itemId */
  listByItemId(itemId: string): Promise<ActualizationLogEntry[]>;
  /** List all log entries for a given month across all items */
  listByMonth(month: ActualizationMonth): Promise<ActualizationLogEntry[]>;
  /** Remove all log entries for a given itemId (e.g. when item is deleted) */
  removeByItemId(itemId: string): Promise<void>;
  /** Remove a specific log entry */
  remove(itemId: string, month: ActualizationMonth): Promise<void>;
  /** Clear all log entries */
  clear(): Promise<void>;
  count(): Promise<number>;
}

// =============================================================================
// ── QUERY TYPES ───────────────────────────────────────────────────────────────
// =============================================================================

export interface RecurringExpenseItemQueryOptions {
  status?: RecurringExpenseItemStatus | RecurringExpenseItemStatus[];
  frequency?: RecurrenceFrequency;
  payeeName?: string;
  paidByName?: string;
  sortBy?: "name" | "amount" | "createdAt" | "startDate";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface RecurringExpenseItemQueryResult {
  items: RecurringExpenseItemJSON[];
  total: number;
  offset: number;
  limit: number;
}
