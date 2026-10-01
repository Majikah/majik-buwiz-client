/**
 * @file base-adapter.ts
 * @description Three-layer foundation for all BIR tax form adapters.
 *
 * Layer 1 — ITaxFormAdapter<TContext, TOutput>
 *   Pure interface. TaxAccountant only ever interacts with this.
 *   Concrete adapters are never referenced directly by the orchestrator.
 *
 * Layer 2 — AbstractBaseTaxAdapter<TContext, TOutput>
 *   Abstract class implementing all shared boilerplate:
 *     - Stateful cache keyed by simple context hash
 *     - Auto-validation gate before compute()
 *     - fieldMap generation (only when options.includeFieldMap is true)
 *     - FilingSummary builder
 *     - computedAt timestamp stamping
 *     - FilingAdapterError throwing on validation failure
 *
 * Layer 3 — AdapterComputationHelpers
 *   Static pure utility methods shared across all period-based adapters.
 *   No state, no side effects — just math and aggregation.
 *
 * Dependencies:
 *   - ../bir-types.ts
 *   - ../filing-context.ts
 */

import { ExpenseRecord } from "../../expenses/expense-record";
import type {
  AdapterCapabilities,
  BaseFilingOutput,
  BaseFilingContext,
  CurrencyCode,
  FilingFrequency,
  FilingPeriod,
  FilingSummary,
  Form2307Certificate,
  PeriodFilingContext,
  ValidationIssue,
  ValidationResult,
  RawInvoiceSummary,
} from "../types/bir-types";
import { ResolvedInvoice } from "../types/invoice-types";

/**
 * @file base-adapter.ts
 * @description Three-layer foundation for all BIR tax form adapters.
 *
 * Layer 1 — ITaxFormAdapter<TContext, TOutput>
 *   Pure interface. TaxAccountant only ever interacts with this.
 *   Concrete adapters are never referenced directly by the orchestrator.
 *
 * Layer 2 — AbstractBaseTaxAdapter<TContext, TOutput>
 *   Abstract class implementing all shared boilerplate:
 *     - Stateful cache keyed by simple context hash
 *     - Auto-validation gate before compute()
 *     - fieldMap generation (only when options.includeFieldMap is true)
 *     - FilingSummary builder
 *     - computedAt timestamp stamping
 *     - FilingAdapterError throwing on validation failure
 *
 * Layer 3 — AdapterComputationHelpers
 *   Static pure utility methods shared across all period-based adapters.
 *   No state, no side effects — just math and aggregation.
 *
 * Dependencies:
 *   - ../bir-types.ts
 *   - ../filing-context.ts
 */

// =============================================================================
// ── LAYER 1: ITaxFormAdapter ───────────────────────────────────────────────────
// =============================================================================

/**
 * The core contract every BIR form adapter must satisfy.
 *
 * TContext — the filing context this adapter accepts.
 *   Must extend BaseFilingContext.
 *   Period adapters use PeriodFilingContext.
 *   Transaction adapters use TransactionFilingContext (future).
 *
 * TOutput — the typed output this adapter produces.
 *   Must extend BaseFilingOutput.
 *   Each form has its own output shape with BIR-specific fields.
 *
 * TaxAccountant holds an ITaxFormAdapter<any, any> reference — it never
 * imports or references concrete adapter classes directly.
 */
export interface ITaxFormAdapter<
  TContext extends BaseFilingContext,
  TOutput extends BaseFilingOutput,
> {
  // ── Identity ──────────────────────────────────────────────────────────────

  /** BIR form code — e.g. "1701Q", "2550M", "2551Q" */
  readonly formCode: string;

  /** Human-readable form title */
  readonly formTitle: string;

  /** How often this form must be filed */
  readonly filingFrequency: FilingFrequency;

  /** Self-describing capability flags used by TaxAccountant for pre-flight checks */
  readonly capabilities: AdapterCapabilities;

  // ── Core operations ───────────────────────────────────────────────────────

  /**
   * Validate the context for this adapter without computing the full output.
   * Returns a ValidationResult — never throws.
   *
   * Caches the result. Calling validate() then compute() does not
   * re-run validation inside compute() — the cache is reused.
   */
  validate(ctx: TContext): ValidationResult;

  /**
   * Compute the full filing output from the context.
   *
   * Auto-runs validate() first. If validation produces errors
   * and options.dryRun is not true, throws FilingAdapterError.
   *
   * Result is cached — calling compute() twice with the same context
   * (same period + same invoice count + same expense count) returns
   * the cached output without recomputation.
   *
   * @throws {FilingAdapterError} if validation fails and dryRun !== true
   */
  compute(ctx: TContext): TOutput;

  /**
   * Produce a human-readable summary of a completed output.
   * Used by dashboards, notifications, and filing chain displays.
   */
  summarize(output: TOutput): FilingSummary;

  /**
   * Clear the internal computation cache.
   * Call this when the same adapter instance is reused with
   * updated invoice data that has the same count as before.
   */
  clearCache(): void;
}

