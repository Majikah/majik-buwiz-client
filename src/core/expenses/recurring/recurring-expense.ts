/**
 * @file recurring-expense-item.ts
 * @description RecurringExpenseItem — an immutable recurring expense template.
 *
 * A RecurringExpenseItem is never an ExpenseRecord by itself. It is a template
 * that describes a recurring financial obligation. Calling toRecord(month, options)
 * materializes it into a draft ExpenseRecord for a specific actualization month.
 *
 * The caller is responsible for:
 *   1. Passing the returned ExpenseRecord to ExpenseManager.save()
 *   2. Logging the actualization via RecurringExpenseManager (which handles both)
 *
 * Status lifecycle:
 *   active ⟷ paused  (reversible)
 *   active → ended   (terminal)
 *   paused → ended   (terminal)
 *
 * An item whose schedule.endDate has passed is considered naturally ended.
 * The manager auto-transitions these on hydration.
 *
 * Line items:
 *   When lineItems are provided, amount is derived from their computed grand total
 *   (via ExpenseRecord._computeTotalFromLineItems). When absent, a single synthetic
 *   line item is created at materialization time using the item's name and amount.
 *   BIR auto-computation is fully delegated to ExpenseRecord.create() — no logic
 *   duplication here.
 */

import { generateUUID } from "../../utils/utilities";
import { ExpenseRecord } from "../expense-record";
import {
  BIRContext,
  ExpenseCategory,
  ExpenseDocumentType,
  ExpenseRecordInput,
} from "../types";
import { RECURRING_EXPENSE_ITEM_ALLOWED_TRANSITIONS } from "./constants";
import {
  RecurringExpenseItemError,
  RecurringExpenseItemLifecycleError,
} from "./errors";
import {
  type ActualizationMonth,
  type ActualizeOptions,
  type RecurrenceAnchor,
  type RecurrenceFrequency,
  type RecurrenceSchedule,
  type RecurringExpenseItemInput,
  type RecurringExpenseItemInternalState,
  type RecurringExpenseItemJSON,
  type RecurringExpenseItemStatus,
} from "./types";

import type {
  Party,
  PaymentTerms,
  CurrencyCode,
  ISODateString,
  LineItemInput,
  TaxDetail,
} from "@majikah/majik-invoice";

const RECURRING_EXPENSE_ITEM_SCHEMA_VERSION = "1.0.0";

// =============================================================================
// ── RecurringExpenseItem ──────────────────────────────────────────────────────
// =============================================================================

export class RecurringExpenseItem {
  // ── Schema ────────────────────────────────────────────────────────────────
  readonly version: string;

  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;
  readonly name: string;
  readonly description: string;

  readonly accountId?: string | null;

  readonly category: ExpenseCategory = "other";

  // ── Parties ───────────────────────────────────────────────────────────────
  readonly payee: Party;
  readonly paidBy: Party;

  // ── Financials ────────────────────────────────────────────────────────────
  readonly currency: CurrencyCode;
  /**
   * Gross amount per occurrence.
   * When lineItems are present this is the computed grand total from them.
   * When absent it is the explicit amount provided at creation.
   */
  readonly amount: number;
  readonly documentType: ExpenseDocumentType;

  /**
   * Optional itemized line items — reuses GeneralInvoice's LineItemInput shape.
   * When present, amount is derived from line item grand totals.
   * When absent, a single synthetic line item is created in toRecord().
   */
  readonly lineItems?: readonly LineItemInput[];

  // ── Schedule ──────────────────────────────────────────────────────────────
  readonly schedule: RecurrenceSchedule;

  // ── Status ────────────────────────────────────────────────────────────────
  readonly status: RecurringExpenseItemStatus;

  // ── BIR & supplementary ───────────────────────────────────────────────────
  /**
   * Optional default BIR context.
   * When lineItems are present, BIR is fully (re)computed inside
   * ExpenseRecord.create() on each toRecord() call. The item-level bir
   * acts as a base that can be overridden per-actualization.
   */
  readonly bir?: BIRContext;
  readonly paymentTerms?: PaymentTerms;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;

  // ── Timestamps ────────────────────────────────────────────────────────────
  readonly createdAt: string;
  readonly updatedAt: string;

  // ── Private constructor ───────────────────────────────────────────────────

