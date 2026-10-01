/**
 * @file form-1701a.ts
 * @description Form1701AAdapter — BIR Form 1701A
 * Annual Income Tax Return for Individuals Earning Income PURELY from
 * Business/Profession (Graduated rates with OSD OR 8% flat income tax rate).
 *
 * Computation strategy — dual-path with reconciliation:
 *
 *   Path A (Direct) — always runs
 *     Re-processes all annual invoices + expenses directly.
 *     This is the authoritative source for output figures.
 *
 *   Path B (Quarterly aggregation) — runs when 1701Q outputs are available
 *     Sums the up-to-4 Form1701QOutput.filer columns from priorPeriodOutputs
 *     or the FilingChain.
 *
 *   Reconciliation layer — runs when both paths have data
 *     Compares Path A vs Path B field by field.
 *     Diff tolerance: ₱1.00 (absorbs floating-point rounding across quarters).
 *     Never throws — produces warnings in ValidationResult only.
 *     Output always uses Path A figures as authoritative.
 *
 * Supports:
 *   - Graduated income tax rates (Part IV-A, Items 36–46)
 *   - Flat 8% income tax rate (Part IV-B, Items 47–56)
 *   - OSD and Itemized deductions
 *   - COGS via COGSManager
 *   - Full Part IV-C tax credits (Items 57–65)
 *   - Part II total tax payable with installment split (Items 20–30)
 *   - Optional installment override (pay in full)
 *   - Foreign tax credits (Item 62)
 *   - Optional penalty computation
 *
 * Valid for: individual, estate, trust entity types
 *
 * Usage:
 * ```ts
 * const adapter = new Form1701AAdapter({
 *   taxRateElection: "graduated",
 *   deductionMethodOverride: "osd",
 * });
 *
 * const ta = TaxAccountant.init({
 *   adapter,
 *   context: await FilingContextBuilder.from({
 *     profile,
 *     period: FilingPeriodHelper.annual(2024),
 *     taxYear: 2024,
 *     currency: "PHP",
 *     invoices: allYearInvoices,
 *     expenses: allYearExpenses,
 *     cogsManager,
 *     receivedCertificates: allForm2307s,
 *     priorPeriodOutputs: [q1Output, q2Output, q3Output, q4Output],
 *   }).build(),
 * });
 *
 * const output = ta.prepare();
 * console.log(output.partII.totalAmountPayable); // Item 29
 * console.log(output.reconciliation.matched);    // true if quarterly totals match
 * ```
 */

import type {
  AdapterCapabilities,
  BaseFilingOutput,
  FilingPeriod,
  Form2307Certificate,
  PeriodFilingContext,
  TaxpayerProfile,
  ValidationIssue,
  ResolvedInvoice, RawInvoiceSummary
} from "../../types";

import {
  AbstractBaseTaxAdapter,
  AdapterComputationHelpers,
} from "../base-adapter";


import type {
  COGSManager,
  COGSComputationResult,
  COGSInvoiceInput,
} from "../../cogs-manager";
import type {
  Form1701QOutput,
  Form1701QDeductionDetail,
} from "./form-1701q";
import { ExpenseRecord } from "../../../expenses/expense-record";

// =============================================================================
// ── FORM 1701A CONTEXT EXTENSION ──────────────────────────────────────────────
// =============================================================================

export interface Form1701AContext extends PeriodFilingContext {
  cogsManager?: COGSManager;
}

// =============================================================================
// ── ADAPTER CONFIG ────────────────────────────────────────────────────────────
// =============================================================================

export interface Form1701APenalties {
  /** 25% surcharge — Item 25A */
  surcharge?: number;
  /** 12% interest per annum — Item 26A */
  interest?: number;
  /** Compromise penalty — Item 27A */
  compromise?: number;
}

export interface Form1701AAdapterConfig {
  /**
   * Tax rate election override.
   * If provided, overrides profile.taxRateElection.
   */
  taxRateElectionOverride?: "graduated" | "flat-8-percent";

  /**
   * Deduction method override.
   * If provided, overrides profile.deductionMethod.
   */
  deductionMethodOverride?: "osd" | "itemized";

  /**
   * Business type — affects representation expense cap.
   * Default: "services"
   */
  businessType?: "goods" | "services" | "mixed";

  /**
   * Items 41–42 — Other income declared annually.
   * E.g. interest, dividends, rental from personal assets.
   */
  otherIncome?: number;

  /**
   * Item 43 — GPP income for the full year.
   */
  gppIncome?: number;

  /**
   * Item 62 — Foreign tax credits.
   * Taxes paid to foreign governments on foreign-sourced income.
   */
  foreignTaxCredits?: number;

  /**
   * Item 63 — Other tax credits not covered by Form 2307 or prior quarters.
   */
  otherTaxCredits?: number;

  /**
   * Item 61 — Tax paid in return previously filed (amended returns only).
   */
  taxPaidAmended?: number;

  /**
   * Whether this is an amended return.
   */
  isAmended?: boolean;