// =============================================================================
// ── FILING ADAPTER ERROR ──────────────────────────────────────────────────────
// =============================================================================

/**
 * Thrown by AbstractBaseTaxAdapter.compute() when validation errors
 * are found and options.dryRun is not true.
 *
 * Carries the full ValidationResult so callers can inspect every issue
 * without re-running validate().
 */
export class FilingAdapterError extends Error {
  readonly formCode: string;
  readonly validation: ValidationResult;

  constructor(formCode: string, message: string, validation: ValidationResult) {
    super(message);
    this.name = "FilingAdapterError";
    this.formCode = formCode;
    this.validation = validation;
  }
}

// =============================================================================
// ── LAYER 2: AbstractBaseTaxAdapter ───────────────────────────────────────────
// =============================================================================

/**
 * Abstract base class implementing all shared boilerplate.
 * Concrete adapters extend this and implement three abstract methods:
 *
 *   _validateContext(ctx)   — adapter-specific validation rules
 *   _computeOutput(ctx)     — the actual BIR computation
 *   _buildFieldMap(output)  — maps BIR item numbers to computed values
 *
 * Everything else — caching, auto-validation, fieldMap gating,
 * FilingSummary, computedAt stamping — is handled here.
 */
export abstract class AbstractBaseTaxAdapter<
  TContext extends BaseFilingContext,
  TOutput extends BaseFilingOutput,
