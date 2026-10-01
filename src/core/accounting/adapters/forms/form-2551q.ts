/**
 * @file form-2551q.ts
 * @description Form2551QAdapter — BIR Form 2551Q
 * Quarterly Percentage Tax Return.
 *
 * ── COMPLIANCE NOTES ──────────────────────────────────────────────────────────
 *
 * 1. MONTHLY FORM DEPRECATED:
 *    BIR Form 2551M (Monthly Percentage Tax) is deprecated under the TRAIN Law.
 *    Only Form 2551Q (Quarterly) is required for regular taxpayers.
 *    Deadline: 25th day of the month following the close of each taxable quarter.
 *      Q1 (Jan–Mar):  April 25
 *      Q2 (Apr–Jun):  July 25
 *      Q3 (Jul–Sep):  October 25
 *      Q4 (Oct–Dec):  January 25
 *
 * 2. 8% FLAT RATE EXEMPTION:
 *    Under Section 116 of the NIRC as amended by the TRAIN Law, individuals
 *    who opt for the 8% flat income tax rate are EXEMPT from percentage tax.
 *    This adapter enforces that exemption — if profile.taxRateElection is
 *    "flat-8-percent", the adapter throws a pre-flight validation error.
 *
 * 3. STANDARD RATE (Section 116):
 *    3% on gross sales/receipts for non-VAT registered taxpayers.
 *    Exception: 1% temporary rate applied July 1, 2020 – June 30, 2023
 *    (CREATE Act, Section 13) — the adapter applies the correct rate
 *    automatically based on the filing period.
 *
 * 4. ATC CODES AND TRANSACTION TYPES:
 *    Form 2551Q Part II accepts multiple transaction rows (Items 14–18),
 *    each with its own Taxable Transaction/Industry Classification,
 *    ATC code, taxable amount, and applicable rate.
 *    This adapter supports multiple transaction rows via config.
 *
 * Valid for: individual, estate, trust, corporation, partnership
 * Tax regime: percentage-tax only
 * NOT valid for: taxpayers who elected the 8% flat income tax rate
 *
 * Usage:
 * ```ts
 * const adapter = new Form2551QAdapter({ quarter: 1 });
 *
 * const ta = TaxAccountant.init({
 *   adapter,
 *   context: await FilingContextBuilder.from({
 *     profile,
 *     period: FilingPeriodHelper.q1(2024),
 *     taxYear: 2024,
 *     currency: "PHP",
 *     invoices: q1Invoices,
 *   }).build(),
 * });
 *
 * const output = ta.prepare();
 * console.log(output.partII.totalTaxDue);   // Item 19
 * console.log(output.totalAmountPayable);    // Item 24
 * ```
 */

import type {
  AdapterCapabilities,
  BaseFilingOutput,
  PeriodFilingContext,
  ValidationIssue,
} from "../../types/";

import {
  AbstractBaseTaxAdapter,
  AdapterComputationHelpers,
} from "../base-adapter";

// =============================================================================
// ── ADAPTER CONFIG ────────────────────────────────────────────────────────────
// =============================================================================

/**
 * A single transaction row for Part II of Form 2551Q.
 * The form supports up to 5 rows (Items 14A–18A).
 *
 * If only one row is configured, it captures all gross receipts.
 * If multiple rows are configured, receipts are manually allocated.
 */
export interface PercentageTaxTransactionRow {
  /**
   * Taxable Transaction / Industry Classification description.
   * @example "Multimedia Services", "Professional Services"
   */
  classification: string;

  /**
   * ATC code for this transaction type.
   * @example "OPT", "PT160"
   */
  atcCode: string;

  /**
   * Taxable amount for this row.
   * If omitted, the adapter uses sumGrossReceipts(invoices) for the
   * first (and only) row, or zero for subsequent rows.
   */
  taxableAmount?: number;

  /**
   * Tax rate for this row.
   * If omitted, the standard Section 116 rate is applied automatically
   * (3% standard, 1% CREATE Act temporary rate July 2020–June 2023).
   */
  taxRate?: number;
}

export interface Form2551QPenalties {
  surcharge?: number;
  interest?: number;
  compromise?: number;
}

