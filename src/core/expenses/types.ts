/**
 * @file expense-record-types.ts
 * @description All types, interfaces, and enums for ExpenseRecord.
 *
 * Design notes:
 *   - ExpenseRecord status lifecycle: draft → approved → refunded
 *   - BIR metadata is an optional separate BIRContext object — not embedded
 *     directly on the record. This keeps the record clean for non-BIR use cases.
 *   - Line items are optional — a record can be a single amount + description,
 *     or a full itemized list reusing GeneralInvoice's LineItemInput shape.
 *   - Refund tracking: a refundAmount field + computed getters (isFullyRefunded,
 *     effectiveStatus) rather than a separate partiallyRefunded status.
 *   - Parties: payee (vendor/supplier you paid) + paidBy (your entity).
 *     This is the natural inversion of GeneralInvoice's issuer/recipient.
 */

import type {
  Party,
  DocumentReference,
  Period,
  PaymentTerms,
  CurrencyCode,
  ISODateString,
  ISODateTimeString,
  LineItemInput,
  TaxBehaviour,
} from "@majikah/majik-invoice";
import { ExpenseRecord } from "./expense-record";
import { RecurringExpenseItemStatus } from "./recurring/types";
import { RecurringExpenseItem } from "./recurring/recurring-expense";

/**
 * High-level expense category — maps to BIR-recognized deduction types
 * for itemized deduction computation on 1701A/1701Q Part IV-A.
 */
export type ExpenseCategory =
  | "cost-of-sales" // Item 29 on 1701Q
  | "compensation" // Salaries, wages
  | "rent" // Office/equipment rental
  | "professional-fees" // Legal, accounting, consulting
  | "utilities" // Electricity, water, internet
  | "depreciation" // Capital asset write-down
  | "interest" // Loan interest (subject to limits)
  | "taxes-and-licenses" // Local taxes, permits
  | "representation" // Entertainment (subject to 0.5%/1% cap)
  | "transportation" // Travel, transport
  | "communication" // Phone, postage
  | "insurance" // Business insurance
  | "supplies" // Office supplies
  | "bad-debts" // Uncollectible receivables
  | "charitable-contributions" // Deductible donations
  | "other"; // Catch-all

// =============================================================================
// ── DOCUMENT TYPE ─────────────────────────────────────────────────────────────
// =============================================================================

/**
 * BIR-acceptable supporting document types.
 * Drives default BIR classification hints and display labels.
 */
export type ExpenseDocumentType =
  | "supplier-invoice"
  | "official-receipt"
  | "billing-statement"
  | "utility-bill"
  | "rent-invoice"
  | "professional-fee-invoice"
  | "importation-document"
  | "other";

// =============================================================================
// ── STATUS ────────────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Raw persisted status of an ExpenseRecord.
 *
 * Lifecycle:  draft → approved → refunded
 *
 * Use `effectiveStatus` on the record instance for a computed view that
 * factors in partial/full refunds.
 */
export type ExpenseRecordStatus = "draft" | "approved" | "refunded";

/**
 * Computed effective status — returned by ExpenseRecord.effectiveStatus.
 * Extends the raw status with derived states that don't need to be persisted.
 */
export type ExpenseRecordEffectiveStatus =
  | "draft"
  | "approved"
  | "partially-refunded"
  | "refunded";

// =============================================================================
// ── BIR CONTEXT ───────────────────────────────────────────────────────────────
// =============================================================================

/**
 * BIR-specific metadata attached to an ExpenseRecord.
 * Optional — attach when the record needs to feed into tax adapters.
 *
 * Kept as a separate object so non-BIR use cases stay uncluttered.
 */
export interface BIRContext {
  /**
   * BIR purchase type — drives input VAT schedule on 2550M/Q.
   */
  purchaseType?:
    | "goods-other-than-capital"
    | "capital-goods"
    | "services"
    | "other";

  /**
   * VAT treatment of the input VAT on this expense.
   */
  vatClassification?: "creditable" | "non-creditable" | "exempt" | "zero-rated";

  /**
   * Input VAT rate (e.g. 0.12 for 12%).
   * When set, inputVatAmount is auto-computed as totalAmount × inputVatRate
   * unless inputVatAmount is explicitly provided.
   */
  inputVatRate?: number;

  /**
   * Explicit input VAT amount override.
   * Takes precedence over inputVatRate computation.
   */
  inputVatAmount?: number;

  /**
   * EWT ATC code for withholding (e.g. "WI010", "WC158").
   */
  withholdingAtcCode?: string;

  /**
   * Explicit withholding amount override.
   */
  withholdingAmount?: number;

  /**
   * Whether this is a representation expense (subject to BIR deductibility cap).
   */
  isRepresentation?: boolean;

  /**
   * Whether this is a depreciation/capital goods entry.
   */
  isDepreciation?: boolean;

  /**
   * Supplier TIN for BIR substantiation.
   * Mirrors Party.tin but surfaced here for quick access without
   * traversing the payee party object.
   */
  supplierTin?: string;

  /**
   * Official receipt or invoice number from the supplier.
   */
  receiptNumber?: string;