> implements ITaxFormAdapter<TContext, TOutput> {
  // ── Abstract identity (concrete adapters declare these) ───────────────────

  abstract readonly formCode: string;
  abstract readonly formTitle: string;
  abstract readonly filingFrequency: FilingFrequency;
  abstract readonly capabilities: AdapterCapabilities;

  // ── Cache ─────────────────────────────────────────────────────────────────

  /**
   * Cache stores the last computed output per cache key.
   * Key: simple string hash of period + invoice/expense count.
   * See _cacheKey() for the exact derivation.
   */
  private _cache = new Map<string, TOutput>();

  /**
   * Separate cache for validation results — validate() is cached
   * independently so compute() can reuse it without re-running.
   */
  private _validationCache = new Map<string, ValidationResult>();

  // ── ITaxFormAdapter: validate ─────────────────────────────────────────────

  validate(ctx: TContext): ValidationResult {
    const key = this._cacheKey(ctx);

    // Return cached result if available
    const cached = this._validationCache.get(key);
    if (cached) return cached;

    // Base structural checks that apply to ALL adapters
    const baseIssues = this._runBaseValidation(ctx);

    // Adapter-specific validation — implemented by each concrete adapter
    const adapterIssues = this._validateContext(ctx);

    const allIssues: ValidationIssue[] = [...baseIssues, ...adapterIssues];
    const errors = allIssues.filter((i) => i.severity === "error");
    const warnings = allIssues.filter((i) => i.severity === "warning");

    const result: ValidationResult = {
      valid: errors.length === 0,
      issues: allIssues,
      errors,
      warnings,
    };

    this._validationCache.set(key, result);
    return result;
  }

  // ── ITaxFormAdapter: compute ───────────────────────────────────────────────

  compute(ctx: TContext): TOutput {
    const key = this._cacheKey(ctx);

    // Return cached output if available
    const cached = this._cache.get(key);
    if (cached) return cached;

    // ── Auto-validate first ────────────────────────────────────────────────
    const validation = this.validate(ctx);
    const dryRun = ctx.options?.dryRun ?? false;

    if (!validation.valid && !dryRun) {
      throw new FilingAdapterError(
        this.formCode,
        `[${this.formCode}] Computation aborted — ${validation.errors.length} validation error(s).\n` +
          validation.errors
            .map(
              (e) =>
                `  [${e.code}] ${e.field ? `${e.field}: ` : ""}${e.message}`,
            )
            .join("\n") +
          `\nPass options.dryRun: true in the filing context to compute anyway.`,
        validation,
      );
    }

    // ── Run the adapter-specific computation ──────────────────────────────
    // _computeOutput returns Omit<TOutput, 'computedAt' | 'validation'>
    // The base class stamps those two fields here, completing TOutput.
    const rawOutput = this._computeOutput(ctx);

    const asOfDate = ctx.options?.asOfDate ?? new Date().toISOString();

    // Stamp computedAt + validation in one step.
    // Explicit cast is safe: rawOutput has every TOutput field except
    // the two we are adding right here.
    const withValidation = {
      ...rawOutput,
      computedAt: asOfDate,
      validation,
    } as TOutput;

    // ── Build fieldMap if requested ───────────────────────────────────────
    const includeFieldMap = ctx.options?.includeFieldMap ?? false;
    const final: TOutput = includeFieldMap
      ? { ...withValidation, fieldMap: this._buildFieldMap(withValidation) }
      : withValidation;

    // ── Build audit trail if requested ────────────────────────────────────
    const includeAudit = ctx.options?.includeAuditTrail ?? false;
    const withAudit: TOutput =
      includeAudit && this._isPeriodContext(ctx)
        ? {
            ...final,
            ...AdapterComputationHelpers.buildAuditTrail(
              ctx as unknown as PeriodFilingContext,
            ),
          }
        : final;

    this._cache.set(key, withAudit);
    return withAudit;
  }

  // ── ITaxFormAdapter: summarize ────────────────────────────────────────────

  summarize(output: TOutput): FilingSummary {
    const formatAmount = (amount: number, currency: CurrencyCode): string => {
      try {
        return new Intl.NumberFormat("en-PH", {
          style: "currency",
          currency,
          minimumFractionDigits: 2,
        }).format(amount);
      } catch {
        return `${currency} ${amount.toFixed(2)}`;
      }
    };

    const periodLabel = this._formatPeriodLabel(output.period);

    return {
      formCode: output.formCode,
      formTitle: output.formTitle,
      period: periodLabel,
      taxpayerName: output.taxpayer.legalName,
      grossIncome: formatAmount(output.grossIncome, output.currency),
      taxDue: formatAmount(output.taxDue, output.currency),
      taxCredits: formatAmount(output.taxCredits, output.currency),
      taxPayable: formatAmount(output.taxPayable, output.currency),
      isOverpayment: output.isOverpayment,
      overpaymentAmount: formatAmount(
        output.overpaymentAmount,
        output.currency,
      ),
      status: output.status,
      validationIssueCount: output.validation.issues.length,
      computedAt: output.computedAt,
    };
  }

  // ── ITaxFormAdapter: clearCache ───────────────────────────────────────────

  clearCache(): void {
    this._cache.clear();
    this._validationCache.clear();
  }

  // ==========================================================================
  // ── ABSTRACT METHODS — implemented by each concrete adapter ────────────────
  // ==========================================================================

  /**
   * Adapter-specific validation rules.
   * Called inside validate() after base structural checks pass.
   * Return an array of ValidationIssue — never throw from here.
   *
   * @example — Form1701QAdapter checks that quarter is set on the period
   */
  protected abstract _validateContext(ctx: TContext): ValidationIssue[];

  /**
   * The actual BIR computation.
   * Called inside compute() after validation passes (or dryRun is true).
   *
   * Return the output WITHOUT: computedAt, validation, fieldMap, auditTrail.
   * The base class stamps all of those after this method returns.
   *
   * The output must include all form-specific fields fully computed.
   * TypeScript enforces that you cannot accidentally include computedAt
   * or validation — they are stripped from the required return type.
   */
  protected abstract _computeOutput(
    ctx: TContext,
  ): Omit<TOutput, "computedAt" | "validation">;

  /**
   * Maps BIR form item numbers to their computed values.
   * Called only when options.includeFieldMap is true.
   *
   * @example — Form1701QAdapter
   * {
   *   "26A": output.grossRevenues,
   *   "28A": output.totalRevenues,
   *   "34A": output.taxableIncomeThisQuarter,
   *   "37A": output.taxDue,
   * }
   */
  protected abstract _buildFieldMap(
    output: TOutput,
  ): Record<string, number | string | boolean>;

  // ==========================================================================
  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Cache key — simple string hash of period boundaries + data counts.
   * Fast and sufficient given FilingContextBuilder produces a fresh
   * normalized context per build(). Limitation: won't detect changes
   * to invoice/expense *contents* if the count stays the same.
   * Call clearCache() explicitly in that scenario.
   */
  private _cacheKey(ctx: TContext): string {
    if (this._isPeriodContext(ctx)) {
      const pCtx = ctx as unknown as PeriodFilingContext;
      const invoiceCount = Array.isArray(pCtx.invoices)
        ? pCtx.invoices.length
        : 0;
      const expenseCount = pCtx.expenses?.length ?? 0;
      const certCount =
        (pCtx.receivedCertificates?.length ?? 0) +
        (pCtx.issuedCertificates?.length ?? 0);
      const period = pCtx.period;
      return [
        this.formCode,
        period.start,
        period.end,
        pCtx.taxYear,
        invoiceCount,
        expenseCount,
        certCount,
      ].join("::");
    }

    // For non-period contexts (transaction, remittance) fall back
    // to a timestamp-based key — effectively no caching
    return `${this.formCode}::${Date.now()}`;
  }

  /**
   * Base validation checks that apply to every adapter regardless of form type.
   * Concrete _validateContext() runs after these.
   */
  private _runBaseValidation(ctx: TContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Profile presence
    if (!ctx.profile) {
      issues.push({
        severity: "error",
        code: "BASE_MISSING_PROFILE",
        message: "TaxpayerProfile is required",
        field: "profile",
      });
      return issues; // can't continue without profile
    }

    // Entity type compatibility — hard check
    const caps = this.capabilities;
    if (
      caps.validForEntityTypes &&
      caps.validForEntityTypes.length > 0 &&
      !caps.validForEntityTypes.includes(ctx.profile.entityType)
    ) {
      issues.push({
        severity: "error",
        code: "BASE_ENTITY_TYPE_MISMATCH",
        message:
          `Adapter "${this.formCode}" is only valid for entity types ` +
          `[${caps.validForEntityTypes.join(", ")}]. ` +
          `Profile entity type is "${ctx.profile.entityType}".`,
        field: "profile.entityType",
      });
    }

    // Tax regime compatibility — hard check
    if (
      caps.validForRegimes &&
      caps.validForRegimes.length > 0 &&
      !caps.validForRegimes.includes(ctx.profile.taxRegime)
    ) {
      issues.push({
        severity: "error",
        code: "BASE_REGIME_MISMATCH",
        message:
          `Adapter "${this.formCode}" is only valid for tax regimes ` +
          `[${caps.validForRegimes.join(", ")}]. ` +
          `Profile tax regime is "${ctx.profile.taxRegime}".`,
        field: "profile.taxRegime",
      });
    }

    // Currency match between context and profile
    if (
      ctx.currency &&
      ctx.profile.functionalCurrency &&
      ctx.currency !== ctx.profile.functionalCurrency
    ) {
      issues.push({
        severity: "warning",
        code: "BASE_CURRENCY_MISMATCH",
        message:
          `Context currency "${ctx.currency}" differs from profile ` +
          `functionalCurrency "${ctx.profile.functionalCurrency}". ` +
          `Ensure this is intentional.`,
        field: "currency",
      });
    }

    // Period presence for period adapters
    if (this._isPeriodContext(ctx)) {
      const pCtx = ctx as unknown as PeriodFilingContext;
      if (!pCtx.period) {
        issues.push({
          severity: "error",
          code: "BASE_MISSING_PERIOD",
          message: "Filing period is required for period-based adapters",
          field: "period",
        });
      }

      // Warn if no invoices
      if (!pCtx.invoices || pCtx.invoices.length === 0) {
        issues.push({
          severity: "warning",
          code: "BASE_NO_INVOICES",
          message:
            "No invoices found for this period. " +
            "Gross income will be zero — verify this is correct.",
          field: "invoices",
        });
      }
    }

    return issues;
  }

  private _isPeriodContext(ctx: TContext): boolean {
    return "period" in ctx && "invoices" in ctx;
  }

  private _formatPeriodLabel(period: FilingPeriod): string {
    if (period.quarter) {
      return `Q${period.quarter} ${period.year}`;
    }
    if (period.month) {
      const monthName = new Date(
        period.year,
        period.month - 1,
        1,
      ).toLocaleString("en-PH", { month: "long" });
      return `${monthName} ${period.year}`;
    }
    return `FY ${period.year}`;
  }

  // ── Protected helper — build the BaseFilingOutput core fields ─────────────

  /**
   * Convenience method for concrete adapters to build the required
   * BaseFilingOutput fields without repeating boilerplate.
   *
   * Call this at the end of _computeOutput() and spread into your output:
   *   return { ...this._buildBaseOutput(ctx, grossIncome, taxDue, taxCredits), ...formSpecificFields }
   */
  protected _buildBaseOutput(
    ctx: TContext,
    params: {
      grossIncome: number;
      taxDue: number;
      taxCredits: number;
      currency: CurrencyCode;
    },
  ): Omit<BaseFilingOutput, "computedAt" | "validation" | "fieldMap"> {
    const { grossIncome, taxDue, taxCredits, currency } = params;
    const taxPayable = Math.max(0, taxDue - taxCredits);
    const overpaymentAmount = Math.max(0, taxCredits - taxDue);
    const isOverpayment = taxCredits > taxDue;
    const period = (ctx as unknown as PeriodFilingContext).period;

    return {
      formCode: this.formCode,
      formTitle: this.formTitle,
      filingFrequency: this.filingFrequency,
      period,
      taxYear: ctx.taxYear,
      taxpayer: {
        tin: ctx.profile.tin,
        legalName: ctx.profile.legalName,
        rdoCode: ctx.profile.rdoCode,
      },
      grossIncome,
      taxDue,
      taxCredits,
      taxPayable,
      currency,
      status: "draft",
      isOverpayment,
      overpaymentAmount,
    };
  }
}