export interface Form2551QAdapterConfig {
  /** Which quarter (1–4) */
  quarter: 1 | 2 | 3 | 4;

  /**
   * Transaction rows for Part II (Items 14A–18A).
   * Maximum 5 rows per the form.
   *
   * If not provided, a single default row is created:
   *   classification: profile.lineOfBusiness or "Business/Professional Services"
   *   atcCode: "OPT"
   *   taxableAmount: sumGrossReceipts(invoices)
   *   taxRate: auto-computed per period (3% or 1% CREATE Act)
   */
  transactionRows?: PercentageTaxTransactionRow[];

  /**
   * Item 20A — Creditable percentage tax withheld per BIR Form 2307.
   * For percentage tax, this is the CWT withheld by government payors.
   */
  cwtWithheld?: number;

  /**
   * Item 20B — Tax paid in previously filed return (amended only).
   */
  taxPaidAmended?: number;

  /** Whether this is an amended return */
  isAmended?: boolean;

  /** Penalties for late filing */
  penalties?: Form2551QPenalties;
}

// =============================================================================
// ── OUTPUT TYPES ──────────────────────────────────────────────────────────────
// =============================================================================

/**
 * A single computed transaction row.
 */
export interface ComputedTransactionRow {
  /** Row number (1–5, maps to Items 14–18) */
  rowNumber: 1 | 2 | 3 | 4 | 5;
  /** Form item prefix (e.g. "14A", "15A") */
  itemLabel: string;
  classification: string;
  atcCode: string;
  taxableAmount: number;
  taxRate: number;
  taxDue: number;
  /** Whether the CREATE Act 1% temporary rate was applied */
  isCreateActRate: boolean;
}

/**
 * Part II — Computation of Tax.
 */
export interface Form2551QPartII {
  /** Individual transaction rows (up to 5) */
  rows: ComputedTransactionRow[];
  /** Item 19 — Total Tax Due (sum of all row taxDue) */
  totalTaxDue: number;
  /** Item 20A — Creditable percentage tax withheld */
  cwtWithheld: number;
  /** Item 20B — Tax paid on previously filed return */
  taxPaidAmended: number;
  /** Item 21 — Total Tax Credits/Payments (20A + 20B) */
  totalCredits: number;
  /** Item 22 — Tax Payable/(Overpayment) (19 - 21) */
  taxPayable: number;
  isOverpayment: boolean;
  overpaymentAmount: number;
}

/**
 * Part III / Summary — Penalties and total.
 */
export interface Form2551QSummary {
  /** Item 23A — Surcharge */
  surcharge: number;
  /** Item 23B — Interest */
  interest: number;
  /** Item 23C — Compromise */
  compromise: number;
  /** Item 23D — Total Penalties */
  totalPenalties: number;
  /** Item 24 — Total Amount Payable/(Overpayment) */
  totalAmountPayable: number;
}

/**
 * Full typed output of Form2551QAdapter.
 */
export interface Form2551QOutput extends BaseFilingOutput {
  formCode: "2551Q";
  quarter: 1 | 2 | 3 | 4;
  taxYear: number;
  partII: Form2551QPartII;
  summary: Form2551QSummary;
  /** Tax rate applied (3% standard or 1% CREATE Act) */
  appliedRate: number;
  isCreateActRate: boolean;
  isAmended: boolean;
  /** Filing deadline for this quarter */
  filingDeadline: string;
}

// =============================================================================
// ── FORM 2551Q ADAPTER ────────────────────────────────────────────────────────
// =============================================================================

export class Form2551QAdapter extends AbstractBaseTaxAdapter<
  PeriodFilingContext,
  Form2551QOutput
