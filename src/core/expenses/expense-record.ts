/**
 * @file expense-record.ts
 * @description ExpenseRecord — an immutable, adapter-ready expense record.
 *
 * Design mirrors GeneralInvoice closely:
 *   - Private constructor + static create() factory
 *   - Immutable with* mutation methods that return new instances
 *   - Guarded status transitions via EXPENSE_RECORD_ALLOWED_TRANSITIONS
 *   - Optional line items reusing GeneralInvoice's LineItem/TaxManager
 *   - BIR metadata lives in a separate optional BIRContext object
 *   - Refunds tracked as RefundRecord[] with computed effectiveStatus
 *   - fromMajikInvoice() static factory for direct conversion
 *   - toJSON() / fromJSON() for adapter round-trips
 *
 * Status lifecycle:
 *   draft → approved → refunded
 *
 * Effective status (computed, not persisted):
 *   draft | approved | partially-refunded | refunded
 */

import {
  MajikInvoice,
  LineItem,
  TaxManager,
  InvoiceTotals,
} from "@majikah/majik-invoice";

import type {
  BIRContext,
  ExpenseCategory,
  ExpenseDocumentType,
  ExpenseRecordEffectiveStatus,
  ExpenseRecordInput,
  ExpenseRecordInternalState,
  ExpenseRecordJSON,
  ExpenseRecordStatus,
  ExpenseRecordValidationResult,
  FromMajikInvoiceOptions,
  RefundRecord,
} from "./types";

import type {
  Party,
  DocumentReference,
  Period,
  PaymentTerms,
  CurrencyCode,
  ISODateString,
  ISODateTimeString,
  LineItemInput,
  TaxDetail,
} from "@majikah/majik-invoice";

import {
  EXPENSE_RECORD_ALLOWED_TRANSITIONS,
  EXPENSE_DOCUMENT_TYPE_LABELS,
} from "./constants";

import {
  ExpenseRecordError,
  ExpenseRecordLifecycleError,
  ExpenseRecordMutationError,
} from "./errors";
import { generateUUID } from "../utils/utilities";

// Schema version — bump on breaking JSON shape changes
const EXPENSE_RECORD_SCHEMA_VERSION = "1.0.0";

// =============================================================================
// ── Internal VAT extraction result ────────────────────────────────────────────
// =============================================================================

interface VatExtractionResult {
  vatAmount: number;
  vatRate: number | undefined;
  found: boolean;
}

// =============================================================================
// ── ExpenseRecord ─────────────────────────────────────────────────────────────
// =============================================================================

export class ExpenseRecord {
  // ── Schema ────────────────────────────────────────────────────────────────
  readonly version: string;

  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;
  readonly documentType: ExpenseDocumentType;
  readonly description: string;
  readonly accountId?: string | null;

  readonly recurringId?: string;

  readonly category: ExpenseCategory = "other";

  // ── Parties ───────────────────────────────────────────────────────────────
  /** The vendor / supplier / service provider being paid */
  readonly payee: Party;
  /** The entity making the payment (your company or individual) */
  readonly paidBy: Party;

  // ── Financials ────────────────────────────────────────────────────────────
  readonly currency: CurrencyCode;
  /**
   * Gross total of this expense.
   * When lineItems are present this is the computed grand total from them.
   * When absent it is the explicit amount provided at creation.
   */
  readonly totalAmount: number;
  /**
   * Optional itemized line items — reuses GeneralInvoice's LineItemInput shape.
   * When present, totalAmount is derived from line item grand totals.
   */
  readonly lineItems?: readonly LineItemInput[];

  // ── Dates ─────────────────────────────────────────────────────────────────
  /** Date the expense was incurred (document date, not necessarily payment date) */
  readonly expenseDate: ISODateString;
  /** Date payment was actually made — may differ from expenseDate */
  readonly paidAt?: ISODateString;

  // ── Status ────────────────────────────────────────────────────────────────
  readonly status: ExpenseRecordStatus;

  // ── Refunds ───────────────────────────────────────────────────────────────
  readonly refunds: readonly RefundRecord[];

  // ── BIR ───────────────────────────────────────────────────────────────────
  /** Optional BIR-specific metadata — attach when feeding into tax adapters */
  readonly bir?: BIRContext;

  // ── Supplementary ─────────────────────────────────────────────────────────
  readonly paymentTerms?: PaymentTerms;
  readonly period?: Period;
  readonly references?: readonly DocumentReference[];
  readonly notes?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;

  // ── Timestamps ────────────────────────────────────────────────────────────
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;

  // ── Private constructor ───────────────────────────────────────────────────

  private constructor(state: ExpenseRecordInternalState) {
    this.version = EXPENSE_RECORD_SCHEMA_VERSION;
    this.id = state.id;
    this.recurringId = state.recurringId;
    this.accountId = state.accountId;
    this.documentType = state.documentType;
    this.category = state.category;
    this.description = state.description;
    this.payee = state.payee;
    this.paidBy = state.paidBy;
    this.currency = state.currency;
    this.totalAmount = state.totalAmount;
    this.lineItems = state.lineItems
      ? Object.freeze([...state.lineItems])
      : undefined;
    this.expenseDate = state.expenseDate;
    this.paidAt = state.paidAt;
    this.status = state.status;
    this.refunds = Object.freeze([...state.refunds]);
    this.bir = state.bir ? { ...state.bir } : undefined;
    this.paymentTerms = state.paymentTerms;
    this.period = state.period;
    this.references = state.references
      ? Object.freeze([...state.references])
      : undefined;
    this.notes = state.notes;
    this.tags = state.tags ? [...state.tags] : undefined;
    this.metadata = state.metadata ? { ...state.metadata } : undefined;
    this.createdAt = state.createdAt;
    this.updatedAt = state.updatedAt;
  }