// =============================================================================
// ── LAYER 3: AdapterComputationHelpers ────────────────────────────────────────
// =============================================================================

/**
 * Static pure utility methods shared across all period-based adapters.
 * No state, no side effects — deterministic math and aggregation only.
 *
 * Every method accepts the normalized inputs already prepared by
 * FilingContextBuilder — no re-filtering or re-validation needed here.
 */
export class AdapterComputationHelpers {
  // ── Revenue aggregation ───────────────────────────────────────────────────

  /**
   * Sum gross receipts across all invoices in the context.
   * Handles both ResolvedInvoice and RawInvoiceSummary transparently.
   *
   * "Gross receipts" = totalAmount (including VAT if exclusive,
   * or as stated for inclusive) before any withholding deduction.
   * Adapters that need pre-VAT net revenue should use sumNetRevenue().
   */
  static sumGrossReceipts(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
  ): number {
    return invoices.reduce((sum, inv) => {
      const amount = AdapterComputationHelpers._getInvoiceAmount(inv, "gross");
      return sum + amount;
    }, 0);
  }

  /**
   * Sum net revenue (gross receipts minus VAT collected minus discounts).
   * This is the taxable revenue base for income tax computation —
   * what BIR Form 1701Q calls "Net Sales/Revenues/Receipts/Fees" (Item 38).
   */
  static sumNetRevenue(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
  ): number {
    return invoices.reduce((sum, inv) => {
      const gross = AdapterComputationHelpers._getInvoiceAmount(inv, "gross");
      const vat = AdapterComputationHelpers._getInvoiceAmount(inv, "vat");
      const discount = AdapterComputationHelpers._getInvoiceAmount(
        inv,
        "discount",
      );
      return sum + gross - vat - discount;
    }, 0);
  }