  /**
   * Installment payment election.
   *
   * "installment" — split tax payable into 2 equal installments:
   *   1st: 50% due April 15
   *   2nd: 50% due July 15
   *
   * "full" — pay the entire balance in one payment (April 15 deadline).
   *
   * Default: "installment"
   */
  paymentMode?: "installment" | "full";

  /**
   * Whether the taxpayer has compensation income.
   * Affects the ₱250,000 exemption on the flat 8% path.
   */
  hasCompensationIncome?: boolean;

  /**
   * Penalty details — default to zero.
   */
  penalties?: Form1701APenalties;

  /**
   * Reconciliation diff tolerance in PHP.
   * If |Path A - Path B| ≤ tolerance, the field is considered matched.
   * Default: 1.00
   */
  reconciliationTolerance?: number;
}

// =============================================================================
// ── RECONCILIATION TYPES ──────────────────────────────────────────────────────
// =============================================================================

export interface ReconciliationFieldResult {
  field: string;
  directAmount: number;
  quarterlyAmount: number;
  difference: number;
  matched: boolean;
}

export interface ReconciliationResult {
  /** True if all compared fields are within tolerance */
  matched: boolean;
  /** How many quarters were found in priorPeriodOutputs */
  quartersFound: number;
  /** Which quarters were present (1–4) */
  quartersPresent: (1 | 2 | 3 | 4)[];
  /** Which quarters were missing */
  quartersMissing: (1 | 2 | 3 | 4)[];
  /** Per-field comparison results */
  fields: ReconciliationFieldResult[];
  /** Tolerance used for matching */
  tolerance: number;
}

// =============================================================================
// ── FORM 1701A OUTPUT SECTIONS ────────────────────────────────────────────────
// =============================================================================

/**
 * Part IV-A — Graduated income tax computation (Items 36–46).
 * Only populated when taxRateElection === "graduated".
 */
export interface Form1701APartIVA {
  /** Item 36 — Sales/Revenues/Receipts/Fees */
  grossRevenues: number;
  /** Item 37 — Less: Sales Returns, Allowances and Discounts */
  salesReturnsAndDiscounts: number;
  /** Item 38 — Net Sales/Revenues/Receipts/Fees (36 - 37) */
  netSales: number;
  /** Item 39 — Less: Allowable Deduction (OSD or Itemized) */
  deductions: number;
  /** Item 40 — Net Income (38 - 39) */
  netIncome: number;
  /** Items 41–42 — Other Income */
  otherIncome: number;
  /** Item 43 — GPP Income */
  gppIncome: number;
  /** Item 44 — Total Other Income (41 + 42 + 43) */
  totalOtherIncome: number;
  /** Item 45 — Total Taxable Income (40 + 44) */
  totalTaxableIncome: number;
  /** Item 46 — Tax Due (from rate table) */
  taxDue: number;
  /** Deduction breakdown for audit trail */
  deductionDetail: Form1701QDeductionDetail;
}

/**
 * Part IV-B — 8% flat income tax computation (Items 47–56).
 * Only populated when taxRateElection === "flat-8-percent".
 */
export interface Form1701APartIVB {
  /** Item 47 — Sales/Revenues/Receipts/Fees */
  grossRevenues: number;
  /** Item 48 — Less: Sales Returns, Allowances and Discounts */
  salesReturnsAndDiscounts: number;
  /** Item 49 — Net Sales/Revenues/Receipts/Fees (47 - 48) */
  netSales: number;
  /** Items 50–51 — Other Non-Operating Income */
  otherNonOperatingIncome: number;
  /** Item 52 — Total Other Non-Operating Income */
  totalOtherNonOperatingIncome: number;
  /** Item 53 — Total Taxable Income (49 + 52) */
  totalTaxableIncome: number;
  /**
   * Item 54 — Less: Allowable deduction for PURELY self-employed
   * (₱250,000 — only if no compensation income).
   */
  allowableDeduction: number;
  /** Item 55 — Taxable Income/(Loss) (53 - 54) */
  taxableIncome: number;
  /** Item 56 — Tax Due (55 × 8%) */
  taxDue: number;
}

/**
 * Part IV-C — Tax Credits/Payments (Items 57–65).
 */
export interface Form1701APartIVC {
  /** Item 57 — Prior Year's Excess Credits */
  priorYearExcessCredits: number;
  /** Item 58 — Tax Payments for First Three Quarters */
  firstThreeQuarterPayments: number;
  /** Item 59 — CWT Withheld for First Three Quarters */
  cwtFirstThreeQuarters: number;
  /** Item 60 — CWT Withheld per BIR Form 2307 for Q4 */
  cwtQ4: number;
  /** Item 61 — Tax Paid in Return Previously Filed (amended) */
  taxPaidAmended: number;
  /** Item 62 — Foreign Tax Credits */
  foreignTaxCredits: number;
  /** Item 63 — Other Tax Credits/Payments */
  otherTaxCredits: number;
  /** Item 64 — Total Tax Credits/Payments (57–63) */
  totalCredits: number;
  /** Item 65 — Net Taxable/(Overpayment) (Item 20 less Item 64) */
  netTaxable: number;
  isOverpayment: boolean;
}