  private constructor(state: RecurringExpenseItemInternalState) {
    this.version = RECURRING_EXPENSE_ITEM_SCHEMA_VERSION;
    this.id = state.id;
    this.accountId = state.accountId;
    this.name = state.name;
    this.category = state.category;
    this.description = state.description;
    this.payee = state.payee;
    this.paidBy = state.paidBy;
    this.currency = state.currency;
    this.amount = state.amount;
    this.documentType = state.documentType;
    this.lineItems = state.lineItems
      ? Object.freeze([...state.lineItems])
      : undefined;
    this.schedule = { ...state.schedule, anchor: { ...state.schedule.anchor } };
    this.status = state.status;
    this.bir = state.bir ? { ...state.bir } : undefined;
    this.paymentTerms = state.paymentTerms;
    this.tags = state.tags ? [...state.tags] : undefined;
    this.metadata = state.metadata ? { ...state.metadata } : undefined;
    this.createdAt = state.createdAt;
    this.updatedAt = state.updatedAt;
  }

  // ── Internal rebuild ──────────────────────────────────────────────────────

  private rebuild(
    overrides: Partial<RecurringExpenseItemInternalState>,
  ): RecurringExpenseItem {
    const hasLineItemsOverride = Object.prototype.hasOwnProperty.call(
      overrides,
      "lineItems",
    );
    const hasAmountOverride = Object.prototype.hasOwnProperty.call(
      overrides,
      "amount",
    );

    const resultingLineItems = hasLineItemsOverride
      ? overrides.lineItems
        ? [...overrides.lineItems]
        : undefined
      : this.lineItems
        ? [...this.lineItems]
        : undefined;

    const resultingCurrency = overrides.currency ?? this.currency;

    // If line items are present, always derive amount from them.
    // If an explicit amount override is provided without line items, use it.
    // Otherwise fall back to current amount.
    const resultingAmount =
      resultingLineItems && resultingLineItems.length > 0
        ? ExpenseRecord._computeTotalFromLineItems(
            resultingLineItems,
            resultingCurrency,
          )
        : hasAmountOverride && typeof overrides.amount === "number"
          ? overrides.amount
          : this.amount;

    return new RecurringExpenseItem({
      id: this.id,
      accountId: this.accountId,
      name: this.name,
      description: this.description,
      category: this.category,
      payee: this.payee,
      paidBy: this.paidBy,
      documentType: this.documentType,
      schedule: { ...this.schedule, anchor: { ...this.schedule.anchor } },
      status: this.status,
      bir: this.bir ? { ...this.bir } : undefined,
      paymentTerms: this.paymentTerms,
      tags: this.tags ? [...this.tags] : undefined,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      ...overrides,
      // Always use the resolved values for these two — overrides above may
      // have set lineItems/currency but the derived amount must win.
      lineItems: resultingLineItems,
      amount: resultingAmount,
      currency: resultingCurrency,
    });
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  private assertNotEnded(operation: string): void {
    if (this.status === "ended") {
      throw new RecurringExpenseItemError(
        `Cannot ${operation} on an ended recurring expense item (id: ${this.id}). ` +
          `Ended items are immutable.`,
      );
    }
  }

  // ── Static factory ────────────────────────────────────────────────────────

  static create(input: RecurringExpenseItemInput): RecurringExpenseItem {
    RecurringExpenseItem.assertValid(input);

    const now = new Date().toISOString();

    const defaultDescription = `${input.name} — ${input.schedule.anchor.frequency.toUpperCase()}`;

    // ── Resolve amount and line items ─────────────────────────────────────
    let resolvedAmount: number;
    let resolvedLineItems: LineItemInput[] | undefined;

    if (input.lineItems && input.lineItems.length > 0) {
      resolvedLineItems = [...input.lineItems];
      resolvedAmount = ExpenseRecord._computeTotalFromLineItems(
        resolvedLineItems,
        input.currency,
      );
    } else {
      resolvedLineItems = undefined;
      resolvedAmount = input.amount;
    }

    return new RecurringExpenseItem({
      id: input.id ?? generateUUID(),
      accountId: input.accountId ?? null,
      name: input.name.trim(),
      description: !!input.description?.trim()
        ? input.description.trim()
        : defaultDescription,
      category: input.category ?? "other",
      payee: input.payee,
      paidBy: input.paidBy,
      currency: input.currency,
      amount: resolvedAmount,
      lineItems: resolvedLineItems,
      documentType: input.documentType,
      schedule: {
        anchor: { ...input.schedule.anchor },
        startDate: input.schedule.startDate,
        endDate: input.schedule.endDate,
      },
      status: input.status ?? "active",
      bir: input.bir ? { ...input.bir } : undefined,
      paymentTerms: input.paymentTerms,
      tags: input.tags
        ? [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))]
        : undefined,
      metadata: input.metadata ? { ...input.metadata } : undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ==========================================================================
  // ── toRecord — core materialization ────────────────────────────────────────
  // ==========================================================================

  /**
   * Materialize this template into a draft ExpenseRecord for a specific month.
   *
   * Does NOT save the record or log the actualization — that is the
   * responsibility of RecurringExpenseManager.actualize().
   *
   * Line item resolution:
   *   - When lineItems are stored on the template, they are passed through
   *     directly. BIR auto-computation then happens inside ExpenseRecord.create()
   *     from the line items — no duplication of logic here.
   *   - When no lineItems are stored, a single synthetic line item is created
   *     from the item's name and amount so that all produced ExpenseRecords
   *     are consistently itemized and BIR-ready.
   *
   * The {month} placeholder in description is substituted with the
   * actualization month string (e.g. "Office Rent — {month}" → "Office Rent — 2025-06").
   *
   * @param month   - Target month in YYYY-MM format
   * @param options - Per-call overrides (BIR, tags, metadata, expenseDate)
   *
   * @throws {RecurringExpenseItemError} if the item is not active
   * @throws {RecurringExpenseItemError} if the month is before schedule.startDate
   * @throws {RecurringExpenseItemError} if the month is after schedule.endDate
   */
  toRecord(
    month: ActualizationMonth,
    options: Pick<
      ActualizeOptions,
      "bir" | "tags" | "metadata" | "expenseDate"
    > = {},
  ): ExpenseRecord {
    RecurringExpenseItem.assertValidMonth(month);

    if (this.status !== "active") {
      throw new RecurringExpenseItemError(
        `Cannot actualize recurring item "${this.id}" — status is "${this.status}". ` +
          `Only active items can be actualized.`,
      );
    }

    // ── Date boundary checks ─────────────────────────────────────────────
    const monthStart = `${month}-01`;
    if (monthStart < this.schedule.startDate) {
      throw new RecurringExpenseItemError(
        `Cannot actualize "${this.id}" for month "${month}" — ` +
          `it is before the schedule start date "${this.schedule.startDate}".`,
      );
    }
    if (this.schedule.endDate && monthStart > this.schedule.endDate) {
      throw new RecurringExpenseItemError(
        `Cannot actualize "${this.id}" for month "${month}" — ` +
          `it is after the schedule end date "${this.schedule.endDate}".`,
      );
    }

    // ── Resolve expense date ──────────────────────────────────────────────
    const expenseDate =
      options.expenseDate ??
      RecurringExpenseItem._resolveExpenseDate(this.schedule.anchor, month);

    // ── Resolve description with {month} substitution ─────────────────────
    const description = this.description.replace(/\{month\}/gi, month);

    // ── Resolve BIR context ───────────────────────────────────────────────
    // Options BIR overrides item-level BIR field-by-field.
    // When lineItems are present, ExpenseRecord.create() will re-derive VAT
    // fields from the line items automatically — the merged bir here acts as
    // a base for non-VAT fields (purchaseType, withholdingAtcCode, etc.).
    const bir: BIRContext | undefined =
      this.bir || options.bir
        ? { ...(this.bir ?? {}), ...(options.bir ?? {}) }
        : undefined;

    // ── Merge tags ────────────────────────────────────────────────────────
    const mergedTags =
      this.tags?.length || options.tags?.length
        ? [...new Set([...(this.tags ?? []), ...(options.tags ?? [])])]
        : undefined;

    // ── Merge metadata ────────────────────────────────────────────────────
    const mergedMetadata: Record<string, unknown> = {
      recurringExpenseItemId: this.id,
      actualizationMonth: month,
      ...(this.metadata ?? {}),
      ...(options.metadata ?? {}),
    };

    // ── Resolve line items ────────────────────────────────────────────────
    // When line items are stored on the template, pass them through verbatim
    // so ExpenseRecord.create() can derive totalAmount and BIR VAT context
    // from them. When absent, synthesize a single line item from name + amount
    // so every produced ExpenseRecord is consistently itemized.
    const lineItems: LineItemInput[] = this.lineItems
      ? [...this.lineItems]
      : [
          {
            id: generateUUID(),
            description: description,
            quantity: 1,
            unitPrice: this.amount,
            taxes: [],
          },
        ];

    const recordInput: ExpenseRecordInput = {
      category: this.category,
      documentType: this.documentType,
      description,
      payee: this.payee,
      paidBy: this.paidBy,
      currency: this.currency,
      // totalAmount is intentionally omitted — ExpenseRecord.create() will
      // derive it from lineItems, keeping the two in sync.
      lineItems,
      expenseDate,
      status: "draft",
      bir,
      paymentTerms: this.paymentTerms,
      tags: mergedTags,
      metadata: mergedMetadata,
      recurringId: this.id,
      accountId: this.accountId ?? undefined,
    };

    return ExpenseRecord.create(recordInput);
  }

  // ==========================================================================
  // ── WITH* MUTATION METHODS ─────────────────────────────────────────────────
  // ==========================================================================

  // ── Status ────────────────────────────────────────────────────────────────

  withStatus(
    status: RecurringExpenseItemStatus,
    force = false,
  ): RecurringExpenseItem {
    if (this.status === status) return this;

    const allowed = RECURRING_EXPENSE_ITEM_ALLOWED_TRANSITIONS[this.status];
    if (!allowed.includes(status) && !force) {
      throw new RecurringExpenseItemLifecycleError(
        `Invalid status transition: "${this.status}" → "${status}". ` +
          `Allowed from "${this.status}": [${allowed.join(", ") || "none"}].`,
        this.status,
        status,
      );
    }
    return this.rebuild({ status });
  }

  pause(): RecurringExpenseItem {
    return this.withStatus("paused");
  }

  resume(): RecurringExpenseItem {
    return this.withStatus("active");
  }

  end(): RecurringExpenseItem {
    return this.withStatus("ended");
  }

  // ── Core fields ───────────────────────────────────────────────────────────

  withName(name: string): RecurringExpenseItem {
    this.assertNotEnded("set name");
    if (!name?.trim()) {
      throw new RecurringExpenseItemError("Name cannot be empty", "name");
    }
    return this.rebuild({ name: name.trim() });
  }

  withDescription(description: string): RecurringExpenseItem {
    this.assertNotEnded("set description");
    if (!description?.trim()) {
      throw new RecurringExpenseItemError(
        "Description cannot be empty",
        "description",
      );
    }
    return this.rebuild({ description: description.trim() });
  }

  /**
   * Update the per-occurrence amount on a single-amount item (no line items).
   * @throws if the item has line items — update them via withLineItems() instead.
   */
  withAmount(amount: number): RecurringExpenseItem {
    this.assertNotEnded("set amount");
    if (this.lineItems && this.lineItems.length > 0) {
      throw new RecurringExpenseItemError(
        `Cannot set amount directly on an item with line items. ` +
          `Update the line items via withLineItems() instead.`,
        "amount",
      );
    }
    if (typeof amount !== "number" || amount <= 0) {
      throw new RecurringExpenseItemError(
        "Amount must be a positive number",
        "amount",
      );
    }
    return this.rebuild({ amount });
  }

  withCategory(category: ExpenseCategory): RecurringExpenseItem {
    this.assertNotEnded("set category");
    if (!category) {
      throw new RecurringExpenseItemError("Category is required", "category");
    }
    return this.rebuild({ category });
  }

  withCurrency(currency: CurrencyCode): RecurringExpenseItem {
    this.assertNotEnded("set currency");
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new RecurringExpenseItemError(
        "Currency must be a valid ISO 4217 code",
        "currency",
      );
    }
    // If line items exist, amount is recomputed by rebuild()
    return this.rebuild({ currency });
  }

  withDocumentType(documentType: ExpenseDocumentType): RecurringExpenseItem {
    this.assertNotEnded("set document type");
    return this.rebuild({ documentType });
  }

  // ── Line items ────────────────────────────────────────────────────────────

  /**
   * Replace all line items. amount is recomputed from the new set.
   * BIR VAT context will be re-derived on the next toRecord() call
   * inside ExpenseRecord.create().
   */
  withLineItems(lineItems: LineItemInput[]): RecurringExpenseItem {
    this.assertNotEnded("replace line items");
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      throw new RecurringExpenseItemError(
        "At least one line item is required",
        "lineItems",
      );
    }
    return this.rebuild({ lineItems: [...lineItems] });
  }