  /**
   * Sum total output VAT collected across all invoices.
   * Feeds into VAT adapter output VAT computation (2550M/2550Q).
   */
  static sumOutputVat(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
  ): number {
    return invoices.reduce((sum, inv) => {
      return sum + AdapterComputationHelpers._getInvoiceAmount(inv, "vat");
    }, 0);
  }

  /**
   * Sum all withholding amounts from invoices.
   * This is EWT withheld by clients from payments to this taxpayer.
   * NOTE: This is different from CWT credits from Form 2307 certificates.
   * Use sumCwtCredits() for certificate-based credits.
   */
  static sumInvoiceWithholding(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
  ): number {
    return invoices.reduce((sum, inv) => {
      return (
        sum + AdapterComputationHelpers._getInvoiceAmount(inv, "withholding")
      );
    }, 0);
  }

  /**
   * Sum gross receipts filtered to a specific invoice status.
   * @example sumGrossReceiptsByStatus(invoices, "paid") — collected revenue only
   */
  static sumGrossReceiptsByStatus(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
    status: string,
  ): number {
    return AdapterComputationHelpers.sumGrossReceipts(
      invoices.filter((inv) => {
        const invStatus =
          "status" in inv ? inv.status : (inv as RawInvoiceSummary).status;
        return invStatus === status;
      }),
    );
  }

  // ── Expense aggregation ───────────────────────────────────────────────────

