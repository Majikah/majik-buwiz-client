/**
 * @file form-1701q.ts
 * @description Form1701QAdapter — BIR Form 1701Q
 * Quarterly Income Tax Return for Self-Employed Individuals, Estates and Trusts.
 *
 * Supports:
 *   - Graduated income tax rates (Part IV-A)
 *   - Flat 8% income tax rate (Part IV-B)
 *   - OSD (40% of net sales) and Itemized deductions
 *   - COGS via COGSManager
 *   - Both Taxpayer/Filer (A) and optional Spouse (B) columns
 *   - Quarter-to-date accumulation from prior 1701Q outputs
 *   - CWT credits from Form 2307 certificates
 *   - Optional penalty computation (surcharge, interest, compromise)
 *
 * Valid for: individual, estate, trust entity types
 * Tax regime: any (income tax is regime-agnostic)
 *
 * Usage:
 * ```ts
 * const adapter = new Form1701QAdapter({ quarter: 1 });
 *
 * const ta = TaxAccountant.init({
 *   adapter,
 *   context: await FilingContextBuilder.from({
 *     profile,
 *     period: FilingPeriodHelper.q1(2024),
 *     taxYear: 2024,
 *     currency: "PHP",
 *     invoices: majikInvoices,
 *     expenses: myExpenses,
 *     cogsManager,
 *     receivedCertificates: form2307s,
 *   }).build(),
 * });
 *
 * const output = ta.prepare();
 * console.log(output.items["41A"]); // Total Amount Payable
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
  RawInvoiceSummary,
  ResolvedInvoice,
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
import { ExpenseRecord } from "../../../expenses/expense-record";

// =============================================================================
// ── FORM 1701Q CONTEXT EXTENSION ──────────────────────────────────────────────
// =============================================================================

/**
 * PeriodFilingContext extended with COGSManager.
 * COGSManager sits alongside expenses — both are cost-side inputs.
 */
export interface Form1701QContext extends PeriodFilingContext {
  cogsManager?: COGSManager;
}

// =============================================================================
// ── FORM 1701Q ADAPTER CONFIG ─────────────────────────────────────────────────
// =============================================================================

/**
 * Penalty details — all optional, default to zero.
 * Provided when filing an amended or late return.
 */
export interface Form1701QPenalties {
  /** 25% surcharge on basic tax due (Item 40A) */
  surcharge?: number;
  /** 12% interest per annum pro-rated (Item 40C) */
  interest?: number;
  /** Compromise penalty per BIR schedule (Item 40E) */
  compromise?: number;
}

/**
 * Spouse column data — optional.
 * When provided, the adapter computes both A and B columns
 * and adds Item 41C (aggregate).
 */
export interface Form1701QSpouseData {
  /** Spouse's gross revenues from their own business/practice */
  grossRevenues: number;
  /** Spouse's GPP income if applicable (Item 27B) */
  gppIncome?: number;
  /** Spouse's cost of sales/services — from spouse's own COGS */
  costOfSales?: number;
  /** Spouse's other income (Item 31B) */
  otherIncome?: number;
  /** Spouse's deductions — OSD or itemized total */
  deductions?: number;
  /** Prior year excess credits attributable to spouse (Item 38B) */
  priorYearExcessCredits?: number;
  /** Spouse's CWT credits for previous quarters (Item 38F) */
  cwtPreviousQuarters?: number;
  /** Spouse's CWT credits this quarter from Form 2307 (Item 38H) */
  cwtThisQuarter?: number;
  /** Tax paid on previously filed amended return (Item 38J) */
  taxPaidAmended?: number;
  /** Other payments via BIR Form 0605 (Item 38L) */
  otherPayments?: number;
  /** Spouse penalties if filing amended (Item 40B, 40D, 40F) */
  penalties?: Form1701QPenalties;
}

/**
 * Configuration for Form1701QAdapter.
 * Set once at construction — immutable per adapter instance.
 */