  /**
   * URL or file reference to the scanned receipt/invoice.
   */
  receiptUrl?: string;
}

// ---------------------------------------------------------------------------
// Tax summary
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tax summary (returned by ExpenseRecord.lineItemTaxSummary())
// ---------------------------------------------------------------------------

export interface LineItemTaxSummaryEntry {
  /** Normalised taxType key (uppercased) */
  taxType: string;
  /** Decimal rate, e.g. 0.12 */
  rate: number;
  behaviour: TaxBehaviour;
  label?: string;
  jurisdiction?: string;
  inclusive: boolean;
  /** How many line items carry this taxType */
  lineItemCount: number;
}

// =============================================================================
// ── REFUND RECORD ─────────────────────────────────────────────────────────────
// =============================================================================

/**
 * A single refund event applied to an ExpenseRecord.
 * Multiple partial refunds are supported — they accumulate toward the total.
 */
export interface RefundRecord {
  /** Unique ID for this refund event */
  id: string;
  /** Amount refunded (must be > 0 and ≤ remaining balance) */
  amount: number;
  /** ISO date the refund was received */
  refundedAt: ISODateString;
  /** Optional reason or reference */
  reason?: string;
  /** Optional reference document (e.g. credit memo number) */
  reference?: string;
}

// =============================================================================
// ── INPUT TYPES ───────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Input for creating an ExpenseRecord.
 *
 * Either `totalAmount` alone (single-amount record) or `lineItems` can be
 * provided. When `lineItems` is provided, `totalAmount` is computed from them
 * and any explicit `totalAmount` is ignored.
 */
export interface ExpenseRecordInput {
  /** Optional — auto-generated (UUID) if omitted */
  id?: string;
  accountId?: string;
  category: ExpenseCategory;
  recurringId?: string;

  /**
   * The type of source document backing this expense.
   * Drives BIR classification hints and display labels.
   */
  documentType: ExpenseDocumentType;

  /**
   * Human-readable description of the expense.
   * @example "Office rent — June 2025", "Adobe Creative Cloud subscription"
   */
  description: string;

  /** The vendor, supplier, or service provider being paid */
  payee: Party;

  /** The entity making the payment (your company/individual) */
  paidBy: Party;

  /** ISO 4217 currency code */
  currency: CurrencyCode;

  /**
   * Date the expense was incurred (document date, not payment date).
   * Defaults to today if omitted.
   */
  expenseDate?: ISODateString;

  /**
   * Date payment was actually made.
   * Optional — may differ from expenseDate (accrual vs cash basis).
   */
  paidAt?: ISODateString;

  /**
   * Total amount of the expense.
   * Required when lineItems is not provided.
   * Ignored (recomputed) when lineItems is provided.
   */
  totalAmount?: number;

  /**
   * Optional itemized line items — reuses GeneralInvoice's LineItemInput shape.
   * When provided, totalAmount is derived from the line items.
   * Compatible with GeneralInvoice.lineItems for round-trip conversion.
   */
  lineItems?: LineItemInput[];

  /** Initial status — defaults to "draft" */
  status?: ExpenseRecordStatus;

  /**
   * Optional BIR-specific metadata.
   * Attach when this record needs to feed into BIR tax adapters.
   */
  bir?: BIRContext;

  /** Optional payment terms inherited from source document */
  paymentTerms?: PaymentTerms;

  /** Optional billing or service period */
  period?: Period;

  /** Optional document references (e.g. PO number, contract number) */
  references?: DocumentReference[];

  /** Free-form notes */
  notes?: string;

  /** Organizational tags */
  tags?: string[];

  /** Arbitrary metadata bag */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// ── OVERRIDE PARAMS FOR fromMajikInvoice ──────────────────────────────────────
// =============================================================================

/**
 * Optional overrides when constructing an ExpenseRecord from a MajikInvoice.
 *
 * By default:
 *   - payee  ← invoice.invoice.issuer   (the vendor who issued the invoice)
 *   - paidBy ← invoice.invoice.recipient (your entity receiving the invoice)
 *
 * Use these overrides to substitute different parties if needed.
 */
export interface FromMajikInvoiceOptions {
  /** Override the payee (vendor). Defaults to invoice issuer. */
  payee?: Party;
  /** Override the paidBy entity. Defaults to invoice recipient. */
  paidBy?: Party;
  /** Override the document type. Defaults to "supplier-invoice". */
  documentType?: ExpenseDocumentType;
  /** Attach BIR context at conversion time. */
  bir?: BIRContext;
  /** Override expense date. Defaults to invoice issueDate. */
  expenseDate?: ISODateString;
  /** Additional tags to attach */
  tags?: string[];
  /** Additional metadata to merge */
  metadata?: Record<string, unknown>;

  description?: string;

  accountId?: string;