  /**
   * Sum all deductible expenses for itemized deduction computation.
   * Applies BIR rules:
   *   - Representation expenses are capped at 0.5% (goods) or 1% (services)
   *     of net sales. Pass netSales to enforce the cap.
   *   - Returns total allowable deductions after cap enforcement.
   *
   * @param expenses       - Filtered expenses for the filing period
   * @param netSales       - Net sales amount — used for representation cap
   * @param businessType   - "goods" = 0.5% cap; "services" = 1% cap
   */
  static sumItemizedDeductions(
    expenses: ExpenseRecord[],
    netSales: number,
    businessType: "goods" | "services" | "mixed" = "services",
  ): {
    total: number;
    representationAllowed: number;
    representationCap: number;
    breakdown: Record<string, number>;
  } {
    const breakdown: Record<string, number> = {};
    let representationTotal = 0;
    let nonRepresentationTotal = 0;

    for (const exp of expenses) {
      if (exp.bir?.isRepresentation) {
        representationTotal += exp.totalAmount;
      } else {
        nonRepresentationTotal += exp.totalAmount;
        breakdown[exp.category] =
          (breakdown[exp.category] ?? 0) + exp.totalAmount;
      }
    }

    // BIR representation cap
    const capRate =
      businessType === "goods"
        ? 0.005
        : businessType === "services"
          ? 0.01
          : 0.0075; // mixed: average of the two

    const representationCap = netSales * capRate;
    const representationAllowed = Math.min(
      representationTotal,
      representationCap,
    );

    breakdown["representation"] = representationAllowed;
    const total = nonRepresentationTotal + representationAllowed;

    return {
      total,
      representationAllowed,
      representationCap,
      breakdown,
    };
  }

  /**
   * Sum total input VAT from expenses.
   * Only includes expenses where vatClassification === "creditable".
   * Feeds into 2550M/2550Q input VAT credit computation.
   */
  static sumInputVat(expenses: ExpenseRecord[]): number {
    return expenses.reduce((sum, exp) => {
      if (
        exp.bir?.inputVatAmount &&
        (!exp.bir?.vatClassification ||
          exp.bir.vatClassification === "creditable")
      ) {
        return sum + exp.bir.inputVatAmount;
      }
      return sum;
    }, 0);
  }

  /**
   * Compute Optional Standard Deduction (OSD).
   * 40% of gross receipts (net of returns and allowances).
   * Available to individuals and corporations under Sec. 34(L) NIRC.
   *
   * OSD replaces ALL itemized deductions — the taxpayer elects one or the other.
   * This should only be called when profile.deductionMethod === "osd".
   */
  static computeOSD(netSalesOrReceipts: number): number {
    return netSalesOrReceipts * 0.4;
  }

  // ── Tax credit aggregation ────────────────────────────────────────────────

  /**
   * Sum creditable withholding tax from Form 2307 certificates.
   * These are amounts withheld BY your clients FROM payments to you.
   * Feeds into:
   *   - 1701Q item 38G (CWT withheld this quarter per Form 2307)
   *   - 1701A item 60  (CWT withheld for the year)
   *
   * @param certificates  - receivedCertificates from PeriodFilingContext
   * @param quarter       - optional filter to a specific quarter (1–4)
   */
  static sumCwtCredits(
    certificates: Form2307Certificate[],
    quarter?: 1 | 2 | 3 | 4,
  ): number {
    return certificates
      .filter((cert) => {
        if (quarter === undefined) return true;
        return cert.period.quarter === quarter;
      })
      .reduce((sum, cert) => sum + cert.taxWithheld, 0);
  }

  /**
   * Sum prior year excess tax credits from prior period outputs.
   * Looks for the most recent annual output of the given form code
   * and returns its overpaymentAmount if any.
   *
   * Feeds into:
   *   - 1701Q item 38A (Prior Year's Excess Credits)
   *   - 1701A item 57  (Prior Year's Excess Credits)
   */
  static sumPriorYearExcessCredits(
    priorOutputs: BaseFilingOutput[],
    annualFormCode: string,
  ): number {
    const annualOutputs = priorOutputs
      .filter(
        (o) =>
          o.formCode === annualFormCode &&
          o.filingFrequency === "annual" &&
          o.isOverpayment,
      )
      .sort((a, b) => b.period.end.localeCompare(a.period.end));

    return annualOutputs[0]?.overpaymentAmount ?? 0;
  }

  /**
   * Sum quarterly tax payments already made for the current year.
   * Looks at prior 1701Q outputs and sums their taxPayable amounts.
   *
   * Feeds into:
   *   - 1701A item 58 (Tax Payments for the First Three Quarters)
   */
  static sumPriorQuarterlyPayments(
    priorOutputs: BaseFilingOutput[],
    quarterlyFormCode: string,
    currentYear: number,
  ): number {
    return priorOutputs
      .filter(
        (o) =>
          o.formCode === quarterlyFormCode &&
          o.taxYear === currentYear &&
          o.filingFrequency === "quarterly",
      )
      .reduce((sum, o) => sum + o.taxPayable, 0);
  }