export interface Form1701QAdapterConfig {
  /** Which quarter this return covers (1–4) */
  quarter: 1 | 2 | 3 | 4;

  /**
   * Tax rate election override.
   * If provided, overrides profile.taxRateElection for this computation.
   * Use this when you want to compare both paths without changing the profile.
   */
  taxRateElectionOverride?: "graduated" | "flat-8-percent";

  /**
   * Business type — affects representation expense deductibility cap.
   * "goods"    → 0.5% of net sales
   * "services" → 1.0% of net sales (default for professionals)
   * "mixed"    → 0.75% average
   * Default: "services"
   */
  businessType?: "goods" | "services" | "mixed";

  /**
   * Item 27 — Amount received/share in income from a General Professional
   * Partnership (GPP). Not from invoices — declared separately.
   */
  gppIncome?: number;

  /**
   * Item 31 — Other non-operating income not captured in invoices.
   * E.g. interest income, rental income from personal property.
   */
  otherIncome?: number;

  /**
   * Item 38I — Tax paid in return previously filed (amended returns only).
   */
  taxPaidAmended?: number;

  /**
   * Item 38K — Other payments made via BIR Form 0605.
   */
  otherPayments?: number;

  /**
   * Whether this is an amended return.
   * When true, taxPaidAmended should be provided.
   */
  isAmended?: boolean;

  /**
   * Spouse column data — optional.
   * When provided, the adapter computes both A and B columns.
   */
  spouseData?: Form1701QSpouseData;

  /**
   * Penalty details — default to zero.
   * Provide when filing a late or amended return.
   */
  penalties?: Form1701QPenalties;

  /**
   * Whether the taxpayer has compensation income in addition to
   * business/professional income.
   * Affects the ₱250,000 exemption on the flat 8% path.
   * Default: false
   */
  hasCompensationIncome?: boolean;
}

// =============================================================================
// ── FORM 1701Q OUTPUT ─────────────────────────────────────────────────────────
// =============================================================================

/**
 * Column values — used for both A (filer) and B (spouse) columns.
 */
export interface Form1701QColumn {
  // ── Part II — Declaration This Quarter ────────────────────────────────────
  /** Item 26 — Sales/Revenues/Receipts/Fees */
  grossRevenues: number;
  /** Item 27 — GPP income */
  gppIncome: number;
  /** Item 28 — Total (26 + 27) */
  totalRevenues: number;
  /** Item 29 — Less: Cost of Sales/Service */
  costOfSales: number;
  /** Item 30 — Gross Income from Operation (28 - 29) */
  grossIncomeFromOperations: number;
  /** Item 31 — Add: Other Income */
  otherIncome: number;
  /** Item 32 — Total Gross Income (30 + 31) */
  totalGrossIncome: number;
  /** Item 33 — Less: Deductions */
  deductions: number;
  /** Item 34 — Taxable Income This Quarter (32 - 33) */
  taxableIncomeThisQuarter: number;
  /** Item 35 — Add: Taxable Income Previous Quarter(s) */
  taxableIncomePreviousQuarters: number;
  /** Item 36 — Taxable Income To Date (34 + 35) */
  taxableIncomeToDate: number;
  /** Item 37 — Tax Due */
  taxDue: number;

  // ── Item 38 — Tax Credits/Payments ────────────────────────────────────────
  /** Item 38A — Prior Year's Excess Credits */
  priorYearExcessCredits: number;
  /** Item 38C — Tax Payments for Previous Quarter(s) */
  priorQuarterPayments: number;
  /** Item 38E — Creditable Tax Withheld Previous Quarter(s) */
  cwtPreviousQuarters: number;
  /** Item 38G — Creditable Tax Withheld per Form 2307 This Quarter */
  cwtThisQuarter: number;
  /** Item 38I — Tax Paid in Return Previously Filed (amended) */
  taxPaidAmended: number;
  /** Item 38K — Other Payments (BIR Form 0605) */
  otherPayments: number;
  /** Item 38M — Total Tax Credits/Payments */
  totalCredits: number;