/**
 * Part II — Total Tax Payable (Items 20–30).
 */
export interface Form1701APartII {
  /** Item 20 — Tax Due (from Part IV-A Item 46 or Part IV-B Item 56) */
  taxDue: number;
  /** Item 21 — Total Tax Credits (from Part IV-C Item 64) */
  totalCredits: number;
  /** Item 22 — Tax Payable/(Overpayment) (20 - 21) */
  taxPayable: number;
  isOverpayment: boolean;
  overpaymentAmount: number;

  /**
   * Item 23 — Less: Portion for 2nd installment (50% of Item 22).
   * Zero when paymentMode === "full" or when there is an overpayment.
   */
  secondInstallmentPortion: number;
  /**
   * Item 24 — Amount to be paid upon filing (Item 22 less Item 23).
   * Equals full taxPayable when paymentMode === "full".
   * Equals 50% of taxPayable when paymentMode === "installment".
   */
  amountDueUponFiling: number;
  /**
   * The 2nd installment amount due July 15.
   * Zero when paymentMode === "full".
   */
  secondInstallmentAmount: number;

  /** Item 25 — Surcharge */
  surcharge: number;
  /** Item 26 — Interest */
  interest: number;
  /** Item 27 — Compromise */
  compromise: number;
  /** Item 28 — Total Penalties (25 + 26 + 27) */
  totalPenalties: number;
  /** Item 29 — Total Amount Payable/(Overpayment) (24 + 28) */
  totalAmountPayable: number;
  /** Item 30 — Aggregate Amount Payable (filer + spouse, if any) */
  aggregateAmountPayable: number;

  paymentMode: "installment" | "full";
}

/**
 * Full typed output of Form1701AAdapter.
 */
export interface Form1701AOutput extends BaseFilingOutput {
  formCode: "1701A";

  /** Tax year this annual return covers */
  taxYear: number;

  /** Tax rate election used */
  taxRateElection: "graduated" | "flat-8-percent";

  /** Deduction method (only meaningful on graduated path) */
  deductionMethod: "osd" | "itemized";

  /** Part IV-A — Graduated computation. Populated only on graduated path. */
  partIVA?: Form1701APartIVA;

  /** Part IV-B — Flat 8% computation. Populated only on flat-8% path. */
  partIVB?: Form1701APartIVB;

  /** Part IV-C — Tax credits */
  partIVC: Form1701APartIVC;

  /** Part II — Total tax payable */
  partII: Form1701APartII;

  /** COGS computation detail */
  cogsDetail?: COGSComputationResult;

  /** Reconciliation result vs quarterly outputs */
  reconciliation: ReconciliationResult;

  /** Whether this is an amended return */
  isAmended: boolean;
}

// =============================================================================
// ── FORM 1701A ADAPTER ────────────────────────────────────────────────────────
// =============================================================================

export class Form1701AAdapter extends AbstractBaseTaxAdapter<
  Form1701AContext,
  Form1701AOutput