  /**
   * Sum taxable income from prior quarters within the same year.
   * Used for the "Taxable Income Previous Quarter(s)" accumulation
   * on Form 1701Q items 35A/35B.
   */
  static sumPriorQuarterTaxableIncome(
    priorOutputs: BaseFilingOutput[],
    quarterlyFormCode: string,
    currentYear: number,
  ): number {
    return priorOutputs
      .filter(
        (o) =>
          o.formCode === quarterlyFormCode &&
          o.taxYear === currentYear &&
          o.filingFrequency === "quarterly",
      )
      .reduce((sum, o) => {
        // taxableIncome is a form-specific field — access via fieldMap if present
        // or fall back to grossIncome as an approximation
        const taxableIncome = (o.fieldMap?.["34A"] as number) ?? o.grossIncome;
        return sum + taxableIncome;
      }, 0);
  }

  // ── Income tax rate tables ────────────────────────────────────────────────

  /**
   * Apply the BIR graduated income tax rate table.
   *
   * Two tables in effect:
   *   - Table 1: January 1, 2018 – December 31, 2022
   *   - Table 2: January 1, 2023 onwards (TRAIN Law final rates)
   *
   * @param taxableIncome  - Net taxable income after all deductions
   * @param taxYear        - Determines which table to use
   * @returns              - Tax due before credits
   */
  static applyGraduatedRateTable(
    taxableIncome: number,
    taxYear: number,
  ): number {
    if (taxableIncome <= 0) return 0;

    // TRAIN Law final rates (2023 onwards) — from BIR Form 1701A Table 2
    if (taxYear >= 2023) {
      return AdapterComputationHelpers._applyRateTable(taxableIncome, [
        { over: 0, notOver: 250_000, base: 0, rate: 0 },
        { over: 250_000, notOver: 400_000, base: 0, rate: 0.15 },
        { over: 400_000, notOver: 800_000, base: 22_500, rate: 0.2 },
        { over: 800_000, notOver: 2_000_000, base: 102_500, rate: 0.25 },
        { over: 2_000_000, notOver: 8_000_000, base: 402_500, rate: 0.3 },
        { over: 8_000_000, notOver: Infinity, base: 2_202_500, rate: 0.35 },
      ]);
    }

    // Transitional rates (2018–2022) — from BIR Form 1701A Table 1
    return AdapterComputationHelpers._applyRateTable(taxableIncome, [
      { over: 0, notOver: 250_000, base: 0, rate: 0 },
      { over: 250_000, notOver: 400_000, base: 0, rate: 0.2 },
      { over: 400_000, notOver: 800_000, base: 30_000, rate: 0.25 },
      { over: 800_000, notOver: 2_000_000, base: 130_000, rate: 0.3 },
      { over: 2_000_000, notOver: 8_000_000, base: 490_000, rate: 0.32 },
      { over: 8_000_000, notOver: Infinity, base: 2_410_000, rate: 0.35 },
    ]);
  }

  /**
   * Apply the 8% flat income tax rate.
   * Available to self-employed individuals with gross receipts ≤ ₱3M.
   * Applied on gross sales/receipts and other non-operating income
   * MINUS the ₱250,000 exemption.
   *
   * NOTE: The ₱250,000 exemption is only available if the taxpayer
   * does NOT have compensation income. Pass hasCompensationIncome: true
   * to skip the exemption (the ₱250,000 is already embedded in the
   * compensation tax table in that case).
   */
  static applyFlatEightPercent(
    grossReceiptsAndOtherIncome: number,
    options: { hasCompensationIncome?: boolean } = {},
  ): number {
    const exemption = options.hasCompensationIncome ? 0 : 250_000;
    const taxableBase = Math.max(0, grossReceiptsAndOtherIncome - exemption);
    return taxableBase * 0.08;
  }

  /**
   * Apply corporate income tax rate.
   * TRAIN Law / CREATE Act rates:
   *   - 20% for domestic corporations with net taxable income ≤ ₱5M
   *     AND total assets (excluding land) ≤ ₱100M (Small Corporations)
   *   - 25% for all other domestic corporations
   *
   * @param taxableIncome     - Net taxable income
   * @param taxYear           - CREATE Act applies from July 1, 2020
   * @param isSmallCorporation - Whether the 20% rate applies
   */
  static applyCorporateRate(
    taxableIncome: number,
    taxYear: number,
    isSmallCorporation = false,
  ): number {
    if (taxableIncome <= 0) return 0;

    // Pre-CREATE Act: flat 30%
    if (taxYear < 2020) return taxableIncome * 0.3;

    // CREATE Act (2020 onwards)
    const rate = isSmallCorporation ? 0.2 : 0.25;
    return taxableIncome * rate;
  }

  // ── Percentage tax ─────────────────────────────────────────────────────────