  // ── Items 39–41 ───────────────────────────────────────────────────────────
  /** Item 39 — Tax Payable/(Overpayment) */
  taxPayableOrOverpayment: number;
  isOverpayment: boolean;

  /** Item 40 — Penalties */
  surcharge: number;
  interest: number;
  compromise: number;
  totalPenalties: number;

  /** Item 41 — Total Amount Payable */
  totalAmountPayable: number;
}

/**
 * Deduction breakdown — for audit trail and display.
 */
export interface Form1701QDeductionDetail {
  method: "osd" | "itemized";
  osdRate?: number;
  osdBase?: number;
  osdAmount?: number;
  itemizedTotal?: number;
  representationAllowed?: number;
  representationCap?: number;
  breakdown?: Record<string, number>;
}

/**
 * Full typed output of Form1701QAdapter.
 * Extends BaseFilingOutput with all 1701Q-specific fields.
 */
export interface Form1701QOutput extends BaseFilingOutput {
  formCode: "1701Q";

  /** Which quarter this return covers */
  quarter: 1 | 2 | 3 | 4;

  /** Tax rate election used for this computation */
  taxRateElection: "graduated" | "flat-8-percent";

  /** Deduction method used */
  deductionMethod: "osd" | "itemized";

  /** Taxpayer/Filer column (A) */
  filer: Form1701QColumn;

  /** Spouse column (B) — only present when spouseData was provided */
  spouse?: Form1701QColumn;

  /** Item 41C — Aggregate Amount Payable (41A + 41B) */
  aggregateAmountPayable: number;

  /** COGS computation detail — for audit trail */
  cogsDetail?: COGSComputationResult;

  /** Deduction detail — for audit trail */
  deductionDetail: Form1701QDeductionDetail;

  /** Whether this is an amended return */
  isAmended: boolean;
}

// =============================================================================
// ── FORM 1701Q ADAPTER ────────────────────────────────────────────────────────
// =============================================================================

export class Form1701QAdapter extends AbstractBaseTaxAdapter<
  Form1701QContext,
  Form1701QOutput