  // ==========================================================================
  // ── PRIVATE STATIC HELPERS ─────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Normalise a raw tag array: trim, deduplicate, remove empties.
   * Single source of truth for tag cleaning across all mutation methods.
   */
  static normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  }

  /**
   * Compute the grand total from a LineItemInput[] by instantiating
   * LineItem instances via the same pipeline GeneralInvoice uses.
   * This ensures tax/discount math is consistent across both domains.
   */
  static _computeTotalFromLineItems(
    lineItems: LineItemInput[],
    currency: CurrencyCode,
  ): number {
    const items = lineItems.map((li) => {
      const taxes = TaxManager.coerce(li.taxes);
      return LineItem.create({ ...li, taxes: taxes.toArray() }, currency);
    });
    return InvoiceTotals.fromLineItems(items, currency).grandTotalAmount;
  }

  /**
   * Instantiate LineItem objects from LineItemInput[], used by both
   * VAT extraction and total computation.
   */
  private static _toLineItems(
    lineItems: LineItemInput[],
    currency: CurrencyCode,
  ): LineItem[] {
    return lineItems.map((li) => {
      const taxes = TaxManager.coerce(li.taxes);
      return LineItem.create({ ...li, taxes: taxes.toArray() }, currency);
    });
  }

  /**
   * Scan instantiated LineItem[] and extract aggregate additive VAT details.
   * Single source of truth — replaces duplicated loops in computeBirContext,
   * withLineItems, and fromMajikInvoice.
   */
  private static _extractVatFromLineItems(
    items: LineItem[],
  ): VatExtractionResult {
    let vatAmount = 0;
    let vatRate: number | undefined;
    let found = false;

    for (const item of items) {
      const taxesArray = item.taxes?.toArray ? item.taxes.toArray() : [];
      for (const t of taxesArray) {
        const taxType = (t.taxType ?? "").toString();
        const behaviour = (t.behaviour ?? "additive").toString();
        if (taxType.toLowerCase().includes("vat") && behaviour === "additive") {
          found = true;
          vatAmount += item.taxAmountByType(t.taxType);
          if (vatRate === undefined && typeof t.rate === "number") {
            vatRate = t.rate;
          }
        }
      }
    }

    return { vatAmount, vatRate, found };
  }

  /**
   * Compute a conservative BIR patch derived from an ExpenseCategory.
   * Only returns fields that are not already present on `existing`.
   * This helper is intentionally conservative: it never overwrites explicit
   * values and it never auto-attaches a BIR context when none exists.
   */
  private static computeBirPatchFromCategory(
    category: ExpenseCategory,
    existing?: Partial<BIRContext>,
  ): Partial<BIRContext> {
    const patch: Partial<BIRContext> = {};
    const has = (k: keyof BIRContext) =>
      existing && typeof (existing as any)[k] !== "undefined";

    switch (category) {
      case "depreciation":
        if (!has("isDepreciation")) patch.isDepreciation = true;
        if (!has("purchaseType")) patch.purchaseType = "capital-goods";
        break;
      case "representation":
        if (!has("isRepresentation")) patch.isRepresentation = true;
        break;
      case "cost-of-sales":
      case "supplies":
        if (!has("purchaseType"))
          patch.purchaseType = "goods-other-than-capital";
        break;
      case "professional-fees":
      case "rent":
      case "utilities":
      case "transportation":
      case "communication":
      case "insurance":
      case "compensation":
        if (!has("purchaseType")) patch.purchaseType = "services";
        break;
      default:
        break;
    }

    return patch;
  }

  /**
   * Compute a full BIR context by merging existing values with derived
   * information from category, line items, totals, payee, and documentType.
   * Returns `undefined` when there is no existing context and nothing to
   * derive (so callers can avoid attaching empty BIR objects).
   */
  private static computeBirContext(opts: {
    existing?: BIRContext | Partial<BIRContext> | undefined;
    category?: ExpenseCategory;
    lineItems?: LineItemInput[] | undefined;
    totalAmount?: number | undefined;
    currency?: CurrencyCode | undefined;
    payee?: Party | undefined;
    documentType?: ExpenseDocumentType | undefined;
  }): BIRContext | undefined {
    const { existing, category, lineItems, totalAmount, currency, payee } =
      opts;

    const result: Partial<BIRContext> = existing ? { ...existing } : {};
    const hadExisting = !!existing;
    let changed = false;

    // Derive from line items when available
    if (lineItems && lineItems.length > 0) {
      const items = ExpenseRecord._toLineItems(
        lineItems,
        (currency as CurrencyCode) || ("PHP" as CurrencyCode),
      );
      const { vatAmount, vatRate, found } =
        ExpenseRecord._extractVatFromLineItems(items);

      if (result.inputVatAmount === undefined && found) {
        result.inputVatAmount = vatAmount;
        changed = true;
      }
      if (result.inputVatRate === undefined && vatRate !== undefined) {
        result.inputVatRate = vatRate;
        changed = true;
      }
      if (result.vatClassification === undefined && found) {
        result.vatClassification = vatRate === 0 ? "zero-rated" : "creditable";
        changed = true;
      }
    } else {
      // No line items — derive inputVatAmount from totalAmount × inputVatRate
      if (
        result.inputVatAmount === undefined &&
        typeof result.inputVatRate === "number" &&
        typeof totalAmount === "number"
      ) {
        result.inputVatAmount = totalAmount * result.inputVatRate;
        changed = true;
      }
    }

    // Category-derived defaults (conservative)
    if (category) {
      const categoryPatch = ExpenseRecord.computeBirPatchFromCategory(
        category,
        result,
      );
      for (const k of Object.keys(categoryPatch) as (keyof BIRContext)[]) {
        if ((result as any)[k] === undefined) {
          (result as any)[k] = (categoryPatch as any)[k];
          changed = true;
        }
      }
    }

    // Supplier TIN from payee
    if (payee?.tin && result.supplierTin === undefined) {
      result.supplierTin = payee.tin;
      changed = true;
    }

    if (!hadExisting && !changed) return undefined;
    return result as BIRContext;
  }

  // ── Internal rebuild ──────────────────────────────────────────────────────

  private rebuild(
    overrides: Partial<ExpenseRecordInternalState>,
  ): ExpenseRecord {
    const hasLineItemsOverride = Object.prototype.hasOwnProperty.call(
      overrides,
      "lineItems",
    );
    const hasTotalAmountOverride = Object.prototype.hasOwnProperty.call(
      overrides,
      "totalAmount",
    );

    const resultingLineItems = hasLineItemsOverride
      ? overrides.lineItems
        ? [...overrides.lineItems]
        : undefined
      : this.lineItems
        ? [...this.lineItems]
        : undefined;

    const resultingCurrency = overrides.currency ?? this.currency;

    const resultingTotalAmount =
      hasTotalAmountOverride && typeof overrides.totalAmount === "number"
        ? overrides.totalAmount
        : resultingLineItems && resultingLineItems.length > 0
          ? ExpenseRecord._computeTotalFromLineItems(
              resultingLineItems,
              resultingCurrency,
            )
          : this.totalAmount;

    // Resolve BIR context (respect explicit undefined)
    let resultingBir: BIRContext | undefined;
    if (Object.prototype.hasOwnProperty.call(overrides, "bir")) {
      resultingBir = overrides.bir
        ? { ...(overrides.bir as BIRContext) }
        : undefined;
    } else if (this.bir) {
      resultingBir = { ...this.bir };
    }

    const explicitlyClearedBir =
      Object.prototype.hasOwnProperty.call(overrides, "bir") &&
      overrides.bir === undefined;

    if (!explicitlyClearedBir) {
      const computedBir = ExpenseRecord.computeBirContext({
        existing: resultingBir,
        category: overrides.category ?? this.category,
        lineItems: resultingLineItems,
        totalAmount: resultingTotalAmount,
        currency: resultingCurrency,
        payee: overrides.payee ?? this.payee,
        documentType: overrides.documentType ?? this.documentType,
      });
      if (computedBir !== undefined) resultingBir = computedBir;
    }

    return new ExpenseRecord({
      id: overrides.id ?? this.id,
      accountId: overrides.accountId ?? this.accountId,
      documentType: overrides.documentType ?? this.documentType,
      category: overrides.category ?? this.category,
      description: overrides.description ?? this.description,
      payee: overrides.payee ?? this.payee,
      paidBy: overrides.paidBy ?? this.paidBy,
      currency: resultingCurrency,
      totalAmount: resultingTotalAmount,
      lineItems: resultingLineItems,
      expenseDate: overrides.expenseDate ?? this.expenseDate,
      paidAt: Object.prototype.hasOwnProperty.call(overrides, "paidAt")
        ? overrides.paidAt
        : this.paidAt,
      status: overrides.status ?? this.status,
      refunds: overrides.refunds ? [...overrides.refunds] : [...this.refunds],
      bir: resultingBir ? { ...resultingBir } : undefined,
      paymentTerms: overrides.paymentTerms ?? this.paymentTerms,
      period: overrides.period ?? this.period,
      references:
        overrides.references !== undefined
          ? overrides.references
            ? [...overrides.references]
            : undefined
          : this.references
            ? [...this.references]
            : undefined,
      notes: Object.prototype.hasOwnProperty.call(overrides, "notes")
        ? overrides.notes
        : this.notes,
      tags:
        overrides.tags !== undefined
          ? overrides.tags
            ? [...overrides.tags]
            : undefined
          : this.tags
            ? [...this.tags]
            : undefined,
      metadata:
        overrides.metadata !== undefined
          ? overrides.metadata
            ? { ...overrides.metadata }
            : undefined
          : this.metadata
            ? { ...this.metadata }
            : undefined,
      createdAt: overrides.createdAt ?? this.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  private assertNotRefunded(operation: string): void {
    if (this.status === "refunded") {
      throw new ExpenseRecordMutationError(
        `Cannot ${operation} on a fully refunded expense record (id: ${this.id}). ` +
          `Refunded records are immutable.`,
      );
    }
  }

  private assertApproved(operation: string): void {
    if (this.status !== "approved") {
      throw new ExpenseRecordMutationError(
        `Cannot ${operation} on an expense record with status "${this.status}". ` +
          `This operation requires an approved record.`,
      );
    }
  }

  private assertDraft(operation: string): void {
    if (this.status !== "draft") {
      throw new ExpenseRecordMutationError(
        `Cannot ${operation} on an expense record with status "${this.status}". ` +
          `Structural changes are only allowed on draft records.`,
      );
    }
  }

  private static assertDateFormat(date: string, field: string): void {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ExpenseRecordError(
        `${field} must be in YYYY-MM-DD format`,
        field,
      );
    }
  }

  private static assertValidReference(
    ref: DocumentReference,
    field: string,
  ): void {
    if (!ref || typeof ref !== "object") {
      throw new ExpenseRecordError("Reference must be a valid object", field);
    }
    if (!ref.type?.trim()) {
      throw new ExpenseRecordError(
        "Reference type is required",
        `${field}.type`,
      );
    }
    if (!ref.number?.trim()) {
      throw new ExpenseRecordError(
        "Reference number is required",
        `${field}.number`,
      );
    }
  }

  // ── Static factory ────────────────────────────────────────────────────────

  /**
   * Create a new ExpenseRecord from an input object.
   *
   * When lineItems are provided, totalAmount is computed from them.
   * When only totalAmount is provided, lineItems remains undefined.
   *
   * @throws {ExpenseRecordError} if validation fails
   */
  static create(input: ExpenseRecordInput): ExpenseRecord {
    ExpenseRecord.assertValid(input);

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    let totalAmount: number;
    let lineItems: LineItemInput[] | undefined;

    if (input.lineItems && input.lineItems.length > 0) {
      lineItems = input.lineItems;
      totalAmount = ExpenseRecord._computeTotalFromLineItems(
        input.lineItems,
        input.currency,
      );
    } else {
      totalAmount = input.totalAmount!;
      lineItems = undefined;
    }

    const computedBir = ExpenseRecord.computeBirContext({
      existing: input.bir ? { ...input.bir } : undefined,
      category: input.category ?? "other",
      lineItems,
      totalAmount,
      currency: input.currency,
      payee: input.payee,
      documentType: input.documentType,
    });

    return new ExpenseRecord({
      id: input.id ?? generateUUID(),
      accountId: input.accountId,
      recurringId: input.recurringId,
      documentType: input.documentType,
      category: input.category ?? "other",
      description: input.description.trim(),
      payee: input.payee,
      paidBy: input.paidBy,
      currency: input.currency,
      totalAmount,
      lineItems,
      expenseDate: input.expenseDate ?? today,
      paidAt: input.paidAt,
      status: input.status ?? "draft",
      refunds: [],
      bir: computedBir ? { ...computedBir } : undefined,
      paymentTerms: input.paymentTerms,
      period: input.period,
      references: input.references ? [...input.references] : undefined,
      notes: input.notes?.trim(),
      tags: input.tags ? ExpenseRecord.normalizeTags(input.tags) : undefined,
      metadata: input.metadata ? { ...input.metadata } : undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Duplicate this record as a fresh draft.
   * Resets: id, status → draft, refunds, paidAt, timestamps.
   * Preserves all other fields (line items, BIR, parties, etc.).
   */
  duplicate(accountId?: string): ExpenseRecord {
    const now = new Date().toISOString();
    return this.rebuild({
      id: generateUUID(),
      status: "draft",
      refunds: [],
      paidAt: undefined, // FIX: don't carry over payment date into a fresh duplicate
      createdAt: now,
      updatedAt: now,
      accountId: accountId ?? this.accountId,
    });
  }

  // ── fromMajikInvoice ──────────────────────────────────────────────────────

  /**
   * Construct an ExpenseRecord from a received MajikInvoice.
   *
   * Party inversion:
   *   - payee  ← invoice.invoice.issuer   (the vendor who issued and signed it)
   *   - paidBy ← invoice.invoice.recipient (your entity — the one receiving)
   *
   * @throws {ExpenseRecordError} if the underlying GeneralInvoice is invalid
   */
  static fromMajikInvoice(
    majikInvoice: MajikInvoice,
    options: FromMajikInvoiceOptions = {},
  ): ExpenseRecord {
    const invoice = majikInvoice.invoice;

    const payee = options.payee ?? invoice.issuer;
    const paidBy = options.paidBy ?? invoice.recipient;

    const lineItems: LineItemInput[] = invoice.lineItems.map((li) => ({
      id: li.id,
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice.toMajor(),
      unit: li.unit,
      taxes: li.taxes.toArray(),
      discount: li.discount,
      accountCode: li.accountCode,
      costCenter: li.costCenter,
      tags: li.tags,
      metadata: li.metadata,
    }));

    const now = new Date().toISOString();
    const totalAmount = ExpenseRecord._computeTotalFromLineItems(
      lineItems,
      invoice.currency,
    );

    const metadata: Record<string, unknown> = {
      sourceInvoiceId: majikInvoice.id,
      ...(options.metadata ?? {}),
    };

    const mergedTags = ExpenseRecord.normalizeTags([
      ...(invoice.tags ?? []),
      ...(options.tags ?? []),
    ]);

    const computedBir = ExpenseRecord.computeBirContext({
      existing: options.bir ? { ...options.bir } : undefined,
      category: options.category ?? "other",
      lineItems,
      totalAmount,
      currency: invoice.currency,
      payee,
      documentType: options.documentType ?? "supplier-invoice",
    });

    return new ExpenseRecord({
      id: generateUUID(),
      documentType: options.documentType ?? "supplier-invoice",
      category: options.category ?? "other",
      description:
        options.description ??
        invoice.notes?.slice(0, 120) ??
        `Invoice from ${payee.legalName}`,
      payee,
      paidBy,
      accountId: options.accountId ?? majikInvoice?.signerIds?.[0] ?? null,
      currency: invoice.currency,
      totalAmount,
      lineItems,
      expenseDate: options.expenseDate ?? invoice.issueDate,
      paidAt: undefined,
      status: "draft",
      refunds: [],
      bir: computedBir ? { ...computedBir } : undefined,
      paymentTerms: invoice.paymentTerms,
      period: invoice.period,
      references: invoice.references ? [...invoice.references] : undefined,
      notes: invoice.notes,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ==========================================================================
  // ── WITH* MUTATION METHODS ─────────────────────────────────────────────────
  // ==========================================================================

  // ── Status ────────────────────────────────────────────────────────────────

  withStatus(status: ExpenseRecordStatus, force = false): ExpenseRecord {
    if (this.status === status) return this;

    const allowed = EXPENSE_RECORD_ALLOWED_TRANSITIONS[this.status];
    if (!allowed.includes(status) && !force) {
      throw new ExpenseRecordLifecycleError(
        `Invalid status transition: "${this.status}" → "${status}". ` +
          `Allowed from "${this.status}": [${allowed.join(", ") || "none"}].`,
        this.status,
        status,
      );
    }

    return this.rebuild({ status });
  }

  /** Approve this expense record (draft → approved) */
  approve(): ExpenseRecord {
    return this.withStatus("approved");
  }

  /**
   * Mark as fully refunded (approved → refunded).
   * If partial refunds already exist, this marks the record terminal without
   * adding a new refund entry — use addRefund() for explicit tracking.
   */
  markAsRefunded(reason?: string): ExpenseRecord {
    this.assertApproved("mark as refunded");

    const remaining = this.refundableAmount;
    const newRefunds =
      remaining > 0.001
        ? [
            ...this.refunds,
            {
              id: generateUUID(),
              amount: remaining,
              refundedAt: new Date().toISOString().slice(0, 10),
              reason: reason?.trim(),
            },
          ]
        : [...this.refunds];

    return this.rebuild({ status: "refunded", refunds: newRefunds });
  }

  // ── Description ───────────────────────────────────────────────────────────

  withDescription(description: string): ExpenseRecord {
    this.assertDraft("set description");
    if (!description?.trim()) {
      throw new ExpenseRecordError(
        "Description cannot be empty",
        "description",
      );
    }
    return this.rebuild({ description: description.trim() });
  }

  // ── Document type ─────────────────────────────────────────────────────────

  withDocumentType(documentType: ExpenseDocumentType): ExpenseRecord {
    this.assertDraft("set document type");
    return this.rebuild({ documentType });
  }

  // ── Category ──────────────────────────────────────────────────────────────

  withCategory(category: ExpenseCategory): ExpenseRecord {
    this.assertDraft("set category");
    // Do not auto-attach a BIR context; only patch when one already exists
    if (!this.bir) return this.rebuild({ category });

    const categoryPatch = ExpenseRecord.computeBirPatchFromCategory(
      category,
      this.bir,
    );
    if (Object.keys(categoryPatch).length === 0)
      return this.rebuild({ category });

    return this.rebuild({
      category,
      bir: { ...(this.bir ?? {}), ...categoryPatch } as BIRContext,
    });
  }

  // ── Parties ───────────────────────────────────────────────────────────────

  withPayee(payee: Party): ExpenseRecord {
    this.assertDraft("set payee");
    if (!payee?.legalName?.trim()) {
      throw new ExpenseRecordError(
        "Payee must have a legalName",
        "payee.legalName",
      );
    }
    return this.rebuild({ payee });
  }

  withPaidBy(paidBy: Party): ExpenseRecord {
    this.assertDraft("set paidBy");
    if (!paidBy?.legalName?.trim()) {
      throw new ExpenseRecordError(
        "PaidBy must have a legalName",
        "paidBy.legalName",
      );
    }
    return this.rebuild({ paidBy });
  }

  // ── Dates ─────────────────────────────────────────────────────────────────

  withExpenseDate(date: ISODateString): ExpenseRecord {
    this.assertDraft("set expense date");
    ExpenseRecord.assertDateFormat(date, "expenseDate");
    return this.rebuild({ expenseDate: date });
  }

  withPaidAt(date: ISODateString): ExpenseRecord {
    this.assertNotRefunded("set paid date");
    ExpenseRecord.assertDateFormat(date, "paidAt");
    return this.rebuild({ paidAt: date });
  }

  withoutPaidAt(): ExpenseRecord {
    this.assertNotRefunded("clear paid date");
    return this.rebuild({ paidAt: undefined });
  }

  // ── Amount (single-amount records only) ───────────────────────────────────

  /**
   * Update the total amount on a single-amount record (no line items).
   * @throws if the record has line items — update them via withLineItems() instead.
   */
  withTotalAmount(amount: number): ExpenseRecord {
    this.assertDraft("set total amount");
    if (this.lineItems && this.lineItems.length > 0) {
      throw new ExpenseRecordMutationError(
        `Cannot set totalAmount directly on a record with line items. ` +
          `Update the line items via withLineItems() instead.`,
        "totalAmount",
      );
    }
    if (typeof amount !== "number" || amount <= 0) {
      throw new ExpenseRecordError(
        "totalAmount must be a positive number",
        "totalAmount",
      );
    }
    return this.rebuild({ totalAmount: amount });
  }

  // ── Line items ────────────────────────────────────────────────────────────

  /**
   * Replace all line items and recompute totalAmount + BIR VAT context.
   * BIR re-computation is handled entirely by rebuild() → computeBirContext().
   */
  withLineItems(lineItems: LineItemInput[]): ExpenseRecord {
    this.assertDraft("replace line items");
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new ExpenseRecordError(
        "At least one line item is required",
        "lineItems",
      );
    }
    // totalAmount and BIR are fully recomputed inside rebuild()
    return this.rebuild({ lineItems: [...lineItems] });
  }

  /**
   * Remove all line items, converting to a single-amount record.
   * The current totalAmount is preserved.
   */
  withoutLineItems(): ExpenseRecord {
    this.assertDraft("remove line items");
    return this.rebuild({ lineItems: undefined });
  }

  // ── Line-item tax helpers ──────────────────────────────────────────────────

  /**
   * Replace the taxes on a single line item identified by its `id`.
   *
   * @throws {ExpenseRecordError} if no line item with the given id exists
   */
  withLineItemTaxes(lineItemId: string, taxes: TaxDetail[]): ExpenseRecord {
    this.assertDraft("update line item taxes");
    const items = this.lineItems ? [...this.lineItems] : [];
    const idx = items.findIndex((li) => li.id === lineItemId);
    if (idx === -1) {
      throw new ExpenseRecordError(
        `No line item with id "${lineItemId}" found`,
        "lineItemId",
      );
    }
    const updated = items.map((li, i) =>
      i === idx ? { ...li, taxes: [...taxes] } : li,
    );
    return this.rebuild({ lineItems: updated });
  }

  /**
   * Copy the tax configuration from one line item onto all other line items.
   *
   * @param sourceLineItemId  ID of the line item whose taxes will be broadcast.
   * @throws {ExpenseRecordError} if no line item with the given id exists
   */
  withUniformTaxes(sourceLineItemId: string): ExpenseRecord {
    this.assertDraft("apply uniform taxes");
    if (!this.lineItems || this.lineItems.length === 0) return this;

    const source = this.lineItems.find((li) => li.id === sourceLineItemId);
    if (!source) {
      throw new ExpenseRecordError(
        `No line item with id "${sourceLineItemId}" found`,
        "sourceLineItemId",
      );
    }

    const taxes: TaxDetail[] = source.taxes
      ? TaxManager.coerce(source.taxes).toArray()
      : [];

    const updated = this.lineItems.map((li) => ({ ...li, taxes: [...taxes] }));
    return this.rebuild({ lineItems: updated });
  }

  /**
   * Apply an explicit TaxDetail array to every line item at once.
   * Use this for programmatic tax setup without picking a source line item.
   */
  withAllLineItemTaxes(taxes: TaxDetail[]): ExpenseRecord {
    this.assertDraft("apply taxes to all line items");
    if (!this.lineItems || this.lineItems.length === 0) return this;

    TaxManager.fromMany([...taxes]);

    const updated = this.lineItems.map((li) => ({ ...li, taxes: [...taxes] }));
    return this.rebuild({ lineItems: updated });
  }

  // ── BIR quick-update shortcuts ─────────────────────────────────────────────

  /**
   * Set the input VAT rate on the BIR context.
   * Initialises an empty BIR context if none exists yet.
   * @param rate - decimal rate, e.g. 0.12 for 12%
   */
  withInputVatRate(rate: number): ExpenseRecord {
    this.assertNotRefunded("set input VAT rate");
    if (typeof rate !== "number" || rate < 0 || rate > 1) {
      throw new ExpenseRecordError(
        "inputVatRate must be a number between 0 and 1 (e.g. 0.12 for 12%)",
        "bir.inputVatRate",
      );
    }
    return this.rebuild({ bir: { ...(this.bir ?? {}), inputVatRate: rate } });
  }

  /**
   * Set an explicit input VAT amount override on the BIR context.
   * Takes precedence over inputVatRate when both are set.
   */
  withInputVatAmount(amount: number): ExpenseRecord {
    this.assertNotRefunded("set input VAT amount");
    if (typeof amount !== "number" || amount < 0) {
      throw new ExpenseRecordError(
        "inputVatAmount must be a non-negative number",
        "bir.inputVatAmount",
      );
    }
    return this.rebuild({
      bir: { ...(this.bir ?? {}), inputVatAmount: amount },
    });
  }

  /**
   * Set the EWT ATC code on the BIR context.
   * @param code - BIR ATC code, e.g. "WI010", "WC158"
   */
  withWithholdingAtc(code: string): ExpenseRecord {
    this.assertNotRefunded("set withholding ATC");
    if (!code?.trim()) {
      throw new ExpenseRecordError(
        "Withholding ATC code cannot be empty",
        "bir.withholdingAtcCode",
      );
    }
    return this.rebuild({
      bir: { ...(this.bir ?? {}), withholdingAtcCode: code.trim() },
    });
  }

  /**
   * Set an explicit withholding (EWT) amount on the BIR context.
   */
  withWithholdingAmount(amount: number): ExpenseRecord {
    this.assertNotRefunded("set withholding amount");
    if (typeof amount !== "number" || amount < 0) {
      throw new ExpenseRecordError(
        "withholdingAmount must be a non-negative number",
        "bir.withholdingAmount",
      );
    }
    return this.rebuild({
      bir: { ...(this.bir ?? {}), withholdingAmount: amount },
    });
  }

  // ── BIR context ───────────────────────────────────────────────────────────

  /**
   * Attach or replace the BIR context on this record.
   * Can be called on any non-refunded record since BIR metadata is
   * often resolved after the fact.
   */
  withBIR(bir: BIRContext): ExpenseRecord {
    this.assertNotRefunded("set BIR context");
    return this.rebuild({ bir: { ...bir } });
  }

  /** Patch specific fields of the BIR context without replacing the whole object. */
  withBIRPatch(patch: Partial<BIRContext>): ExpenseRecord {
    this.assertNotRefunded("patch BIR context");
    return this.rebuild({ bir: { ...(this.bir ?? {}), ...patch } });
  }

  withoutBIR(): ExpenseRecord {
    this.assertNotRefunded("remove BIR context");
    return this.rebuild({ bir: undefined });
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  withNotes(notes: string): ExpenseRecord {
    this.assertNotRefunded("set notes");
    return this.rebuild({ notes: notes.trim() });
  }

  withoutNotes(): ExpenseRecord {
    this.assertNotRefunded("clear notes");
    return this.rebuild({ notes: undefined });
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  withTags(tags: string[]): ExpenseRecord {
    this.assertNotRefunded("set tags");
    if (!Array.isArray(tags)) {
      throw new ExpenseRecordError("Tags must be an array", "tags");
    }
    return this.rebuild({ tags: ExpenseRecord.normalizeTags(tags) });
  }

  withTag(tag: string): ExpenseRecord {
    this.assertNotRefunded("add tag");
    if (!tag?.trim()) {
      throw new ExpenseRecordError("Tag cannot be empty", "tag");
    }
    const trimmed = tag.trim();
    if ((this.tags ?? []).includes(trimmed)) return this;
    return this.rebuild({ tags: [...(this.tags ?? []), trimmed] });
  }

  withoutTag(tag: string): ExpenseRecord {
    this.assertNotRefunded("remove tag");
    return this.rebuild({
      tags: (this.tags ?? []).filter((t) => t !== tag.trim()),
    });
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  withMetadata(patch: Record<string, unknown>): ExpenseRecord {
    this.assertNotRefunded("update metadata");
    const merged: Record<string, unknown> = { ...(this.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return this.rebuild({ metadata: merged });
  }

  withMetadataReplaced(metadata: Record<string, unknown>): ExpenseRecord {
    this.assertNotRefunded("replace metadata");
    return this.rebuild({ metadata: { ...metadata } });
  }

  withoutMetadata(): ExpenseRecord {
    this.assertNotRefunded("clear metadata");
    return this.rebuild({ metadata: undefined });
  }

  // ── References ────────────────────────────────────────────────────────────

  withReference(ref: DocumentReference): ExpenseRecord {
    this.assertNotRefunded("add reference");
    ExpenseRecord.assertValidReference(ref, "reference");
    const existing = this.references ? [...this.references] : [];
    return this.rebuild({ references: [...existing, { ...ref }] });
  }

  withReferences(refs: DocumentReference[]): ExpenseRecord {
    this.assertNotRefunded("replace references");
    refs.forEach((ref, i) =>
      ExpenseRecord.assertValidReference(ref, `references[${i}]`),
    );
    return this.rebuild({ references: refs.map((r) => ({ ...r })) });
  }

  withoutReference(type: string, number: string): ExpenseRecord {
    this.assertNotRefunded("remove reference");
    return this.rebuild({
      references: (this.references ?? []).filter(
        (r) => !(r.type === type && r.number === number),
      ),
    });
  }

  withoutReferences(): ExpenseRecord {
    this.assertNotRefunded("clear references");
    return this.rebuild({ references: undefined });
  }

  // ── Period & payment terms ────────────────────────────────────────────────

  withPeriod(period: Period): ExpenseRecord {
    this.assertDraft("set period");
    if (!period?.start || !period?.end) {
      throw new ExpenseRecordError(
        "Period must have both start and end dates",
        "period",
      );
    }
    if (period.end < period.start) {
      throw new ExpenseRecordError(
        `period.end (${period.end}) cannot be before period.start (${period.start})`,
        "period",
      );
    }
    return this.rebuild({ period: { ...period } });
  }

  withoutPeriod(): ExpenseRecord {
    this.assertDraft("remove period");
    return this.rebuild({ period: undefined });
  }

  withPaymentTerms(terms: PaymentTerms): ExpenseRecord {
    this.assertNotRefunded("set payment terms");
    return this.rebuild({ paymentTerms: terms });
  }

  // ==========================================================================
  // ── REFUND METHODS ─────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Record a refund event against this expense.
   *
   * Partial refunds accumulate. When total refunded equals totalAmount,
   * status auto-transitions to "refunded".
   *
   * @throws if the record is not approved
   * @throws if amount exceeds the remaining refundable balance
   */
  addRefund(refund: Omit<RefundRecord, "id">): ExpenseRecord {
    this.assertApproved("add refund");

    if (typeof refund.amount !== "number" || refund.amount <= 0) {
      throw new ExpenseRecordError(
        "Refund amount must be a positive number",
        "refund.amount",
      );
    }

    const remaining = this.refundableAmount;
    if (refund.amount > remaining + 0.001) {
      throw new ExpenseRecordError(
        `Refund amount (${refund.amount}) exceeds refundable balance (${remaining.toFixed(2)})`,
        "refund.amount",
      );
    }

    ExpenseRecord.assertDateFormat(refund.refundedAt, "refund.refundedAt");

    const newRefund: RefundRecord = {
      id: generateUUID(),
      ...refund,
      reason: refund.reason?.trim(),
      reference: refund.reference?.trim(),
    };

    const newRefunds = [...this.refunds, newRefund];
    const newTotalRefunded = newRefunds.reduce((s, r) => s + r.amount, 0);
    const isNowFullyRefunded =
      Math.abs(newTotalRefunded - this.totalAmount) < 0.001;

    return this.rebuild({
      refunds: newRefunds,
      status: isNowFullyRefunded ? "refunded" : this.status,
    });
  }

  /**
   * Remove a specific refund entry by ID.
   * Only allowed if not yet fully refunded.
   */
  removeRefund(refundId: string): ExpenseRecord {
    if (this.status === "refunded") {
      throw new ExpenseRecordMutationError(
        `Cannot remove a refund from a fully refunded record (id: ${this.id}).`,
      );
    }
    if (!this.refunds.some((r) => r.id === refundId)) {
      throw new ExpenseRecordError(
        `Refund with id "${refundId}" not found`,
        "refundId",
      );
    }
    return this.rebuild({
      refunds: this.refunds.filter((r) => r.id !== refundId),
    });
  }

  // ==========================================================================
  // ── GETTERS ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  get isDraft(): boolean {
    return this.status === "draft";
  }

  get isApproved(): boolean {
    return this.status === "approved";
  }

  get isRefunded(): boolean {
    return this.status === "refunded";
  }

  get hasLineItems(): boolean {
    return (this.lineItems?.length ?? 0) > 0;
  }

  get hasBIR(): boolean {
    return this.bir !== undefined;
  }

  get documentTypeLabel(): string {
    return EXPENSE_DOCUMENT_TYPE_LABELS[this.documentType];
  }

  // ── Refund computations ───────────────────────────────────────────────────

  /** Sum of all recorded refund amounts */
  get totalRefundedAmount(): number {
    return this.refunds.reduce((s, r) => s + r.amount, 0);
  }

  /** Remaining amount that can still be refunded */
  get refundableAmount(): number {
    return Math.max(0, this.totalAmount - this.totalRefundedAmount);
  }

  /** True when all refunds together equal the full totalAmount */
  get isFullyRefunded(): boolean {
    return Math.abs(this.totalRefundedAmount - this.totalAmount) < 0.001;
  }

  /** True when some but not all of the expense has been refunded */
  get isPartiallyRefunded(): boolean {
    return this.totalRefundedAmount > 0.001 && !this.isFullyRefunded;
  }

  /**
   * Computed effective status — factors in refund state.
   * "partially-refunded" is derived, not persisted.
   */
  get effectiveStatus(): ExpenseRecordEffectiveStatus {
    if (this.status === "refunded") return "refunded";
    if (this.isPartiallyRefunded) return "partially-refunded";
    return this.status;
  }

  /** Net amount after subtracting all refunds */
  get netAmount(): number {
    return Math.max(0, this.totalAmount - this.totalRefundedAmount);
  }

  // ── BIR computed helpers ─────────────────────────────────────────────────

  /**
   * Resolved input VAT amount.
   * Returns bir.inputVatAmount if explicitly set, otherwise
   * auto-computes as totalAmount × bir.inputVatRate.
   */
  get resolvedInputVatAmount(): number {
    if (!this.bir) return 0;
    if (this.bir.inputVatAmount !== undefined) return this.bir.inputVatAmount;
    if (this.bir.inputVatRate !== undefined) {
      return this.totalAmount * this.bir.inputVatRate;
    }
    return 0;
  }

  /**
   * Amount exclusive of input VAT.
   * Only meaningful when bir.vatClassification is "creditable".
   */
  get amountExclusiveOfVat(): number {
    return this.totalAmount - this.resolvedInputVatAmount;
  }

  // ==========================================================================
  // ── VALIDATION ─────────────────────────────────────────────────────────────
  // ==========================================================================

  static validate(input: ExpenseRecordInput): ExpenseRecordValidationResult {
    const errors: Array<{ field: string; message: string }> = [];

    if (!input.documentType) {
      errors.push({
        field: "documentType",
        message: "Document type is required",
      });
    }
    if (!input.description?.trim()) {
      errors.push({ field: "description", message: "Description is required" });
    }
    if (!input.payee) {
      errors.push({ field: "payee", message: "Payee is required" });
    } else if (!input.payee.legalName?.trim()) {
      errors.push({
        field: "payee.legalName",
        message: "Payee legal name is required",
      });
    }
    if (!input.paidBy) {
      errors.push({ field: "paidBy", message: "PaidBy is required" });
    } else if (!input.paidBy.legalName?.trim()) {
      errors.push({
        field: "paidBy.legalName",
        message: "PaidBy legal name is required",
      });
    }
    if (!input.currency?.trim()) {
      errors.push({ field: "currency", message: "Currency is required" });
    } else if (!/^[A-Z]{3}$/.test(input.currency)) {
      errors.push({
        field: "currency",
        message: "Currency must be a valid ISO 4217 code (e.g. PHP, USD)",
      });
    }

    const hasLineItems = input.lineItems && input.lineItems.length > 0;
    const hasTotal =
      typeof input.totalAmount === "number" && input.totalAmount > 0;

    if (!hasLineItems && !hasTotal) {
      errors.push({
        field: "totalAmount",
        message:
          "Either totalAmount or at least one line item must be provided",
      });
    }
    if (hasTotal && !hasLineItems && input.totalAmount! <= 0) {
      errors.push({
        field: "totalAmount",
        message: "totalAmount must be greater than 0",
      });
    }
    if (input.expenseDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate)) {
      errors.push({
        field: "expenseDate",
        message: "expenseDate must be in YYYY-MM-DD format",
      });
    }
    if (input.paidAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.paidAt)) {
      errors.push({
        field: "paidAt",
        message: "paidAt must be in YYYY-MM-DD format",
      });
    }
    if (input.period) {
      if (!input.period.start || !input.period.end) {
        errors.push({
          field: "period",
          message: "Period must have both start and end dates",
        });
      } else if (input.period.end < input.period.start) {
        errors.push({
          field: "period",
          message: "Period end date cannot be before start date",
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  static assertValid(input: ExpenseRecordInput): void {
    const result = ExpenseRecord.validate(input);
    if (!result.valid) {
      const messages = result.errors.map((e) => `${e.field}: ${e.message}`);
      throw new ExpenseRecordError(
        `ExpenseRecord validation failed:\n${messages.join("\n")}`,
      );
    }
  }

  // ==========================================================================
  // ── SERIALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  toJSON(): ExpenseRecordJSON {
    return {
      version: this.version,
      id: this.id,
      account_id: this.accountId ?? null,
      recurring_id: this.recurringId,
      document_type: this.documentType,
      category: this.category,
      description: this.description,
      payee: this.payee,
      paid_by: this.paidBy,
      currency: this.currency,
      total_amount: this.totalAmount,
      line_items: this.lineItems ? [...this.lineItems] : undefined,
      expense_date: this.expenseDate,
      paid_at: this.paidAt,
      status: this.status,
      refunds: [...this.refunds],
      bir: this.bir ? { ...this.bir } : undefined,
      payment_terms: this.paymentTerms,
      period: this.period,
      references: this.references ? [...this.references] : undefined,
      notes: this.notes,
      tags: this.tags ? [...this.tags] : undefined,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  static fromJSON(json: ExpenseRecordJSON): ExpenseRecord {
    return new ExpenseRecord({
      id: json.id,
      accountId: json?.account_id,
      recurringId: json.recurring_id,
      documentType: json.document_type,
      category: json.category ?? "other",
      description: json.description,
      payee: json.payee,
      paidBy: json.paid_by,
      currency: json.currency,
      totalAmount: json.total_amount,
      lineItems: json.line_items ? [...json.line_items] : undefined,
      expenseDate: json.expense_date,
      paidAt: json.paid_at,
      status: json.status,
      refunds: json.refunds ? [...json.refunds] : [],
      bir: json.bir ? { ...json.bir } : undefined,
      paymentTerms: json.payment_terms,
      period: json.period,
      references: json.references ? [...json.references] : undefined,
      notes: json.notes,
      tags: json.tags ? [...json.tags] : undefined,
      metadata: json.metadata ? { ...json.metadata } : undefined,
      createdAt: json.created_at,
      updatedAt: json.updated_at,
    });
  }
}