> {
  // ── Identity ──────────────────────────────────────────────────────────────

  readonly formCode = "2551Q" as const;
  readonly formTitle = "Quarterly Percentage Tax Return";
  readonly filingFrequency = "quarterly" as const;

  readonly capabilities: AdapterCapabilities = {
    formCode: "2551Q",
    formTitle: "Quarterly Percentage Tax Return",
    filingFrequency: "quarterly",
    contextType: "period",
    requiresExpenses: false,
    requiresReceivedCertificates: false,
    requiresIssuedCertificates: false,
    requiresPriorPeriodOutputs: false,
    requiredPriorFormCodes: [],
    validForEntityTypes: undefined, // all entity types
    validForRegimes: ["percentage-tax"],
  };

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _quarter: 1 | 2 | 3 | 4;
  private readonly _transactionRows?: PercentageTaxTransactionRow[];
  private readonly _cwtWithheld: number;
  private readonly _taxPaidAmended: number;
  private readonly _isAmended: boolean;
  private readonly _penalties?: Form2551QPenalties;

  constructor(config: Form2551QAdapterConfig) {
    super();

    if (!config.quarter || ![1, 2, 3, 4].includes(config.quarter)) {
      throw new Error(
        `Form2551QAdapter: quarter must be 1, 2, 3, or 4. Got: ${config.quarter}`,
      );
    }

    if (config.transactionRows && config.transactionRows.length > 5) {
      throw new Error(
        `Form2551QAdapter: maximum 5 transaction rows allowed per BIR Form 2551Q. ` +
          `Got: ${config.transactionRows.length}`,
      );
    }

    this._quarter = config.quarter;
    this._transactionRows = config.transactionRows;
    this._cwtWithheld = config.cwtWithheld ?? 0;
    this._taxPaidAmended = config.taxPaidAmended ?? 0;
    this._isAmended = config.isAmended ?? false;
    this._penalties = config.penalties;
  }

  // ==========================================================================
  // ── ABSTRACT IMPLEMENTATIONS ───────────────────────────────────────────────
  // ==========================================================================

  protected _validateContext(ctx: PeriodFilingContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const profile = ctx.profile;

    // Must be quarterly period
    if (ctx.period?.quarter === undefined) {
      issues.push({
        severity: "error",
        code: "PT2551Q_NOT_QUARTERLY",
        message:
          "Form 2551Q requires a quarterly filing period. " +
          `Use FilingPeriodHelper.quarter(year, ${this._quarter}).`,
        field: "period",
      });
    } else if (ctx.period.quarter !== this._quarter) {
      issues.push({
        severity: "error",
        code: "PT2551Q_QUARTER_MISMATCH",
        message:
          `Adapter configured for Q${this._quarter} but ` +
          `context period is Q${ctx.period.quarter}.`,
        field: "period.quarter",
      });
    }

    // Hard block: 8% flat rate taxpayers are EXEMPT from percentage tax
    // Reference: Section 116 NIRC as amended by TRAIN Law
    if (profile.taxRateElection === "flat-8-percent") {
      issues.push({
        severity: "error",
        code: "PT2551Q_EXEMPT_8PCT",
        message:
          "Taxpayers who opted for the 8% Flat Income Tax Rate are EXEMPT " +
          "from filing Form 2551Q (Quarterly Percentage Tax). " +
          "This is a statutory exemption under Section 116 of the NIRC " +
          "as amended by the TRAIN Law. " +
          "No percentage tax return should be filed for this taxpayer.",
        field: "profile.taxRateElection",
      });
    }

    // Percentage tax regime check (also enforced by capabilities)
    if (profile.taxRegime !== "percentage-tax") {
      issues.push({
        severity: "error",
        code: "PT2551Q_WRONG_REGIME",
        message:
          `Form 2551Q is only for percentage-tax registered taxpayers. ` +
          `Profile taxRegime is "${profile.taxRegime}". ` +
          `VAT-registered taxpayers file Form 2550Q instead.`,
        field: "profile.taxRegime",
      });
    }

    // Warn if no invoices
    if (!ctx.invoices || ctx.invoices.length === 0) {
      issues.push({
        severity: "warning",
        code: "PT2551Q_NO_INVOICES",
        message:
          "No invoices found for this quarter. " +
          "Gross receipts and percentage tax due will be zero.",
        field: "invoices",
      });
    }

    // Amended check
    if (this._isAmended && this._taxPaidAmended === 0) {
      issues.push({
        severity: "warning",
        code: "PT2551Q_AMENDED_NO_PRIOR",
        message:
          "isAmended is true but taxPaidAmended is 0. " +
          "Provide the previously paid amount via config.taxPaidAmended.",
        field: "taxPaidAmended",
      });
    }

    // Transaction rows max 5
    if (this._transactionRows && this._transactionRows.length > 5) {
      issues.push({
        severity: "error",
        code: "PT2551Q_TOO_MANY_ROWS",
        message:
          "Form 2551Q Part II supports a maximum of 5 transaction rows " +
          "(Items 14–18). Reduce the number of transaction rows.",
        field: "transactionRows",
      });
    }

    return issues;
  }

  protected _computeOutput(
    ctx: PeriodFilingContext,
  ): Omit<Form2551QOutput, "computedAt" | "validation"> {
    const invoices = ctx.invoices ?? [];
    const currency = ctx.currency;
    const period = ctx.period;

    // ── Resolve applicable rate ────────────────────────────────────────────
    const { rate, isCreateActRate } = this._resolveRate(period.start);

    // ── Compute gross receipts from invoices ──────────────────────────────
    const totalGrossReceipts =
      AdapterComputationHelpers.sumGrossReceipts(invoices);

    // ── Build transaction rows ────────────────────────────────────────────
    const rows = this._buildTransactionRows(
      totalGrossReceipts,
      rate,
      isCreateActRate,
      ctx,
    );

    // ── Part II computation ───────────────────────────────────────────────
    const totalTaxDue = rows.reduce((sum, r) => sum + r.taxDue, 0);
    const totalCredits = this._cwtWithheld + this._taxPaidAmended;
    const netTax = totalTaxDue - totalCredits;
    const isOverpayment = netTax < 0;
    const taxPayable = Math.max(0, netTax);
    const overpaymentAmount = Math.max(0, -netTax);

    const partII: Form2551QPartII = {
      rows,
      totalTaxDue,
      cwtWithheld: this._cwtWithheld,
      taxPaidAmended: this._taxPaidAmended,
      totalCredits,
      taxPayable,
      isOverpayment,
      overpaymentAmount,
    };

    // ── Summary ───────────────────────────────────────────────────────────
    const surcharge = this._penalties?.surcharge ?? 0;
    const interest = this._penalties?.interest ?? 0;
    const compromise = this._penalties?.compromise ?? 0;
    const totalPenalties = surcharge + interest + compromise;
    const totalAmountPayable = isOverpayment ? 0 : taxPayable + totalPenalties;

    const summary: Form2551QSummary = {
      surcharge,
      interest,
      compromise,
      totalPenalties,
      totalAmountPayable,
    };

    // ── Base output ───────────────────────────────────────────────────────
    const base = this._buildBaseOutput(ctx, {
      grossIncome: totalGrossReceipts,
      taxDue: totalTaxDue,
      taxCredits: totalCredits,
      currency,
    });

    return {
      ...base,
      formCode: "2551Q",
      quarter: this._quarter,
      taxYear: ctx.taxYear,
      partII,
      summary,
      appliedRate: rate,
      isCreateActRate,
      isAmended: this._isAmended,
      filingDeadline: this._computeFilingDeadline(this._quarter, ctx.taxYear),
    };
  }

  protected _buildFieldMap(
    output: Form2551QOutput,
  ): Record<string, number | string | boolean> {
    const map: Record<string, number | string | boolean> = {};
    const p = output.partII;

    // Transaction rows (Items 14A–18A)
    output.partII.rows.forEach((row) => {
      map[`${row.itemLabel}_classification`] = row.classification;
      map[`${row.itemLabel}_atc`] = row.atcCode;
      map[`${row.itemLabel}C`] = row.taxableAmount; // taxable amount column
      map[`${row.itemLabel}D`] = row.taxRate; // tax rate column
      map[`${row.itemLabel}E`] = row.taxDue; // tax due column
    });

    // Part II totals
    map["19"] = p.totalTaxDue;
    map["20A"] = p.cwtWithheld;
    map["20B"] = p.taxPaidAmended;
    map["21"] = p.totalCredits;
    map["22"] = p.taxPayable;

    // Summary
    map["23A"] = output.summary.surcharge;
    map["23B"] = output.summary.interest;
    map["23C"] = output.summary.compromise;
    map["23D"] = output.summary.totalPenalties;
    map["24"] = output.summary.totalAmountPayable;

    return map;
  }

  // ==========================================================================
  // ── PRIVATE: RATE RESOLUTION ──────────────────────────────────────────────
  // ==========================================================================

  /**
   * Resolve the applicable percentage tax rate for the given period.
   *
   * Standard rate: 3% per Section 116 NIRC
   *
   * CREATE Act temporary rate: 1%
   *   Effective: July 1, 2020 – June 30, 2023
   *   Reference: Section 13, RA 11534 (CREATE Act)
   *   Note: The AdapterComputationHelpers.applyPercentageTax() also
   *   handles this — we use it here for consistency.
   */
  private _resolveRate(periodStart: string): {
    rate: number;
    isCreateActRate: boolean;
  } {
    const isCreateActPeriod =
      periodStart >= "2020-07-01" && periodStart <= "2023-06-30";

    return {
      rate: isCreateActPeriod ? 0.01 : 0.03,
      isCreateActRate: isCreateActPeriod,
    };
  }

  // ==========================================================================
  // ── PRIVATE: TRANSACTION ROW BUILDER ──────────────────────────────────────
  // ==========================================================================

  private _buildTransactionRows(
    totalGrossReceipts: number,
    _defaultRate: number,
    isCreateActRate: boolean,
    ctx: PeriodFilingContext,
  ): ComputedTransactionRow[] {
    const ROW_LABELS: Record<number, string> = {
      1: "14A",
      2: "15A",
      3: "16A",
      4: "17A",
      5: "18A",
    };

    // If no rows configured, create a single default row
    if (!this._transactionRows || this._transactionRows.length === 0) {
      const { taxDue, rate } = AdapterComputationHelpers.applyPercentageTax(
        totalGrossReceipts,
        ctx.period.start,
      );

      const lineOfBusiness =
        (ctx.profile as any).lineOfBusiness ?? "Business/Professional Services";

      return [
        {
          rowNumber: 1,
          itemLabel: "14A",
          classification: lineOfBusiness,
          atcCode: "OPT",
          taxableAmount: totalGrossReceipts,
          taxRate: rate,
          taxDue,
          isCreateActRate,
        },
      ];
    }

    // Build from configured rows
    return this._transactionRows.map((rowConfig, index) => {
      const rowNumber = (index + 1) as 1 | 2 | 3 | 4 | 5;
      const itemLabel = ROW_LABELS[rowNumber];

      // Use configured taxable amount or total gross receipts for first row
      const taxableAmount =
        rowConfig.taxableAmount ?? (index === 0 ? totalGrossReceipts : 0);

      // Use configured rate or auto-resolve
      let taxRate = rowConfig.taxRate;
      let rowIsCreateActRate = isCreateActRate;

      if (taxRate === undefined) {
        const resolved = AdapterComputationHelpers.applyPercentageTax(
          taxableAmount,
          ctx.period.start,
        );
        taxRate = resolved.rate;
      } else {
        // If rate is manually set, CREATE Act flag doesn't apply
        rowIsCreateActRate = false;
      }

      const taxDue = taxableAmount * taxRate;

      return {
        rowNumber,
        itemLabel,
        classification: rowConfig.classification,
        atcCode: rowConfig.atcCode,
        taxableAmount,
        taxRate,
        taxDue,
        isCreateActRate: rowIsCreateActRate,
      };
    });
  }

  // ==========================================================================
  // ── PRIVATE: FILING DEADLINE ──────────────────────────────────────────────
  // ==========================================================================

  /**
   * Compute the filing deadline for a given quarter.
   * Deadline: 25th day of the month following the close of each taxable quarter.
   *   Q1: April 25
   *   Q2: July 25
   *   Q3: October 25
   *   Q4: January 25 (following year)
   */
  private _computeFilingDeadline(
    quarter: 1 | 2 | 3 | 4,
    taxYear: number,
  ): string {
    const deadlines: Record<1 | 2 | 3 | 4, string> = {
      1: `${taxYear}-04-25`,
      2: `${taxYear}-07-25`,
      3: `${taxYear}-10-25`,
      4: `${taxYear + 1}-01-25`,
    };
    return deadlines[quarter];
  }
}