  category?: ExpenseCategory;
}

// =============================================================================
// ── JSON SHAPE (persistence) ──────────────────────────────────────────────────
// =============================================================================

/**
 * Plain-object JSON representation of an ExpenseRecord.
 * This is what gets written to / read from storage adapters.
 */
export interface ExpenseRecordJSON {
  readonly version: string;
  readonly id: string;
  readonly account_id: string | null;
  readonly recurring_id?: string;
  readonly document_type: ExpenseDocumentType;
  readonly category: ExpenseCategory;
  readonly description: string;
  readonly payee: Party;
  readonly paid_by: Party;
  readonly currency: CurrencyCode;
  readonly expense_date: ISODateString;
  readonly paid_at?: ISODateString;
  /**
   * Persisted total amount.
   * When lineItems are present this is the computed grand total;
   * when absent it is the explicit totalAmount provided at creation.
   */
  readonly total_amount: number;
  readonly line_items?: LineItemInput[];
  readonly status: ExpenseRecordStatus;
  readonly bir?: BIRContext;
  readonly refunds: RefundRecord[];
  readonly payment_terms?: PaymentTerms;
  readonly period?: Period;
  readonly references?: DocumentReference[];
  readonly notes?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
  readonly created_at: ISODateTimeString;
  readonly updated_at: ISODateTimeString;
}

// =============================================================================
// ── INTERNAL STATE ────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Internal constructor state for ExpenseRecord.
 * Mirrors ExpenseRecordJSON but used inside the class constructor.
 * @internal
 */
export interface ExpenseRecordInternalState {
  readonly id: string;
  readonly accountId?: string | null;
  readonly recurringId?: string;
  readonly documentType: ExpenseDocumentType;
  readonly category: ExpenseCategory;
  readonly description: string;
  readonly payee: Party;
  readonly paidBy: Party;
  readonly currency: CurrencyCode;
  readonly expenseDate: ISODateString;
  readonly paidAt?: ISODateString;
  readonly totalAmount: number;
  readonly lineItems?: LineItemInput[];
  readonly status: ExpenseRecordStatus;
  readonly bir?: BIRContext;
  readonly refunds: RefundRecord[];
  readonly paymentTerms?: PaymentTerms;
  readonly period?: Period;
  readonly references?: DocumentReference[];
  readonly notes?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;
}

// =============================================================================
// ── VALIDATION ────────────────────────────────────────────────────────────────
// =============================================================================

export interface ExpenseRecordValidationError {
  field: string;
  message: string;
}

export interface ExpenseRecordValidationResult {
  valid: boolean;
  errors: ExpenseRecordValidationError[];
}

// ---------------------------------------------------------------------------
// Expense Query
// ---------------------------------------------------------------------------

export interface ExpenseQueryOptions {
  /** Filter by one or more statuses */
  status?: ExpenseRecordStatus | ExpenseRecordStatus[];
  /** Filter by document type */
  documentType?: ExpenseDocumentType;
  /** Filter by expense category */
  category?: ExpenseCategory;
  /** Filter by payee legalName (exact match) */
  payeeName?: string;
  /** Filter by paidBy legalName (exact match) */
  paidByName?: string;
  /** Filter by currency */
  currency?: CurrencyCode;
  /** Sort field — defaults to "expenseDate" descending */
  sortBy?: "expenseDate" | "createdAt" | "updatedAt" | "totalAmount";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ExpenseQueryResult {
  items: ExpenseRecord[];
  /** Total matching items before pagination */
  total: number;
  offset: number;
  limit: number;
}

// Add to ExpenseQueryOptions interface
export interface DateRangeFilter {
  from?: string; // ISO date string
  to?: string; // ISO date string
}

export interface ExpenseAdvancedQueryOptions extends ExpenseQueryOptions {
  /** Filter by signer public key fingerprint (matches public_key column) */
  publicKey?: string;
  /** Filter out invoices matching this public key */
  excludePublicKey?: string;
  /** Filter by expense date range */
  expenseDate?: DateRangeFilter;
  /** Filter by createdAt range */
  createdAt?: DateRangeFilter;
  /** Filter by paidAt range */
  paidAt?: DateRangeFilter;
  /** Filter by tag */
  tag?: string;
  /**
   * Filter by the recurringExpenseItemId stored in metadata.
   * Used by RecurringExpenseManager to check if a month has been actualized.
   */
  recurringId?: string;
  /** Filter by actualizationMonth stored in metadata */
  actualizationMonth?: string;
}

// ---------------------------------------------------------------------------
// Recurring Expense Query
// ---------------------------------------------------------------------------

export interface RecurringExpenseQueryOptions {
  /** Filter by one or more statuses. */
  status?: RecurringExpenseItemStatus | RecurringExpenseItemStatus[];

  /** Sort field — defaults to "createdAt" descending. */
  sortBy?: "createdAt" | "updatedAt" | "total";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface RecurringExpenseQueryResult {
  items: RecurringExpenseItem[];
  /** Total matching items before pagination. */
  total: number;
  offset: number;
  limit: number;
}

export interface RecurringExpenseAdvancedQueryOptions extends RecurringExpenseQueryOptions {
  /** Filter by signer public key fingerprint (matches public_key column) */
  publicKey?: string;
  /** Filter out invoices matching this public key */
  excludePublicKey?: string;
  /** Filter by created_at date range */
  createdAt?: DateRangeFilter;
}