> {
  // ── Identity ──────────────────────────────────────────────────────────────

  readonly formCode = "1701Q" as const;
  readonly formTitle =
    "Quarterly Income Tax Return for Self-Employed Individuals, Estates and Trusts";
  readonly filingFrequency = "quarterly" as const;

  readonly capabilities: AdapterCapabilities = {
    formCode: "1701Q",
    formTitle:
      "Quarterly Income Tax Return for Self-Employed Individuals, Estates and Trusts",
    filingFrequency: "quarterly",
    contextType: "period",
    requiresExpenses: false, // only required on itemized path
    requiresReceivedCertificates: false,
    requiresIssuedCertificates: false,
    requiresPriorPeriodOutputs: false, // Q1 has none; Q2+ should have them
    requiredPriorFormCodes: [], // filled dynamically based on quarter
    validForEntityTypes: ["individual", "estate", "trust"],
    validForRegimes: undefined, // income tax is regime-agnostic
  };

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _config: Required<
    Omit<
      Form1701QAdapterConfig,
      "spouseData" | "penalties" | "taxRateElectionOverride"
    >
  > & {
    spouseData?: Form1701QSpouseData;
    penalties?: Form1701QPenalties;
    taxRateElectionOverride?: "graduated" | "flat-8-percent";
  };

  constructor(config: Form1701QAdapterConfig) {
    super();

    if (!config.quarter || ![1, 2, 3, 4].includes(config.quarter)) {
      throw new Error(
        `Form1701QAdapter: quarter must be 1, 2, 3, or 4. Got: ${config.quarter}`,
      );
    }

    this._config = {
      quarter: config.quarter,
      taxRateElectionOverride: config.taxRateElectionOverride,
      businessType: config.businessType ?? "services",
      gppIncome: config.gppIncome ?? 0,
      otherIncome: config.otherIncome ?? 0,
      taxPaidAmended: config.taxPaidAmended ?? 0,
      otherPayments: config.otherPayments ?? 0,
      isAmended: config.isAmended ?? false,
      hasCompensationIncome: config.hasCompensationIncome ?? false,
      spouseData: config.spouseData,
      penalties: config.penalties,
    };

    // Q2+ should warn if no prior outputs — update capabilities dynamically
    if (config.quarter > 1) {
      this.capabilities.requiredPriorFormCodes = ["1701Q"];
    }
  }

  // ==========================================================================
  // ── ABSTRACT IMPLEMENTATIONS ───────────────────────────────────────────────
  // ==========================================================================

  protected _validateContext(ctx: Form1701QContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const profile = ctx.profile;
    const period = ctx.period;

    // Quarter must match period
    if (
      period?.quarter !== undefined &&
      period.quarter !== this._config.quarter
    ) {
      issues.push({
        severity: "error",
        code: "Q1701_QUARTER_MISMATCH",
        message:
          `Adapter is configured for Q${this._config.quarter} but ` +
          `context period is Q${period.quarter}. ` +
          `Ensure FilingPeriodHelper.quarter(year, ${this._config.quarter}) ` +
          `was used when building the context.`,
        field: "period.quarter",
      });
    }

    // Rate election must be resolvable
    const rateElection = this._resolveRateElection(profile);
    if (!rateElection) {
      issues.push({
        severity: "error",
        code: "Q1701_MISSING_RATE_ELECTION",
        message:
          "Tax rate election could not be resolved. Set profile.taxRateElection " +
          "or provide taxRateElectionOverride in adapter config.",
        field: "profile.taxRateElection",
      });
    }

    // Graduated path needs deduction method
    if (rateElection === "graduated" && !profile.deductionMethod) {
      issues.push({
        severity: "error",
        code: "Q1701_MISSING_DEDUCTION_METHOD",
        message:
          "Graduated tax path requires profile.deductionMethod " +
          "('osd' | 'itemized'). Set it on TaxpayerProfile.",
        field: "profile.deductionMethod",
      });
    }

    // Itemized path needs expenses
    if (
      rateElection === "graduated" &&
      profile.deductionMethod === "itemized" &&
      (!ctx.expenses || ctx.expenses.length === 0)
    ) {
      issues.push({
        severity: "warning",
        code: "Q1701_NO_EXPENSES_ITEMIZED",
        message:
          "Deduction method is 'itemized' but no expenses were provided. " +
          "Itemized deductions will be zero. " +
          "Consider using OSD or providing ExpenseEntry[] in the context.",
        field: "expenses",
      });
    }

    // Amended return should have taxPaidAmended
    if (this._config.isAmended && this._config.taxPaidAmended === 0) {
      issues.push({
        severity: "warning",
        code: "Q1701_AMENDED_NO_PRIOR_PAYMENT",
        message:
          "isAmended is true but taxPaidAmended is 0. " +
          "Provide the tax paid on the originally filed return via " +
          "adapter config taxPaidAmended.",
        field: "taxPaidAmended",
      });
    }

    // Q2+ without prior period outputs
    if (
      this._config.quarter > 1 &&
      (!ctx.priorPeriodOutputs || ctx.priorPeriodOutputs.length === 0)
    ) {
      issues.push({
        severity: "warning",
        code: "Q1701_MISSING_PRIOR_QUARTERS",
        message:
          `Q${this._config.quarter} filing should include prior quarter outputs ` +
          `for accurate year-to-date accumulation (Items 35 and 38C). ` +
          `Pass prior 1701Q outputs in context.priorPeriodOutputs or ` +
          `register them in the FilingChain before calling prepare().`,
        field: "priorPeriodOutputs",
      });
    }

    // Flat 8% — check gross receipts threshold (₱3M)
    if (rateElection === "flat-8-percent") {
      const ytdRevenue = AdapterComputationHelpers.sumGrossReceipts(
        ctx.invoices ?? [],
      );
      if (ytdRevenue > 3_000_000) {
        issues.push({
          severity: "error",
          code: "Q1701_EXCEEDS_8PCT_THRESHOLD",
          message:
            `Flat 8% rate is only available for taxpayers with gross receipts ` +
            `not exceeding ₱3,000,000. Year-to-date gross receipts ` +
            `(₱${ytdRevenue.toLocaleString()}) exceed this threshold. ` +
            `Switch to the graduated rate.`,
          field: "profile.taxRateElection",
        });
      }
    }

    return issues;
  }

  protected _computeOutput(
    ctx: Form1701QContext,
  ): Omit<Form1701QOutput, "computedAt" | "validation"> {
    const profile = ctx.profile;
    const currency = ctx.currency;
    const invoices = ctx.invoices ?? [];
    const expenses = ctx.expenses ?? [];
    const priorOutputs = ctx.priorPeriodOutputs ?? [];

    const taxRateElection = this._resolveRateElection(profile)!;
    const deductionMethod =
      taxRateElection === "flat-8-percent"
        ? "osd" // flat 8% doesn't use deductions
        : (profile.deductionMethod ?? "osd");

    // ── COGS ────────────────────────────────────────────────────────────────
    let cogsTotal = 0;
    let cogsDetail: COGSComputationResult | undefined;

    if (ctx.cogsManager) {
      const cogsInvoices = this._toCogsInvoices(invoices);
      cogsDetail = ctx.cogsManager.compute(cogsInvoices, ctx.period.end);
      cogsTotal = cogsDetail.totalCOGS;
    }

    // ── Filer column (A) ────────────────────────────────────────────────────
    const filerColumn = this._computeColumn({
      invoices,
      expenses,
      priorOutputs,
      cogsTotal,
      profile,
      taxRateElection,
      deductionMethod,
      period: ctx.period,
      gppIncome: this._config.gppIncome,
      otherIncome: this._config.otherIncome,
      priorYearExcessCredits:
        AdapterComputationHelpers.sumPriorYearExcessCredits(
          priorOutputs,
          "1701A",
        ),
      receivedCertificates: ctx.receivedCertificates ?? [],
      taxPaidAmended: this._config.taxPaidAmended,
      otherPayments: this._config.otherPayments,
      penalties: this._config.penalties,
    });

    // ── Spouse column (B) ───────────────────────────────────────────────────
    let spouseColumn: Form1701QColumn | undefined;

    if (this._config.spouseData) {
      spouseColumn = this._computeSpouseColumn(
        this._config.spouseData,
        priorOutputs,
        ctx.taxYear,
      );
    }

    // ── Item 41C — Aggregate ────────────────────────────────────────────────
    const aggregateAmountPayable =
      filerColumn.totalAmountPayable + (spouseColumn?.totalAmountPayable ?? 0);

    // ── Deduction detail ────────────────────────────────────────────────────
    const deductionDetail = this._buildDeductionDetail(
      deductionMethod,
      filerColumn,
      expenses,
    );

    // ── Base output fields ──────────────────────────────────────────────────
    const base = this._buildBaseOutput(ctx, {
      grossIncome: filerColumn.totalGrossIncome,
      taxDue: filerColumn.taxDue,
      taxCredits: filerColumn.totalCredits,
      currency,
    });

    return {
      ...base,
      formCode: "1701Q",
      quarter: this._config.quarter,
      taxRateElection,
      deductionMethod,
      filer: filerColumn,
      spouse: spouseColumn,
      aggregateAmountPayable,
      cogsDetail,
      deductionDetail,
      isAmended: this._config.isAmended,
    };
  }

  protected _buildFieldMap(
    output: Form1701QOutput,
  ): Record<string, number | string | boolean> {
    const f = output.filer;
    const s = output.spouse;

    const map: Record<string, number | string | boolean> = {
      // Filer column
      "26A": f.grossRevenues,
      "27A": f.gppIncome,
      "28A": f.totalRevenues,
      "29A": f.costOfSales,
      "30A": f.grossIncomeFromOperations,
      "31A": f.otherIncome,
      "32A": f.totalGrossIncome,
      "33A": f.deductions,
      "34A": f.taxableIncomeThisQuarter,
      "35A": f.taxableIncomePreviousQuarters,
      "36A": f.taxableIncomeToDate,
      "37A": f.taxDue,
      "38A": f.priorYearExcessCredits,
      "38C": f.priorQuarterPayments,
      "38E": f.cwtPreviousQuarters,
      "38G": f.cwtThisQuarter,
      "38I": f.taxPaidAmended,
      "38K": f.otherPayments,
      "38M": f.totalCredits,
      "39A": f.taxPayableOrOverpayment,
      "40A": f.surcharge,
      "40C": f.interest,
      "40E": f.compromise,
      "40G": f.totalPenalties,
      "41A": f.totalAmountPayable,
    };

    // Spouse column — only if computed
    if (s) {
      map["26B"] = s.grossRevenues;
      map["27B"] = s.gppIncome;
      map["28B"] = s.totalRevenues;
      map["29B"] = s.costOfSales;
      map["30B"] = s.grossIncomeFromOperations;
      map["31B"] = s.otherIncome;
      map["32B"] = s.totalGrossIncome;
      map["33B"] = s.deductions;
      map["34B"] = s.taxableIncomeThisQuarter;
      map["35B"] = s.taxableIncomePreviousQuarters;
      map["36B"] = s.taxableIncomeToDate;
      map["37B"] = s.taxDue;
      map["38B"] = s.priorYearExcessCredits;
      map["38D"] = s.priorQuarterPayments;
      map["38F"] = s.cwtPreviousQuarters;
      map["38H"] = s.cwtThisQuarter;
      map["38J"] = s.taxPaidAmended;
      map["38L"] = s.otherPayments;
      map["38N"] = s.totalCredits;
      map["39B"] = s.taxPayableOrOverpayment;
      map["40B"] = s.surcharge;
      map["40D"] = s.interest;
      map["40F"] = s.compromise;
      map["40H"] = s.totalPenalties;
      map["41B"] = s.totalAmountPayable;
    }

    map["41C"] = output.aggregateAmountPayable;

    return map;
  }

  // ==========================================================================
  // ── PRIVATE COMPUTATION ────────────────────────────────────────────────────
  // ==========================================================================

  private _computeColumn(params: {
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>;
    expenses: ExpenseRecord[];
    priorOutputs: BaseFilingOutput[];
    cogsTotal: number;
    profile: TaxpayerProfile;
    taxRateElection: "graduated" | "flat-8-percent";
    deductionMethod: "osd" | "itemized";
    period: FilingPeriod;
    gppIncome: number;
    otherIncome: number;
    priorYearExcessCredits: number;
    receivedCertificates: Form2307Certificate[];
    taxPaidAmended: number;
    otherPayments: number;
    penalties?: Form1701QPenalties;
  }): Form1701QColumn {
    const {
      invoices,
      expenses,
      priorOutputs,
      cogsTotal,
      taxRateElection,
      deductionMethod,
      period,
      gppIncome,
      otherIncome,
      priorYearExcessCredits,
      receivedCertificates,
      taxPaidAmended,
      otherPayments,
      penalties,
    } = params;

    // ── Items 26–32 ──────────────────────────────────────────────────────────
    const grossRevenues = AdapterComputationHelpers.sumNetRevenue(invoices);
    const totalRevenues = grossRevenues + gppIncome;
    const costOfSales = cogsTotal;
    const grossIncomeFromOperations = Math.max(0, totalRevenues - costOfSales);
    const totalGrossIncome = grossIncomeFromOperations + otherIncome;

    // ── Item 33 — Deductions ──────────────────────────────────────────────
    let deductions = 0;

    if (taxRateElection === "graduated") {
      if (deductionMethod === "osd") {
        deductions = AdapterComputationHelpers.computeOSD(totalGrossIncome);
      } else {
        const itemized = AdapterComputationHelpers.sumItemizedDeductions(
          expenses,
          grossRevenues,
          this._config.businessType,
        );
        deductions = itemized.total;
      }
    }
    // flat-8%: deductions stay 0 — rate already accounts for it

    // ── Items 34–36 — Taxable income accumulation ─────────────────────────
    const taxableIncomeThisQuarter = Math.max(0, totalGrossIncome - deductions);

    const taxableIncomePreviousQuarters =
      AdapterComputationHelpers.sumPriorQuarterTaxableIncome(
        priorOutputs,
        "1701Q",
        period.year,
      );

    const taxableIncomeToDate =
      taxableIncomeThisQuarter + taxableIncomePreviousQuarters;

    // ── Item 37 — Tax Due ────────────────────────────────────────────────
    let taxDue = 0;

    if (taxRateElection === "graduated") {
      taxDue = AdapterComputationHelpers.applyGraduatedRateTable(
        taxableIncomeToDate,
        period.year,
      );
    } else {
      taxDue = AdapterComputationHelpers.applyFlatEightPercent(
        totalGrossIncome + otherIncome,
        { hasCompensationIncome: this._config.hasCompensationIncome },
      );
    }

    // ── Items 38A–38M — Credits ────────────────────────────────────────────
    const priorQuarterPayments =
      AdapterComputationHelpers.sumPriorQuarterlyPayments(
        priorOutputs,
        "1701Q",
        period.year,
      );

    // CWT from certificates — split by quarter
    const currentQuarter = this._config.quarter;
    const cwtThisQuarter = AdapterComputationHelpers.sumCwtCredits(
      receivedCertificates,
      currentQuarter,
    );

    // CWT from all previous quarters this year
    const cwtPreviousQuarters = AdapterComputationHelpers.sumCwtCredits(
      receivedCertificates.filter(
        (c) =>
          c.period.quarter !== undefined && c.period.quarter < currentQuarter,
      ),
    );

    const totalCredits =
      priorYearExcessCredits +
      priorQuarterPayments +
      cwtPreviousQuarters +
      cwtThisQuarter +
      taxPaidAmended +
      otherPayments;

    // ── Item 39 — Tax Payable / Overpayment ───────────────────────────────
    const netTax = taxDue - totalCredits;
    const taxPayableOrOverpayment = Math.abs(netTax);
    const isOverpayment = netTax < 0;

    // ── Item 40 — Penalties ───────────────────────────────────────────────
    const surcharge = penalties?.surcharge ?? 0;
    const interest = penalties?.interest ?? 0;
    const compromise = penalties?.compromise ?? 0;
    const totalPenalties = surcharge + interest + compromise;

    // ── Item 41 — Total Amount Payable ────────────────────────────────────
    const totalAmountPayable = isOverpayment
      ? 0
      : taxPayableOrOverpayment + totalPenalties;

    return {
      grossRevenues,
      gppIncome,
      totalRevenues,
      costOfSales,
      grossIncomeFromOperations,
      otherIncome,
      totalGrossIncome,
      deductions,
      taxableIncomeThisQuarter,
      taxableIncomePreviousQuarters,
      taxableIncomeToDate,
      taxDue,
      priorYearExcessCredits,
      priorQuarterPayments,
      cwtPreviousQuarters,
      cwtThisQuarter,
      taxPaidAmended,
      otherPayments,
      totalCredits,
      taxPayableOrOverpayment,
      isOverpayment,
      surcharge,
      interest,
      compromise,
      totalPenalties,
      totalAmountPayable,
    };
  }

  private _computeSpouseColumn(
    data: Form1701QSpouseData,
    _priorOutputs: BaseFilingOutput[],
    taxYear: number,
  ): Form1701QColumn {
    // Spouse column uses manually provided data — no invoice processing
    const grossRevenues = data.grossRevenues;
    const gppIncome = data.gppIncome ?? 0;
    const totalRevenues = grossRevenues + gppIncome;
    const costOfSales = data.costOfSales ?? 0;
    const grossIncomeFromOperations = Math.max(0, totalRevenues - costOfSales);
    const otherIncome = data.otherIncome ?? 0;
    const totalGrossIncome = grossIncomeFromOperations + otherIncome;
    const deductions = data.deductions ?? 0;
    const taxableIncomeThisQuarter = Math.max(0, totalGrossIncome - deductions);

    // Spouse prior quarters from their own prior outputs
    // (we don't have spouse-specific prior outputs — use provided value)
    const taxableIncomePreviousQuarters = 0;
    const taxableIncomeToDate =
      taxableIncomeThisQuarter + taxableIncomePreviousQuarters;

    const taxDue = AdapterComputationHelpers.applyGraduatedRateTable(
      taxableIncomeToDate,
      taxYear,
    );

    const priorYearExcessCredits = data.priorYearExcessCredits ?? 0;
    const priorQuarterPayments = 0;
    const cwtPreviousQuarters = data.cwtPreviousQuarters ?? 0;
    const cwtThisQuarter = data.cwtThisQuarter ?? 0;
    const taxPaidAmended = data.taxPaidAmended ?? 0;
    const otherPayments = data.otherPayments ?? 0;

    const totalCredits =
      priorYearExcessCredits +
      priorQuarterPayments +
      cwtPreviousQuarters +
      cwtThisQuarter +
      taxPaidAmended +
      otherPayments;

    const netTax = taxDue - totalCredits;
    const taxPayableOrOverpayment = Math.abs(netTax);
    const isOverpayment = netTax < 0;

    const surcharge = data.penalties?.surcharge ?? 0;
    const interest = data.penalties?.interest ?? 0;
    const compromise = data.penalties?.compromise ?? 0;
    const totalPenalties = surcharge + interest + compromise;

    const totalAmountPayable = isOverpayment
      ? 0
      : taxPayableOrOverpayment + totalPenalties;

    return {
      grossRevenues,
      gppIncome,
      totalRevenues,
      costOfSales,
      grossIncomeFromOperations,
      otherIncome,
      totalGrossIncome,
      deductions,
      taxableIncomeThisQuarter,
      taxableIncomePreviousQuarters,
      taxableIncomeToDate,
      taxDue,
      priorYearExcessCredits,
      priorQuarterPayments,
      cwtPreviousQuarters,
      cwtThisQuarter,
      taxPaidAmended,
      otherPayments,
      totalCredits,
      taxPayableOrOverpayment,
      isOverpayment,
      surcharge,
      interest,
      compromise,
      totalPenalties,
      totalAmountPayable,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _resolveRateElection(
    profile: TaxpayerProfile,
  ): "graduated" | "flat-8-percent" | undefined {
    return (
      this._config.taxRateElectionOverride ??
      profile.taxRateElection ??
      undefined
    );
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

  private _buildDeductionDetail(
    method: "osd" | "itemized",
    column: Form1701QColumn,
    expenses: ExpenseRecord[],
  ): Form1701QDeductionDetail {
    if (method === "osd") {
      return {
        method: "osd",
        osdRate: 0.4,
        osdBase: column.totalGrossIncome,
        osdAmount: column.deductions,
      };
    }

    const itemized = AdapterComputationHelpers.sumItemizedDeductions(
      expenses,
      column.grossRevenues,
      this._config.businessType,
    );

    return {
      method: "itemized",
      itemizedTotal: column.deductions,
      representationAllowed: itemized.representationAllowed,
      representationCap: itemized.representationCap,
      breakdown: itemized.breakdown,
    };
  }
}