> {
  // ── Identity ──────────────────────────────────────────────────────────────

  readonly formCode = "1701A" as const;
  readonly formTitle =
    "Annual Income Tax Return — Individuals Earning Income PURELY from Business/Profession";
  readonly filingFrequency = "annual" as const;

  readonly capabilities: AdapterCapabilities = {
    formCode: "1701A",
    formTitle:
      "Annual Income Tax Return — Individuals Earning Income PURELY from Business/Profession",
    filingFrequency: "annual",
    contextType: "period",
    requiresExpenses: false,
    requiresReceivedCertificates: false,
    requiresIssuedCertificates: false,
    requiresPriorPeriodOutputs: false, // recommended but not required
    requiredPriorFormCodes: [],        // 1701Q outputs are optional (reconciliation)
    validForEntityTypes: ["individual", "estate", "trust"],
    validForRegimes: undefined,
  };

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _config: Required<
    Omit<Form1701AAdapterConfig, "penalties" | "taxRateElectionOverride" | "deductionMethodOverride">
  > & {
    penalties?: Form1701APenalties;
    taxRateElectionOverride?: "graduated" | "flat-8-percent";
    deductionMethodOverride?: "osd" | "itemized";
  };

  constructor(config: Form1701AAdapterConfig = {}) {
    super();
    this._config = {
      taxRateElectionOverride: config.taxRateElectionOverride,
      deductionMethodOverride: config.deductionMethodOverride,
      businessType: config.businessType ?? "services",
      otherIncome: config.otherIncome ?? 0,
      gppIncome: config.gppIncome ?? 0,
      foreignTaxCredits: config.foreignTaxCredits ?? 0,
      otherTaxCredits: config.otherTaxCredits ?? 0,
      taxPaidAmended: config.taxPaidAmended ?? 0,
      isAmended: config.isAmended ?? false,
      paymentMode: config.paymentMode ?? "installment",
      hasCompensationIncome: config.hasCompensationIncome ?? false,
      reconciliationTolerance: config.reconciliationTolerance ?? 1.00,
      penalties: config.penalties,
    };
  }

  // ==========================================================================
  // ── ABSTRACT IMPLEMENTATIONS ───────────────────────────────────────────────
  // ==========================================================================

  protected _validateContext(ctx: Form1701AContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const profile = ctx.profile;
    const period = ctx.period;

    // Must be an annual period
    if (period) {
      const expectedStart = `${ctx.taxYear}-01-01`;
      const expectedEnd = `${ctx.taxYear}-12-31`;
      if (period.start !== expectedStart || period.end !== expectedEnd) {
        issues.push({
          severity: "warning",
          code: "A1701_PERIOD_NOT_ANNUAL",
          message:
            `1701A expects a full calendar year period ` +
            `(${expectedStart}–${expectedEnd}). ` +
            `Got ${period.start}–${period.end}. ` +
            `Use FilingPeriodHelper.annual(${ctx.taxYear}).`,
          field: "period",
        });
      }
    }

    // Rate election
    const rateElection = this._resolveRateElection(profile);
    if (!rateElection) {
      issues.push({
        severity: "error",
        code: "A1701_MISSING_RATE_ELECTION",
        message:
          "Tax rate election could not be resolved. Set profile.taxRateElection " +
          "or provide taxRateElectionOverride in adapter config.",
        field: "profile.taxRateElection",
      });
    }

    // Graduated needs deduction method
    if (rateElection === "graduated") {
      const deductionMethod = this._resolveDeductionMethod(profile);
      if (!deductionMethod) {
        issues.push({
          severity: "error",
          code: "A1701_MISSING_DEDUCTION_METHOD",
          message:
            "Graduated path requires deductionMethod ('osd' | 'itemized'). " +
            "Set profile.deductionMethod or deductionMethodOverride in config.",
          field: "profile.deductionMethod",
        });
      }

      // BIR COMPLIANCE: Form 1701A is ONLY for taxpayers using OSD or 8% flat rate.
      // Taxpayers who opt for Itemized Deductions must file the longer Form 1701 instead.
      // Reference: BIR Form 1701A title explicitly states
      // "Those under the graduated income tax rates with OSD as mode of deduction
      //  OR those who opted to avail of the 8% flat income tax rate"
      if (deductionMethod === "itemized") {
        issues.push({
          severity: "error",
          code: "A1701_ITEMIZED_NOT_ALLOWED",
          message:
            "Form 1701A does not support Itemized Deductions. " +
            "Form 1701A is exclusively for taxpayers using Optional Standard Deduction (OSD) " +
            "or the 8% flat income tax rate. " +
            "Taxpayers who opt for Itemized Deductions must file BIR Form 1701 instead. " +
            "Change profile.deductionMethod to 'osd' or use a Form1701Adapter.",
          field: "profile.deductionMethod",
          formItem: "Part IV-A",
        });
      }
    }

    // Flat 8% threshold check
    if (rateElection === "flat-8-percent") {
      const grossRevenues = AdapterComputationHelpers.sumGrossReceipts(
        ctx.invoices ?? [],
      );
      if (grossRevenues > 3_000_000) {
        issues.push({
          severity: "error",
          code: "A1701_EXCEEDS_8PCT_THRESHOLD",
          message:
            `Flat 8% rate requires gross receipts ≤ ₱3,000,000. ` +
            `Annual gross: ₱${grossRevenues.toLocaleString()}.`,
          field: "profile.taxRateElection",
        });
      }
    }

    // Amended return check
    if (this._config.isAmended && this._config.taxPaidAmended === 0) {
      issues.push({
        severity: "warning",
        code: "A1701_AMENDED_NO_PRIOR_PAYMENT",
        message:
          "isAmended is true but taxPaidAmended is 0. " +
          "Provide the previously paid amount via config.taxPaidAmended.",
        field: "taxPaidAmended",
      });
    }

    // Warn if no invoices at all
    if (!ctx.invoices || ctx.invoices.length === 0) {
      issues.push({
        severity: "warning",
        code: "A1701_NO_INVOICES",
        message:
          "No invoices found for the annual period. " +
          "All revenue figures will be zero.",
        field: "invoices",
      });
    }

    return issues;
  }

  protected _computeOutput(
    ctx: Form1701AContext,
  ): Omit<Form1701AOutput, "computedAt" | "validation"> {
    const profile = ctx.profile;
    const currency = ctx.currency;
    const invoices = ctx.invoices ?? [];
    const expenses = ctx.expenses ?? [];
    const priorOutputs = ctx.priorPeriodOutputs ?? [];

    const taxRateElection = this._resolveRateElection(profile)!;
    const deductionMethod =
      taxRateElection === "flat-8-percent"
        ? "osd"
        : this._resolveDeductionMethod(profile) ?? "osd";

    // ── COGS ────────────────────────────────────────────────────────────────
    let cogsTotal = 0;
    let cogsDetail: COGSComputationResult | undefined;

    if (ctx.cogsManager) {
      const cogsInvoices = this._toCogsInvoices(invoices);
      cogsDetail = ctx.cogsManager.compute(cogsInvoices, ctx.period.end);
      cogsTotal = cogsDetail.totalCOGS;
    }

    // ── Path A: direct computation ─────────────────────────────────────────
    const pathA = this._computeDirectPath({
      invoices,
      expenses,
      cogsTotal,
      profile,
      taxRateElection,
      deductionMethod,
      period: ctx.period,
    });

    // ── Extract quarterly 1701Q outputs ────────────────────────────────────
    const quarterlyOutputs = this._extractQuarterlyOutputs(priorOutputs);

    // ── Path B: quarterly aggregation ─────────────────────────────────────
    const pathB = quarterlyOutputs.length > 0
      ? this._aggregateQuarterlyOutputs(quarterlyOutputs)
      : null;

    // ── Reconciliation ────────────────────────────────────────────────────
    const reconciliation = this._reconcile(
      pathA,
      pathB,
      quarterlyOutputs,
    );

    // ── Build Part IV sections (Path A is authoritative) ──────────────────
    let partIVA: Form1701APartIVA | undefined;
    let partIVB: Form1701APartIVB | undefined;

    if (taxRateElection === "graduated") {
      partIVA = this._buildPartIVA(pathA, deductionMethod, expenses);
    } else {
      partIVB = this._buildPartIVB(pathA);
    }

    // ── Part IV-C: credits ─────────────────────────────────────────────────
    const partIVC = this._buildPartIVC({
      priorOutputs,
      quarterlyOutputs,
      receivedCertificates: ctx.receivedCertificates ?? [],
      taxDue: pathA.taxDue,
      taxYear: ctx.taxYear,
    });

    // ── Part II: total tax payable ─────────────────────────────────────────
    const partII = this._buildPartII({
      taxDue: pathA.taxDue,
      totalCredits: partIVC.totalCredits,
      penalties: this._config.penalties,
      paymentMode: this._config.paymentMode,
    });

    // ── Base output ────────────────────────────────────────────────────────
    const base = this._buildBaseOutput(ctx, {
      grossIncome: pathA.totalGrossIncome,
      taxDue: pathA.taxDue,
      taxCredits: partIVC.totalCredits,
      currency,
    });

    return {
      ...base,
      formCode: "1701A",
      taxYear: ctx.taxYear,
      taxRateElection,
      deductionMethod,
      partIVA,
      partIVB,
      partIVC,
      partII,
      cogsDetail,
      reconciliation,
      isAmended: this._config.isAmended,
    };
  }

  protected _buildFieldMap(
    output: Form1701AOutput,
  ): Record<string, number | string | boolean> {
    const map: Record<string, number | string | boolean> = {};

    // Part II
    map["20A"] = output.partII.taxDue;
    map["21A"] = output.partII.totalCredits;
    map["22A"] = output.partII.taxPayable;
    map["23A"] = output.partII.secondInstallmentPortion;
    map["24A"] = output.partII.amountDueUponFiling;
    map["25A"] = output.partII.surcharge;
    map["26A"] = output.partII.interest;
    map["27A"] = output.partII.compromise;
    map["28A"] = output.partII.totalPenalties;
    map["29A"] = output.partII.totalAmountPayable;
    map["30"]  = output.partII.aggregateAmountPayable;

    // Part IV-A (graduated)
    if (output.partIVA) {
      const a = output.partIVA;
      map["36A"] = a.grossRevenues;
      map["37A"] = a.salesReturnsAndDiscounts;
      map["38A"] = a.netSales;
      map["39A"] = a.deductions;
      map["40A"] = a.netIncome;
      map["41A"] = a.otherIncome;
      map["43A"] = a.gppIncome;
      map["44A"] = a.totalOtherIncome;
      map["45A"] = a.totalTaxableIncome;
      map["46A"] = a.taxDue;
    }

    // Part IV-B (flat 8%)
    if (output.partIVB) {
      const b = output.partIVB;
      map["47A"] = b.grossRevenues;
      map["48A"] = b.salesReturnsAndDiscounts;
      map["49A"] = b.netSales;
      map["50A"] = b.otherNonOperatingIncome;
      map["52A"] = b.totalOtherNonOperatingIncome;
      map["53A"] = b.totalTaxableIncome;
      map["54A"] = b.allowableDeduction;
      map["55A"] = b.taxableIncome;
      map["56A"] = b.taxDue;
    }

    // Part IV-C
    const c = output.partIVC;
    map["57A"] = c.priorYearExcessCredits;
    map["58A"] = c.firstThreeQuarterPayments;
    map["59A"] = c.cwtFirstThreeQuarters;
    map["60A"] = c.cwtQ4;
    map["61A"] = c.taxPaidAmended;
    map["62A"] = c.foreignTaxCredits;
    map["63A"] = c.otherTaxCredits;
    map["64A"] = c.totalCredits;
    map["65A"] = c.netTaxable;

    return map;
  }

  // ==========================================================================
  // ── PRIVATE: DIRECT PATH COMPUTATION ──────────────────────────────────────
  // ==========================================================================

  private _computeDirectPath(params: {
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>;
    expenses: ExpenseRecord[];
    cogsTotal: number;
    profile: TaxpayerProfile;
    taxRateElection: "graduated" | "flat-8-percent";
    deductionMethod: "osd" | "itemized";
    period: FilingPeriod;
  }): DirectPathResult {
    const {
      invoices, expenses, cogsTotal,
      taxRateElection, deductionMethod, period,
    } = params;

    const grossRevenues = AdapterComputationHelpers.sumNetRevenue(invoices);
    // Discount amounts already excluded in sumNetRevenue
    // salesReturnsAndDiscounts is tracked separately for the form display
    const grossReceipts = AdapterComputationHelpers.sumGrossReceipts(invoices);
    const salesReturnsAndDiscounts = Math.max(0, grossReceipts - grossRevenues);

    const netSales = grossRevenues;
    const costOfSales = cogsTotal;
    const grossIncomeFromOps = Math.max(0, netSales - costOfSales);

    const otherIncome = this._config.otherIncome;
    const gppIncome = this._config.gppIncome;
    const totalOtherIncome = otherIncome + gppIncome;
    const totalGrossIncome = grossIncomeFromOps + totalOtherIncome;

    // Deductions
    let deductions = 0;
    if (taxRateElection === "graduated") {
      if (deductionMethod === "osd") {
        deductions = AdapterComputationHelpers.computeOSD(netSales);
      } else {
        const itemized = AdapterComputationHelpers.sumItemizedDeductions(
          expenses,
          grossRevenues,
          this._config.businessType,
        );
        deductions = itemized.total;
      }
    }

    const netIncome = Math.max(0, totalGrossIncome - deductions);

    // Taxable income
    const totalTaxableIncome =
      taxRateElection === "graduated"
        ? netIncome
        : totalGrossIncome;

    // Tax due
    let taxDue = 0;
    if (taxRateElection === "graduated") {
      taxDue = AdapterComputationHelpers.applyGraduatedRateTable(
        totalTaxableIncome,
        period.year,
      );
    } else {
      taxDue = AdapterComputationHelpers.applyFlatEightPercent(
        totalGrossIncome,
        { hasCompensationIncome: this._config.hasCompensationIncome },
      );
    }

    return {
      grossRevenues,
      grossReceipts,
      salesReturnsAndDiscounts,
      netSales,
      costOfSales,
      grossIncomeFromOps,
      otherIncome,
      gppIncome,
      totalOtherIncome,
      totalGrossIncome,
      deductions,
      netIncome,
      totalTaxableIncome,
      taxDue,
    };
  }

  // ==========================================================================
  // ── PRIVATE: QUARTERLY AGGREGATION ────────────────────────────────────────
  // ==========================================================================

  private _extractQuarterlyOutputs(
    priorOutputs: BaseFilingOutput[],
  ): Form1701QOutput[] {
    return priorOutputs.filter(
      (o): o is Form1701QOutput => o.formCode === "1701Q",
    );
  }

  private _aggregateQuarterlyOutputs(
    outputs: Form1701QOutput[],
  ): QuarterlyAggregateResult {
    return outputs.reduce(
      (acc, q) => {
        const f = q.filer;
        return {
          grossRevenues: acc.grossRevenues + f.grossRevenues,
          totalGrossIncome: acc.totalGrossIncome + f.totalGrossIncome,
          deductions: acc.deductions + f.deductions,
          taxableIncome: acc.taxableIncome + f.taxableIncomeThisQuarter,
          taxDue: acc.taxDue + f.taxDue,
          totalCredits: acc.totalCredits + f.totalCredits,
          taxPayable: acc.taxPayable + f.totalAmountPayable,
        };
      },
      {
        grossRevenues: 0,
        totalGrossIncome: 0,
        deductions: 0,
        taxableIncome: 0,
        taxDue: 0,
        totalCredits: 0,
        taxPayable: 0,
      },
    );
  }

  // ==========================================================================
  // ── PRIVATE: RECONCILIATION ────────────────────────────────────────────────
  // ==========================================================================

  private _reconcile(
    pathA: DirectPathResult,
    pathB: QuarterlyAggregateResult | null,
    quarterlyOutputs: Form1701QOutput[],
  ): ReconciliationResult {
    const tolerance = this._config.reconciliationTolerance;
    const quartersPresent = quarterlyOutputs
      .map((q) => q.quarter)
      .sort() as (1 | 2 | 3 | 4)[];
    const allQuarters: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];
    const quartersMissing = allQuarters.filter(
      (q) => !quartersPresent.includes(q),
    );

    if (!pathB) {
      return {
        matched: true, // no quarterly data to compare against
        quartersFound: 0,
        quartersPresent: [],
        quartersMissing: allQuarters,
        fields: [],
        tolerance,
      };
    }

    const compareField = (
      field: string,
      direct: number,
      quarterly: number,
    ): ReconciliationFieldResult => {
      const difference = Math.abs(direct - quarterly);
      return {
        field,
        directAmount: direct,
        quarterlyAmount: quarterly,
        difference,
        matched: difference <= tolerance,
      };
    };

    const fields: ReconciliationFieldResult[] = [
      compareField("grossRevenues", pathA.grossRevenues, pathB.grossRevenues),
      compareField("totalGrossIncome", pathA.totalGrossIncome, pathB.totalGrossIncome),
      compareField("deductions", pathA.deductions, pathB.deductions),
      compareField("taxableIncome", pathA.totalTaxableIncome, pathB.taxableIncome),
      compareField("taxDue", pathA.taxDue, pathB.taxDue),
    ];

    return {
      matched: fields.every((f) => f.matched),
      quartersFound: quarterlyOutputs.length,
      quartersPresent,
      quartersMissing,
      fields,
      tolerance,
    };
  }

  // ==========================================================================
  // ── PRIVATE: PART BUILDERS ─────────────────────────────────────────────────
  // ==========================================================================

  private _buildPartIVA(
    pathA: DirectPathResult,
    deductionMethod: "osd" | "itemized",
    expenses: ExpenseRecord[],
  ): Form1701APartIVA {
    const deductionDetail: Form1701QDeductionDetail =
      deductionMethod === "osd"
        ? {
            method: "osd",
            osdRate: 0.40,
            osdBase: pathA.netSales,
            osdAmount: pathA.deductions,
          }
        : (() => {
            const itemized = AdapterComputationHelpers.sumItemizedDeductions(
              expenses,
              pathA.grossRevenues,
              this._config.businessType,
            );
            return {
              method: "itemized",
              itemizedTotal: pathA.deductions,
              representationAllowed: itemized.representationAllowed,
              representationCap: itemized.representationCap,
              breakdown: itemized.breakdown,
            };
          })();

    return {
      grossRevenues: pathA.grossRevenues,
      salesReturnsAndDiscounts: pathA.salesReturnsAndDiscounts,
      netSales: pathA.netSales,
      deductions: pathA.deductions,
      netIncome: pathA.netIncome,
      otherIncome: pathA.otherIncome,
      gppIncome: pathA.gppIncome,
      totalOtherIncome: pathA.totalOtherIncome,
      totalTaxableIncome: pathA.totalTaxableIncome,
      taxDue: pathA.taxDue,
      deductionDetail,
    };
  }

  private _buildPartIVB(pathA: DirectPathResult): Form1701APartIVB {
    const allowableDeduction = this._config.hasCompensationIncome
      ? 0
      : 250_000;
    const taxableIncome = Math.max(
      0,
      pathA.totalTaxableIncome - allowableDeduction,
    );

    return {
      grossRevenues: pathA.grossRevenues,
      salesReturnsAndDiscounts: pathA.salesReturnsAndDiscounts,
      netSales: pathA.netSales,
      otherNonOperatingIncome: pathA.otherIncome,
      totalOtherNonOperatingIncome: pathA.totalOtherIncome,
      totalTaxableIncome: pathA.totalTaxableIncome,
      allowableDeduction,
      taxableIncome,
      taxDue: pathA.taxDue,
    };
  }

  private _buildPartIVC(params: {
    priorOutputs: BaseFilingOutput[];
    quarterlyOutputs: Form1701QOutput[];
    receivedCertificates: Form2307Certificate[];
    taxDue: number;
    taxYear: number;
  }): Form1701APartIVC {
    const {
      priorOutputs, quarterlyOutputs,
      receivedCertificates, taxDue,
    } = params;

    // Item 57 — Prior year excess credits (from last year's 1701A)
    const priorYearExcessCredits =
      AdapterComputationHelpers.sumPriorYearExcessCredits(
        priorOutputs,
        "1701A",
      );

    // Item 58 — Tax payments for first three quarters
    // Sum of taxPayable from Q1, Q2, Q3 outputs
    const firstThreeQuarterPayments = quarterlyOutputs
      .filter((q) => q.quarter <= 3)
      .reduce((sum, q) => sum + q.filer.totalAmountPayable, 0);

    // Item 59 — CWT withheld first three quarters (Q1–Q3 certificates)
    const cwtFirstThreeQuarters = AdapterComputationHelpers.sumCwtCredits(
      receivedCertificates.filter(
        (c) => c.period.quarter !== undefined && c.period.quarter <= 3,
      ),
    );

    // Item 60 — CWT withheld Q4 per Form 2307
    const cwtQ4 = AdapterComputationHelpers.sumCwtCredits(
      receivedCertificates,
      4,
    );

    const taxPaidAmended = this._config.taxPaidAmended;
    const foreignTaxCredits = this._config.foreignTaxCredits;
    const otherTaxCredits = this._config.otherTaxCredits;

    const totalCredits =
      priorYearExcessCredits +
      firstThreeQuarterPayments +
      cwtFirstThreeQuarters +
      cwtQ4 +
      taxPaidAmended +
      foreignTaxCredits +
      otherTaxCredits;

    // Item 65 — Net Taxable/(Overpayment) = Item 20 (taxDue) - Item 64
    const netTaxable = taxDue - totalCredits;
    const isOverpayment = netTaxable < 0;

    return {
      priorYearExcessCredits,
      firstThreeQuarterPayments,
      cwtFirstThreeQuarters,
      cwtQ4,
      taxPaidAmended,
      foreignTaxCredits,
      otherTaxCredits,
      totalCredits,
      netTaxable: Math.abs(netTaxable),
      isOverpayment,
    };
  }

  private _buildPartII(params: {
    taxDue: number;
    totalCredits: number;
    penalties?: Form1701APenalties;
    paymentMode: "installment" | "full";
  }): Form1701APartII {
    const { taxDue, totalCredits, penalties, paymentMode } = params;

    // Item 22 — Tax Payable/(Overpayment)
    const netTax = taxDue - totalCredits;
    const isOverpayment = netTax < 0;
    const taxPayable = Math.max(0, netTax);
    const overpaymentAmount = Math.max(0, -netTax);

    // Items 23–24 — Installment split
    let secondInstallmentPortion = 0;
    let amountDueUponFiling = taxPayable;
    let secondInstallmentAmount = 0;

    if (!isOverpayment && paymentMode === "installment" && taxPayable > 0) {
      secondInstallmentPortion = Math.floor(taxPayable * 0.5 * 100) / 100;
      amountDueUponFiling = taxPayable - secondInstallmentPortion;
      secondInstallmentAmount = secondInstallmentPortion;
    }

    // Items 25–28 — Penalties
    const surcharge = penalties?.surcharge ?? 0;
    const interest = penalties?.interest ?? 0;
    const compromise = penalties?.compromise ?? 0;
    const totalPenalties = surcharge + interest + compromise;

    // Item 29 — Total Amount Payable
    const totalAmountPayable = isOverpayment
      ? 0
      : amountDueUponFiling + totalPenalties;

    return {
      taxDue,
      totalCredits,
      taxPayable,
      isOverpayment,
      overpaymentAmount,
      secondInstallmentPortion,
      amountDueUponFiling,
      secondInstallmentAmount,
      surcharge,
      interest,
      compromise,
      totalPenalties,
      totalAmountPayable,
      aggregateAmountPayable: totalAmountPayable, // no spouse annual aggregation
      paymentMode,
    };
  }

  // ==========================================================================
  // ── PRIVATE: HELPERS ───────────────────────────────────────────────────────
  // ==========================================================================

  private _resolveRateElection(
    profile: TaxpayerProfile,
  ): "graduated" | "flat-8-percent" | undefined {
    return this._config.taxRateElectionOverride ?? profile.taxRateElection;
  }

  private _resolveDeductionMethod(
    profile: TaxpayerProfile,
  ): "osd" | "itemized" | undefined {
    return this._config.deductionMethodOverride ?? profile.deductionMethod;
  }

  private _toCogsInvoices(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
  ): COGSInvoiceInput[] {
    return invoices
      .filter(
        (inv): inv is ResolvedInvoice =>
          !("kind" in inv && inv.kind === "raw-summary"),
      )
      .map((inv) => ({
        id: inv.id,
        issueDate: inv.issueDate,
        currency: inv.currency,
        lineItems:
          (inv as any).lineItems?.map((li: any) => ({
            id: li.id,
            description: li.description,
            quantity: li.quantity,
            lineTotalAmount: li.lineTotalAmount,
            currency: inv.currency,
            skuId: li.skuId ?? li.metadata?.skuId,
            metadata: li.metadata,
          })) ?? [],
      }));
  }
}

// =============================================================================
// ── INTERNAL COMPUTATION TYPES ────────────────────────────────────────────────
// =============================================================================

interface DirectPathResult {
  grossRevenues: number;
  grossReceipts: number;
  salesReturnsAndDiscounts: number;
  netSales: number;
  costOfSales: number;
  grossIncomeFromOps: number;
  otherIncome: number;
  gppIncome: number;
  totalOtherIncome: number;
  totalGrossIncome: number;
  deductions: number;
  netIncome: number;
  totalTaxableIncome: number;
  taxDue: number;
}

interface QuarterlyAggregateResult {
  grossRevenues: number;
  totalGrossIncome: number;
  deductions: number;
  taxableIncome: number;
  taxDue: number;
  totalCredits: number;
  taxPayable: number;
}