  /**
   * Apply the standard 3% percentage tax rate (Sec. 116 NIRC).
   * Applicable to non-VAT registered taxpayers with gross receipts ≤ ₱3M.
   *
   * NOTE: Under CREATE Act, a 1% rate applied from July 1, 2020
   * to June 30, 2023. Pass the period to get the correct rate automatically.
   */
  static applyPercentageTax(
    grossReceipts: number,
    periodStart: string,
  ): {
    taxDue: number;
    rate: number;
  } {
    // CREATE Act temporary 1% rate: July 1, 2020 – June 30, 2023
    const isTemporaryRate =
      periodStart >= "2020-07-01" && periodStart <= "2023-06-30";
    const rate = isTemporaryRate ? 0.01 : 0.03;
    return { taxDue: grossReceipts * rate, rate };
  }

  // ── VAT ───────────────────────────────────────────────────────────────────

  /**
   * Compute VAT payable (or excess input VAT to carry forward).
   *
   * VAT Payable = Output VAT − Input VAT − Prior Period Excess Input VAT
   *
   * If the result is negative, there is excess input VAT to carry forward
   * to the next period — returned as excessInputVat.
   */
  static computeVatPayable(params: {
    outputVat: number;
    inputVat: number;
    priorExcessInputVat: number;
  }): {
    vatPayable: number;
    excessInputVat: number;
    isExcessInput: boolean;
  } {
    const { outputVat, inputVat, priorExcessInputVat } = params;
    const totalInputVat = inputVat + priorExcessInputVat;
    const net = outputVat - totalInputVat;

    if (net >= 0) {
      return { vatPayable: net, excessInputVat: 0, isExcessInput: false };
    }

    return {
      vatPayable: 0,
      excessInputVat: Math.abs(net),
      isExcessInput: true,
    };
  }

  /**
   * Extract prior period excess input VAT from prior period outputs.
   * Looks for the most recent 2550M or 2550Q output with excessInputVat > 0.
   */
  static getPriorExcessInputVat(
    priorOutputs: BaseFilingOutput[],
    vatFormCodes: string[] = ["2550M", "2550Q"],
  ): number {
    const vatOutputs = priorOutputs
      .filter((o) => vatFormCodes.includes(o.formCode))
      .sort((a, b) => b.period.end.localeCompare(a.period.end));

    const latest = vatOutputs[0];
    if (!latest) return 0;

    // excessInputVat is a form-specific field — access via fieldMap
    return (latest.fieldMap?.["excessInputVat"] as number) ?? 0;
  }

  // ── Audit trail ───────────────────────────────────────────────────────────

  /**
   * Build the audit trail fields for a BaseFilingOutput.
   * Returns invoiceIds and expenseIds arrays.
   * Only called when options.includeAuditTrail is true.
   */
  static buildAuditTrail(ctx: PeriodFilingContext): {
    invoiceIds: string[];
    expenseIds: string[];
  } {
    const invoiceIds = (ctx.invoices ?? []).map((inv) => {
      if ("id" in inv) return (inv as ResolvedInvoice | RawInvoiceSummary).id;
      return "unknown";
    });

    const expenseIds = (ctx.expenses ?? []).map((exp) => exp.id);

    return { invoiceIds, expenseIds };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private static _getInvoiceAmount(
    inv: ResolvedInvoice | RawInvoiceSummary,
    field: "gross" | "vat" | "discount" | "withholding" | "net",
  ): number {
    // RawInvoiceSummary
    if ("kind" in inv && inv.kind === "raw-summary") {
      const raw = inv as RawInvoiceSummary;
      switch (field) {
        case "gross":
          return raw.grossAmount;
        case "vat":
          return raw.vatAmount;
        case "discount":
          return raw.discountAmount;
        case "withholding":
          return raw.withholdingAmount;
        case "net":
          return raw.netAmount;
      }
    }

    // ResolvedInvoice (GeneralInvoice shape)
    const resolved = inv as ResolvedInvoice;
    switch (field) {
      case "gross":
        return resolved.totalAmount;
      case "vat":
        return resolved.taxAmount;
      case "discount":
        return resolved.discountAmount;
      case "withholding":
        return resolved.withholdingAmount;
      case "net":
        return resolved.netPayableAmount;
    }
  }

  /**
   * Internal rate table engine.
   * Walks the brackets and computes tax due.
   */
  private static _applyRateTable(
    taxableIncome: number,
    brackets: Array<{
      over: number;
      notOver: number;
      base: number;
      rate: number;
    }>,
  ): number {
    for (const bracket of brackets) {
      if (taxableIncome > bracket.over && taxableIncome <= bracket.notOver) {
        const excess = taxableIncome - bracket.over;
        return bracket.base + excess * bracket.rate;
      }
    }
    return 0;
  }
}