  /**
   * Remove all line items, converting to a single-amount template.
   * The current computed amount is preserved as the explicit amount.
   */
  withoutLineItems(): RecurringExpenseItem {
    this.assertNotEnded("remove line items");
    return this.rebuild({ lineItems: undefined });
  }

  /**
   * Replace the taxes on a single line item identified by its id.
   * @throws {RecurringExpenseItemError} if no line item with the given id exists
   */
  withLineItemTaxes(
    lineItemId: string,
    taxes: TaxDetail[],
  ): RecurringExpenseItem {
    this.assertNotEnded("update line item taxes");
    const items = this.lineItems ? [...this.lineItems] : [];
    const idx = items.findIndex((li) => li.id === lineItemId);
    if (idx === -1) {
      throw new RecurringExpenseItemError(
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
   * Copy the tax configuration from one line item onto all others.
   * @param sourceLineItemId  ID of the line item whose taxes will be broadcast.
   */
  withUniformTaxes(sourceLineItemId: string): RecurringExpenseItem {
    this.assertNotEnded("apply uniform taxes");
    if (!this.lineItems || this.lineItems.length === 0) return this;

    const source = this.lineItems.find((li) => li.id === sourceLineItemId);
    if (!source) {
      throw new RecurringExpenseItemError(
        `No line item with id "${sourceLineItemId}" found`,
        "sourceLineItemId",
      );
    }

    const taxes: TaxDetail[] = source.taxes
      ? [...(source.taxes as TaxDetail[])]
      : [];
    const updated = this.lineItems.map((li) => ({ ...li, taxes: [...taxes] }));
    return this.rebuild({ lineItems: updated });
  }

  /**
   * Apply an explicit TaxDetail array to every line item at once.
   */
  withAllLineItemTaxes(taxes: TaxDetail[]): RecurringExpenseItem {
    this.assertNotEnded("apply taxes to all line items");
    if (!this.lineItems || this.lineItems.length === 0) return this;
    const updated = this.lineItems.map((li) => ({ ...li, taxes: [...taxes] }));
    return this.rebuild({ lineItems: updated });
  }

  // ── Parties ───────────────────────────────────────────────────────────────

  withPayee(payee: Party): RecurringExpenseItem {
    this.assertNotEnded("set payee");
    if (!payee?.legalName?.trim()) {
      throw new RecurringExpenseItemError(
        "Payee must have a legalName",
        "payee.legalName",
      );
    }
    return this.rebuild({ payee });
  }

  withPaidBy(paidBy: Party): RecurringExpenseItem {
    this.assertNotEnded("set paidBy");
    if (!paidBy?.legalName?.trim()) {
      throw new RecurringExpenseItemError(
        "PaidBy must have a legalName",
        "paidBy.legalName",
      );
    }
    return this.rebuild({ paidBy });
  }

  // ── Schedule ──────────────────────────────────────────────────────────────

  withSchedule(schedule: RecurrenceSchedule): RecurringExpenseItem {
    this.assertNotEnded("set schedule");
    RecurringExpenseItem.assertValidSchedule(schedule);
    return this.rebuild({
      schedule: { ...schedule, anchor: { ...schedule.anchor } },
    });
  }

  /**
   * Set or update the end date on the schedule.
   * Useful when a lease or contract is extended or shortened.
   */
  withEndDate(endDate: ISODateString): RecurringExpenseItem {
    this.assertNotEnded("set end date");
    if (endDate < this.schedule.startDate) {
      throw new RecurringExpenseItemError(
        `endDate (${endDate}) cannot be before startDate (${this.schedule.startDate})`,
        "schedule.endDate",
      );
    }
    return this.rebuild({
      schedule: { ...this.schedule, endDate },
    });
  }

  withoutEndDate(): RecurringExpenseItem {
    this.assertNotEnded("remove end date");
    const { endDate: _removed, ...rest } = this.schedule;
    return this.rebuild({
      schedule: { ...rest, anchor: { ...this.schedule.anchor } },
    });
  }

  // ── BIR ───────────────────────────────────────────────────────────────────

  withBIR(bir: BIRContext): RecurringExpenseItem {
    this.assertNotEnded("set BIR context");
    return this.rebuild({ bir: { ...bir } });
  }

  withBIRPatch(patch: Partial<BIRContext>): RecurringExpenseItem {
    this.assertNotEnded("patch BIR context");
    return this.rebuild({ bir: { ...(this.bir ?? {}), ...patch } });
  }

  withoutBIR(): RecurringExpenseItem {
    this.assertNotEnded("remove BIR context");
    return this.rebuild({ bir: undefined });
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  withTags(tags: string[]): RecurringExpenseItem {
    this.assertNotEnded("set tags");
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    return this.rebuild({ tags: cleaned });
  }

  withTag(tag: string): RecurringExpenseItem {
    this.assertNotEnded("add tag");
    if (!tag?.trim()) {
      throw new RecurringExpenseItemError("Tag cannot be empty", "tag");
    }
    const trimmed = tag.trim();
    if ((this.tags ?? []).includes(trimmed)) return this;
    return this.rebuild({ tags: [...(this.tags ?? []), trimmed] });
  }

  withoutTag(tag: string): RecurringExpenseItem {
    this.assertNotEnded("remove tag");
    return this.rebuild({
      tags: (this.tags ?? []).filter((t) => t !== tag.trim()),
    });
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  withMetadata(patch: Record<string, unknown>): RecurringExpenseItem {
    this.assertNotEnded("update metadata");
    const merged: Record<string, unknown> = { ...(this.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return this.rebuild({ metadata: merged });
  }

  withoutMetadata(): RecurringExpenseItem {
    this.assertNotEnded("clear metadata");
    return this.rebuild({ metadata: undefined });
  }

  withPaymentTerms(terms: PaymentTerms): RecurringExpenseItem {
    this.assertNotEnded("set payment terms");
    return this.rebuild({ paymentTerms: terms });
  }

  // ==========================================================================
  // ── GETTERS ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  get isActive(): boolean {
    return this.status === "active";
  }

  get isPaused(): boolean {
    return this.status === "paused";
  }

  get isEnded(): boolean {
    return this.status === "ended";
  }

  get frequency(): RecurrenceFrequency {
    return this.schedule.anchor.frequency;
  }

  get hasLineItems(): boolean {
    return (this.lineItems?.length ?? 0) > 0;
  }

  /**
   * True when today's date is past the schedule endDate.
   * Note: this is a pure date comparison — it does NOT auto-mutate status.
   * RecurringExpenseManager.hydrate() handles auto-transitioning ended items.
   */
  get isExpired(): boolean {
    if (!this.schedule.endDate) return false;
    return new Date().toISOString().slice(0, 10) > this.schedule.endDate;
  }

  /**
   * True when the item has a defined end date (contract/lease-bound).
   */
  get hasDuration(): boolean {
    return this.schedule.endDate !== undefined;
  }

  /**
   * The next ISO date this item would fire, relative to today.
   * Returns undefined if the item is ended, paused, or expired.
   */
  get nextOccurrenceDate(): ISODateString | undefined {
    if (this.status !== "active" || this.isExpired) return undefined;
    const today = new Date().toISOString().slice(0, 10);
    return RecurringExpenseItem._nextOccurrenceAfter(
      this.schedule.anchor,
      today,
      this.schedule.startDate,
      this.schedule.endDate,
    );
  }

  // ==========================================================================
  // ── SERIALIZATION ──────────────────────────────────────────────────────────
  // ==========================================================================

  toJSON(): RecurringExpenseItemJSON {
    return {
      version: this.version,
      id: this.id,
      account_id: this.accountId || null,
      name: this.name,
      description: this.description,
      category: this.category,
      payee: this.payee,
      paid_by: this.paidBy,
      currency: this.currency,
      amount: this.amount,
      line_items: this.lineItems ? [...this.lineItems] : undefined,
      document_type: this.documentType,
      schedule: { ...this.schedule, anchor: { ...this.schedule.anchor } },
      status: this.status,
      bir: this.bir ? { ...this.bir } : undefined,
      payment_terms: this.paymentTerms,
      tags: this.tags ? [...this.tags] : undefined,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  static fromJSON(json: RecurringExpenseItemJSON): RecurringExpenseItem {
    return new RecurringExpenseItem({
      id: json.id,
      accountId: json?.account_id ?? undefined,
      name: json.name,
      description: json.description,
      category: json.category,
      payee: json.payee,
      paidBy: json.paid_by,
      currency: json.currency,
      amount: json.amount,
      lineItems: json.line_items ? [...json.line_items] : undefined,
      documentType: json.document_type,
      schedule: { ...json.schedule, anchor: { ...json.schedule.anchor } },
      status: json.status,
      bir: json.bir ? { ...json.bir } : undefined,
      paymentTerms: json.payment_terms,
      tags: json.tags ? [...json.tags] : undefined,
      metadata: json.metadata ? { ...json.metadata } : undefined,
      createdAt: json.created_at,
      updatedAt: json.updated_at,
    });
  }

  // ==========================================================================
  // ── VALIDATION ─────────────────────────────────────────────────────────────
  // ==========================================================================

  static assertValid(input: RecurringExpenseItemInput): void {
    if (!input.name?.trim()) {
      throw new RecurringExpenseItemError("Name is required", "name");
    }
    if (!input.payee?.legalName?.trim()) {
      throw new RecurringExpenseItemError(
        "Payee legalName is required",
        "payee.legalName",
      );
    }
    if (!input.paidBy?.legalName?.trim()) {
      throw new RecurringExpenseItemError(
        "PaidBy legalName is required",
        "paidBy.legalName",
      );
    }
    if (!input.currency || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new RecurringExpenseItemError(
        "Currency must be a valid ISO 4217 code",
        "currency",
      );
    }
    // When line items are provided, amount is derived — skip the explicit check.
    // When absent, amount must be a positive number.
    const hasLineItems = input.lineItems && input.lineItems.length > 0;
    if (!hasLineItems) {
      if (typeof input.amount !== "number" || input.amount <= 0) {
        throw new RecurringExpenseItemError(
          "Amount must be a positive number (or provide lineItems)",
          "amount",
        );
      }
    }
    if (!input.documentType) {
      throw new RecurringExpenseItemError(
        "Document type is required",
        "documentType",
      );
    }
    if (!input.schedule) {
      throw new RecurringExpenseItemError("Schedule is required", "schedule");
    }
    RecurringExpenseItem.assertValidSchedule(input.schedule);
  }

  static assertValidSchedule(schedule: RecurrenceSchedule): void {
    if (!schedule.anchor) {
      throw new RecurringExpenseItemError(
        "Schedule anchor is required",
        "schedule.anchor",
      );
    }
    if (
      !schedule.startDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(schedule.startDate)
    ) {
      throw new RecurringExpenseItemError(
        "schedule.startDate must be in YYYY-MM-DD format",
        "schedule.startDate",
      );
    }
    if (schedule.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(schedule.endDate)) {
      throw new RecurringExpenseItemError(
        "schedule.endDate must be in YYYY-MM-DD format",
        "schedule.endDate",
      );
    }
    if (schedule.endDate && schedule.endDate < schedule.startDate) {
      throw new RecurringExpenseItemError(
        `schedule.endDate (${schedule.endDate}) cannot be before startDate (${schedule.startDate})`,
        "schedule.endDate",
      );
    }

    const anchor = schedule.anchor;
    switch (anchor.frequency) {
      case "weekly":
        if (anchor.dayOfWeek < 0 || anchor.dayOfWeek > 6) {
          throw new RecurringExpenseItemError(
            "dayOfWeek must be 0–6",
            "schedule.anchor.dayOfWeek",
          );
        }
        break;
      case "monthly":
        if (anchor.dayOfMonth < 1 || anchor.dayOfMonth > 28) {
          throw new RecurringExpenseItemError(
            "dayOfMonth must be 1–28",
            "schedule.anchor.dayOfMonth",
          );
        }
        break;
      case "quarterly":
        if (anchor.monthOfQuarter < 1 || anchor.monthOfQuarter > 3) {
          throw new RecurringExpenseItemError(
            "monthOfQuarter must be 1–3",
            "schedule.anchor.monthOfQuarter",
          );
        }
        if (anchor.dayOfMonth < 1 || anchor.dayOfMonth > 28) {
          throw new RecurringExpenseItemError(
            "dayOfMonth must be 1–28",
            "schedule.anchor.dayOfMonth",
          );
        }
        break;
      case "semi-annual":
        if (anchor.monthOfHalf < 1 || anchor.monthOfHalf > 6) {
          throw new RecurringExpenseItemError(
            "monthOfHalf must be 1–6",
            "schedule.anchor.monthOfHalf",
          );
        }
        if (anchor.dayOfMonth < 1 || anchor.dayOfMonth > 28) {
          throw new RecurringExpenseItemError(
            "dayOfMonth must be 1–28",
            "schedule.anchor.dayOfMonth",
          );
        }
        break;
      case "annual":
        if (anchor.month < 1 || anchor.month > 12) {
          throw new RecurringExpenseItemError(
            "month must be 1–12",
            "schedule.anchor.month",
          );
        }
        if (anchor.dayOfMonth < 1 || anchor.dayOfMonth > 28) {
          throw new RecurringExpenseItemError(
            "dayOfMonth must be 1–28",
            "schedule.anchor.dayOfMonth",
          );
        }
        break;
    }
  }

  static assertValidMonth(month: string): void {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new RecurringExpenseItemError(
        `Month must be in YYYY-MM format, got "${month}"`,
        "month",
      );
    }
  }

  // ==========================================================================
  // ── PRIVATE STATIC: ANCHOR RESOLUTION ─────────────────────────────────────
  // ==========================================================================

  /**
   * Resolve the concrete ISO expense date for a given anchor + month.
   *
   * For daily/weekly: returns the first matching day in the month.
   * For monthly: returns YYYY-MM-{dayOfMonth}.
   * For quarterly/semi-annual/annual: returns the anchor date if the month
   * matches the anchor cycle, otherwise the 1st of the month as fallback.
   */
  static _resolveExpenseDate(
    anchor: RecurrenceAnchor,
    month: ActualizationMonth,
  ): ISODateString {
    const [year, mon] = month.split("-").map(Number);

    switch (anchor.frequency) {
      case "daily":
        return `${month}-01`;

      case "weekly": {
        const firstOfMonth = new Date(year, mon - 1, 1);
        const diff = (anchor.dayOfWeek - firstOfMonth.getDay() + 7) % 7;
        const day = 1 + diff;
        return `${month}-${String(day).padStart(2, "0")}`;
      }

      case "monthly":
        return `${month}-${String(anchor.dayOfMonth).padStart(2, "0")}`;

      case "quarterly": {
        const quarterStartMonth = Math.floor((mon - 1) / 3) * 3 + 1;
        const targetCalendarMonth =
          quarterStartMonth + anchor.monthOfQuarter - 1;
        if (targetCalendarMonth !== mon) {
          return `${month}-01`;
        }
        return `${month}-${String(anchor.dayOfMonth).padStart(2, "0")}`;
      }

      case "semi-annual": {
        const halfStartMonth = mon <= 6 ? 1 : 7;
        const targetCalendarMonth = halfStartMonth + anchor.monthOfHalf - 1;
        if (targetCalendarMonth !== mon) {
          return `${month}-01`;
        }
        return `${month}-${String(anchor.dayOfMonth).padStart(2, "0")}`;
      }

      case "annual":
        if (anchor.month !== mon) {
          return `${month}-01`;
        }
        return `${month}-${String(anchor.dayOfMonth).padStart(2, "0")}`;

      default:
        return `${month}-01`;
    }
  }

  /**
   * Find the next ISO date this anchor would fire after a given date.
   * Used by the nextOccurrenceDate getter.
   */
  private static _nextOccurrenceAfter(
    anchor: RecurrenceAnchor,
    after: ISODateString,
    startDate: ISODateString,
    endDate?: ISODateString,
  ): ISODateString | undefined {
    const effectiveAfter = after < startDate ? startDate : after;
    const [y, m] = effectiveAfter.split("-").map(Number);

    for (let offset = 0; offset < 24; offset++) {
      const totalMonths = (y - 1) * 12 + m + offset;
      const year = Math.floor((totalMonths - 1) / 12) + 1;
      const month = ((totalMonths - 1) % 12) + 1;
      const monthStr = `${year}-${String(month).padStart(2, "0")}`;
      const candidate = RecurringExpenseItem._resolveExpenseDate(
        anchor,
        monthStr,
      );
      if (candidate > after) {
        if (endDate && candidate > endDate) return undefined;
        return candidate;
      }
    }

    return undefined;
  }

  // ── Public helper: enumerate months in a range eligible for this item ─────

  /**
   * Enumerate all YYYY-MM months within a range that are eligible for
   * actualization by this item (respects startDate, endDate, and frequency).
   *
   * Used internally by RecurringExpenseManager.actualize() with a range.
   */
  eligibleMonthsInRange(
    from: ActualizationMonth,
    to: ActualizationMonth,
  ): ActualizationMonth[] {
    const months: ActualizationMonth[] = [];

    const clampedFrom =
      from < this.schedule.startDate.slice(0, 7)
        ? this.schedule.startDate.slice(0, 7)
        : from;

    const clampedTo =
      this.schedule.endDate && to > this.schedule.endDate.slice(0, 7)
        ? this.schedule.endDate.slice(0, 7)
        : to;

    if (clampedFrom > clampedTo) return [];

    let current = clampedFrom;
    while (current <= clampedTo) {
      if (this._anchorFiresInMonth(current)) {
        months.push(current);
      }
      current = RecurringExpenseItem._offsetMonth(current, 1);
    }

    return months;
  }

  /**
   * Returns true if this item's anchor fires in the given month.
   */
  private _anchorFiresInMonth(month: ActualizationMonth): boolean {
    const anchor = this.schedule.anchor;
    const [, mon] = month.split("-").map(Number);

    switch (anchor.frequency) {
      case "daily":
      case "weekly":
      case "monthly":
        return true;

      case "quarterly":
        return ((mon - 1) % 3) + 1 === anchor.monthOfQuarter;

      case "semi-annual":
        return ((mon - 1) % 6) + 1 === anchor.monthOfHalf;

      case "annual":
        return mon === anchor.month;

      default:
        return false;
    }
  }

  private static _offsetMonth(
    month: ActualizationMonth,
    offset: number,
  ): ActualizationMonth {
    const [y, m] = month.split("-").map(Number);
    const total = (y - 1) * 12 + m + offset;
    const newYear = Math.floor((total - 1) / 12) + 1;
    const newMonth = ((total - 1) % 12) + 1;
    return `${newYear}-${String(newMonth).padStart(2, "0")}`;
  }
}
