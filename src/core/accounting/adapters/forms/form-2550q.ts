/**
 * @file form-2550q.ts
 * @description Form2550QAdapter — BIR Form 2550Q
 * Quarterly Value-Added Tax Return.
 *
 * Computation strategy — dual-path with reconciliation (mirrors 1701A):
 *
 *   Path A (Direct) — always runs
 *     Re-processes all invoices and expenses for the full quarter.
 *     Uses same VAT classification and amortization logic as Form2550MAdapter.
 *     Authoritative source for output figures.
 *
 *   Path B (Monthly aggregation) — runs when 2550M outputs are available
 *     Sums the up-to-3 Form2550MFilingOutput instances from priorPeriodOutputs
 *     or FilingChain for the current quarter's months.
 *     Capital goods input VAT inherited from monthly outputs (no re-amortization).
 *
 *   Reconciliation layer — runs when both paths have data
 *     Compares Path A vs Path B field by field.
 *     Tolerance: ₱1.00. Never throws — warnings only.
 *
 *   Part IV — Monthly payment credit
 *     VAT already paid via monthly 2550M returns is credited against
 *     the quarterly VAT payable. Only the balance (if any) is due.
 *
 * Valid for: any entity type
 * Tax regime: vat only
 *
 * Usage:
 * ```ts
 * const adapter = new Form2550QAdapter({ quarter: 1 });
 *
 * const ta = TaxAccountant.init({
 *   adapter,
 *   context: await FilingContextBuilder.from({
 *     profile,
 *     period: FilingPeriodHelper.q1(2024),
 *     taxYear: 2024,
 *     currency: "PHP",
 *     invoices: q1Invoices,
 *     expenses: q1Expenses,
 *     priorPeriodOutputs: [jan2550M, feb2550M, mar2550M, priorQ4_2550Q],
 *   }).build(),
 * });
 *
 * const output = ta.prepare();
 * console.log(output.partIV.balanceVatPayable); // net after monthly payments
 * console.log(output.reconciliation.matched);
 * ```
 */

import { ExpenseRecord } from "../../../expenses/expense-record";
import type {
  AdapterCapabilities,
  FilingPeriod,
  PeriodFilingContext,
  BaseFilingOutput,
  ValidationIssue,
  ResolvedInvoice,
  RawInvoiceSummary,
} from "../../types";

import {
  AbstractBaseTaxAdapter,
  AdapterComputationHelpers,
} from "../base-adapter";

import type {
  Form2550MFilingOutput,
  VATClassification,
  InputVATBreakdown,
  InputVATPurchaseType,
  VATSalesBreakdown,
  CapitalGoodsAmortizationConfig,
  VATWithheldConfig,
  Form2550MPenalties,
} from "./form-2550m";

// =============================================================================
// ── RECONCILIATION TYPES (reused pattern from 1701A) ──────────────────────────
// =============================================================================

export interface VATReconciliationFieldResult {
  field: string;
  directAmount: number;
  monthlyAmount: number;
  difference: number;
  matched: boolean;
}

export interface VATReconciliationResult {
  matched: boolean;
  monthsFound: number;
  monthsPresent: number[];
  monthsMissing: number[];
  fields: VATReconciliationFieldResult[];
  tolerance: number;
}

// =============================================================================
// ── ADAPTER CONFIG ────────────────────────────────────────────────────────────
// =============================================================================

export interface Form2550QAdapterConfig {
  /** Which quarter this return covers (1–4) */
  quarter: 1 | 2 | 3 | 4;

  /**
   * Capital goods amortization config for direct path computation.
   * When monthly 2550M outputs are available, amortization is inherited
   * from those outputs unless forceRecomputeAmortization is true.
   * Default: threshold ₱1M, 60 months
   */
  capitalGoodsConfig?: CapitalGoodsAmortizationConfig;

  /**
   * When true, re-applies amortization computation from expenses
   * even when monthly 2550M outputs are available.
   * Default: false — inherit from monthly outputs
   */
  forceRecomputeAmortization?: boolean;

  /** VAT withheld on government money payments */
  vatWithheld?: VATWithheldConfig;

  /** Penalties for late filing */
  penalties?: Form2550MPenalties;

  /** Whether this is an amended return */
  isAmended?: boolean;

  /** Tax paid on previously filed return (amended only) */
  taxPaidAmended?: number;

  /**
   * Reconciliation diff tolerance in PHP.
   * Default: 1.00
   */
  reconciliationTolerance?: number;
}

// =============================================================================
// ── OUTPUT TYPES ──────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Part I — Output VAT (quarterly totals).
 * Same structure as 2550M Part I but covers 3 months.
 */
export interface Form2550QPartI {
  vatableSales: VATSalesBreakdown;
  zeroRatedSales: VATSalesBreakdown;
  exemptSales: VATSalesBreakdown;
  totalSales: number;
  totalOutputVat: number;
  /** Monthly breakdown for audit trail */
  byMonth?: {
    month: number;
    vatableSales: number;
    outputVat: number;
    zeroRatedSales: number;
    exemptSales: number;
  }[];
}

/**
 * Part II — Input VAT (quarterly totals).
 */
export interface Form2550QPartII {
  /**
   * Excess input VAT from the prior quarter's 2550Q
   * or the last month of the prior quarter's 2550M.
   */
  beginningExcessInputVat: number;
  currentInputVat: InputVATBreakdown;
  totalAvailableInputVat: number;
  inputVatOnExemptSales: number;
  inputVatOnZeroRatedSales: number;
  netCreditableInputVat: number;
  /**
   * Whether capital goods input VAT was inherited from
   * monthly outputs or re-computed directly.
   */
  capitalGoodsSource: "inherited-from-monthly" | "direct-computation";
}

/**
 * Part III — VAT Payable (before monthly payment credit).
 */
export interface Form2550QPartIII {
  outputVat: number;
  creditableInputVat: number;
  vatWithheldOnGoods: number;
  vatWithheldOnServices: number;
  totalVatWithheld: number;
  vatPayable: number;
  excessInputVat: number;
  isExcessInput: boolean;
}

/**
 * Part IV — Summary with monthly payment credit.
 *
 * The quarterly return credits back VAT already remitted via
 * monthly 2550M filings. Only the balance is due upon quarterly filing.
 */
export interface Form2550QPartIV {
  /** Gross quarterly VAT payable from Part III */
  grossVatPayable: number;
  /**
   * Less: VAT already paid via monthly 2550M returns.
   * Sum of partIV.totalAmountDue across the 3 monthly outputs.
   * Zero if no monthly outputs available.
   */
  monthlyPaymentsAlreadyMade: number;
  /**
   * Monthly payment breakdown for audit trail.
   */
  monthlyPaymentBreakdown: {
    month: number;
    amountPaid: number;
  }[];
  /**
   * Balance VAT payable = grossVatPayable - monthlyPaymentsAlreadyMade.
   * Can be zero or negative (overpayment on monthly basis).
   */
  balanceVatPayable: number;
  isOverpayment: boolean;
  overpaymentAmount: number;
  /** Amended return credit */
  taxPaidAmended: number;
  surcharge: number;
  interest: number;
  compromise: number;
  totalPenalties: number;
  totalAmountDue: number;
}

/**
 * Full typed output of Form2550QAdapter.
 */
export interface Form2550QFilingOutput extends BaseFilingOutput {
  formCode: "2550Q";
  quarter: 1 | 2 | 3 | 4;
  taxYear: number;
  partI: Form2550QPartI;
  partII: Form2550QPartII;
  partIII: Form2550QPartIII;
  partIV: Form2550QPartIV;
  reconciliation: VATReconciliationResult;
  isAmended: boolean;
  capitalGoodsConfig: Required<CapitalGoodsAmortizationConfig>;
}

// =============================================================================
// ── FORM 2550Q ADAPTER ────────────────────────────────────────────────────────
// =============================================================================

export class Form2550QAdapter extends AbstractBaseTaxAdapter<
  PeriodFilingContext,
  Form2550QFilingOutput
> {
  // ── Identity ──────────────────────────────────────────────────────────────

  readonly formCode = "2550Q" as const;
  readonly formTitle = "Quarterly Value-Added Tax Return";
  readonly filingFrequency = "quarterly" as const;

  readonly capabilities: AdapterCapabilities = {
    formCode: "2550Q",
    formTitle: "Quarterly Value-Added Tax Return",
    filingFrequency: "quarterly",
    contextType: "period",
    requiresExpenses: false,
    requiresReceivedCertificates: false,
    requiresIssuedCertificates: false,
    requiresPriorPeriodOutputs: false,
    requiredPriorFormCodes: [],
    validForEntityTypes: undefined,
    validForRegimes: ["vat"],
  };

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _quarter: 1 | 2 | 3 | 4;
  private readonly _amortizationThreshold: number;
  private readonly _amortizationMonths: number;
  private readonly _forceRecomputeAmortization: boolean;
  private readonly _vatWithheld: Required<VATWithheldConfig>;
  private readonly _penalties: Form2550MPenalties | undefined;
  private readonly _isAmended: boolean;
  private readonly _taxPaidAmended: number;
  private readonly _reconciliationTolerance: number;

  constructor(config: Form2550QAdapterConfig) {
    super();

    if (!config.quarter || ![1, 2, 3, 4].includes(config.quarter)) {
      throw new Error(
        `Form2550QAdapter: quarter must be 1, 2, 3, or 4. Got: ${config.quarter}`,
      );
    }

    this._quarter = config.quarter;
    this._amortizationThreshold =
      config.capitalGoodsConfig?.amortizationThreshold ?? 1_000_000;
    this._amortizationMonths =
      config.capitalGoodsConfig?.amortizationMonths ?? 60;
    this._forceRecomputeAmortization =
      config.forceRecomputeAmortization ?? false;
    this._vatWithheld = {
      vatWithheldOnGoods: config.vatWithheld?.vatWithheldOnGoods ?? 0,
      vatWithheldOnServices: config.vatWithheld?.vatWithheldOnServices ?? 0,
    };
    this._penalties = config.penalties;
    this._isAmended = config.isAmended ?? false;
    this._taxPaidAmended = config.taxPaidAmended ?? 0;
    this._reconciliationTolerance = config.reconciliationTolerance ?? 1.0;
  }

  // ==========================================================================
  // ── ABSTRACT IMPLEMENTATIONS ───────────────────────────────────────────────
  // ==========================================================================

  protected _validateContext(ctx: PeriodFilingContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Must be a quarterly period
    if (ctx.period?.quarter === undefined) {
      issues.push({
        severity: "error",
        code: "VAT2550Q_NOT_QUARTERLY",
        message:
          "Form 2550Q requires a quarterly filing period. " +
          `Use FilingPeriodHelper.quarter(year, ${this._quarter}).`,
        field: "period",
      });
    } else if (ctx.period.quarter !== this._quarter) {
      issues.push({
        severity: "error",
        code: "VAT2550Q_QUARTER_MISMATCH",
        message:
          `Adapter configured for Q${this._quarter} but ` +
          `context period is Q${ctx.period.quarter}.`,
        field: "period.quarter",
      });
    }

    // VAT regime check
    if (ctx.profile.taxRegime !== "vat") {
      issues.push({
        severity: "error",
        code: "VAT2550Q_WRONG_REGIME",
        message:
          `Form 2550Q is only for VAT-registered taxpayers. ` +
          `Profile taxRegime is "${ctx.profile.taxRegime}".`,
        field: "profile.taxRegime",
      });
    }

    // Warn if no invoices
    if (!ctx.invoices || ctx.invoices.length === 0) {
      issues.push({
        severity: "warning",
        code: "VAT2550Q_NO_INVOICES",
        message: "No invoices found for this quarter. Output VAT will be zero.",
        field: "invoices",
      });
    }

    // Amended check
    if (this._isAmended && this._taxPaidAmended === 0) {
      issues.push({
        severity: "warning",
        code: "VAT2550Q_AMENDED_NO_PRIOR",
        message:
          "isAmended is true but taxPaidAmended is 0. " +
          "Provide the previously paid amount via config.taxPaidAmended.",
        field: "taxPaidAmended",
      });
    }

    return issues;
  }

  protected _computeOutput(
    ctx: PeriodFilingContext,
  ): Omit<Form2550QFilingOutput, "computedAt" | "validation"> {
    const invoices = ctx.invoices ?? [];
    const expenses = ctx.expenses ?? [];
    const priorOutputs = ctx.priorPeriodOutputs ?? [];
    const currency = ctx.currency;

    // ── Extract monthly 2550M outputs for this quarter ─────────────────────
    const monthlyOutputs = this._extractMonthlyOutputs(
      priorOutputs,
      ctx.taxYear,
    );

    // ── Determine the 3 calendar months of this quarter ───────────────────
    const quarterMonths = this._getQuarterMonths(this._quarter);

    // ── Path A: direct computation ────────────────────────────────────────
    const pathA = this._computeDirectPath(
      invoices,
      expenses,
      ctx.period,
      monthlyOutputs,
    );

    // ── Path B: monthly aggregation ───────────────────────────────────────
    const pathB =
      monthlyOutputs.length > 0
        ? this._aggregateMonthlyOutputs(monthlyOutputs)
        : null;

    // ── Reconciliation ────────────────────────────────────────────────────
    const reconciliation = this._reconcile(
      pathA,
      pathB,
      monthlyOutputs,
      quarterMonths,
    );

    // ── Beginning excess input VAT ────────────────────────────────────────
    // Priority: last month of prior quarter's 2550M → prior quarter's 2550Q
    const beginningExcessInputVat =
      AdapterComputationHelpers.getPriorExcessInputVat(priorOutputs, [
        "2550M",
        "2550Q",
      ]);

    // ── Build Part I (Path A authoritative) ──────────────────────────────
    const partI = this._buildPartI(pathA, monthlyOutputs, quarterMonths);

    // ── Determine capital goods source ────────────────────────────────────
    const capitalGoodsSource: Form2550QPartII["capitalGoodsSource"] =
      !this._forceRecomputeAmortization && monthlyOutputs.length > 0
        ? "inherited-from-monthly"
        : "direct-computation";

    // ── Build Part II ─────────────────────────────────────────────────────
    const partII = this._buildPartII(
      pathA,
      beginningExcessInputVat,
      partI,
      capitalGoodsSource,
    );

    // ── Build Part III ────────────────────────────────────────────────────
    const partIII = this._buildPartIII(partI, partII);

    // ── Build Part IV (with monthly payment credit) ───────────────────────
    const partIV = this._buildPartIV(
      partIII.vatPayable,
      monthlyOutputs,
      quarterMonths,
    );

    // ── Base output ───────────────────────────────────────────────────────
    const base = this._buildBaseOutput(ctx, {
      grossIncome: partI.totalSales,
      taxDue: partIII.vatPayable,
      taxCredits: partII.netCreditableInputVat + partIII.totalVatWithheld,
      currency,
    });

    return {
      ...base,
      formCode: "2550Q",
      quarter: this._quarter,
      taxYear: ctx.taxYear,
      partI,
      partII,
      partIII,
      partIV,
      reconciliation,
      isAmended: this._isAmended,
      capitalGoodsConfig: {
        amortizationThreshold: this._amortizationThreshold,
        amortizationMonths: this._amortizationMonths,
      },
      fieldMap: {
        excessInputVat: partIII.excessInputVat,
      },
    };
  }

  protected _buildFieldMap(
    output: Form2550QFilingOutput,
  ): Record<string, number | string | boolean> {
    const p1 = output.partI;
    const p2 = output.partII;
    const p3 = output.partIII;
    const p4 = output.partIV;

    return {
      // Part I
      vatableSales: p1.vatableSales.amount,
      vatableSalesOutputVat: p1.vatableSales.outputVat,
      zeroRatedSales: p1.zeroRatedSales.amount,
      exemptSales: p1.exemptSales.amount,
      totalSales: p1.totalSales,
      totalOutputVat: p1.totalOutputVat,

      // Part II
      beginningExcessInputVat: p2.beginningExcessInputVat,
      inputVatCapitalGoods: p2.currentInputVat.totalCapitalGoods,
      inputVatGoodsOtherCapital: p2.currentInputVat.totalGoodsOtherThanCapital,
      inputVatServices: p2.currentInputVat.totalServices,
      totalCurrentInputVat: p2.currentInputVat.totalCurrentInputVat,
      totalAvailableInputVat: p2.totalAvailableInputVat,
      inputVatOnExemptSales: p2.inputVatOnExemptSales,
      netCreditableInputVat: p2.netCreditableInputVat,
      capitalGoodsSource: p2.capitalGoodsSource,

      // Part III
      outputVat: p3.outputVat,
      creditableInputVat: p3.creditableInputVat,
      vatWithheldGoods: p3.vatWithheldOnGoods,
      vatWithheldServices: p3.vatWithheldOnServices,
      totalVatWithheld: p3.totalVatWithheld,
      vatPayable: p3.vatPayable,
      excessInputVat: p3.excessInputVat,

      // Part IV
      grossVatPayable: p4.grossVatPayable,
      monthlyPaymentsAlreadyMade: p4.monthlyPaymentsAlreadyMade,
      balanceVatPayable: p4.balanceVatPayable,
      totalAmountDue: p4.totalAmountDue,
    };
  }

  // ==========================================================================
  // ── PRIVATE: DIRECT PATH ──────────────────────────────────────────────────
  // ==========================================================================

  private _computeDirectPath(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
    expenses: ExpenseRecord[],
    period: FilingPeriod,
    monthlyOutputs: Form2550MFilingOutput[],
  ): DirectPathResult {
    // ── Output VAT by classification ──────────────────────────────────────
    let vatableSalesAmount = 0;
    let vatableSalesOutputVat = 0;
    let zeroRatedSalesAmount = 0;
    let exemptSalesAmount = 0;

    for (const inv of invoices) {
      const classification = this._classifyInvoice(inv);
      const totalAmount = this._getInvoiceAmount(inv, "total");
      const vatAmount = this._getInvoiceAmount(inv, "vat");

      switch (classification) {
        case "vatable":
          vatableSalesAmount += totalAmount - vatAmount;
          vatableSalesOutputVat += vatAmount;
          break;
        case "zero-rated":
          zeroRatedSalesAmount += totalAmount;
          break;
        case "exempt":
          exemptSalesAmount += totalAmount;
          break;
      }
    }

    const totalSales =
      vatableSalesAmount + zeroRatedSalesAmount + exemptSalesAmount;
    const totalOutputVat = vatableSalesOutputVat;

    // ── Input VAT by purchase type ────────────────────────────────────────
    // When not forcing re-computation and monthly outputs are available,
    // inherit capital goods input VAT from monthly outputs
    const useMonthlyCapitalGoods =
      !this._forceRecomputeAmortization && monthlyOutputs.length > 0;

    let totalCapitalGoods = 0;
    let totalGoodsOtherThanCapital = 0;
    let totalServices = 0;

    if (useMonthlyCapitalGoods) {
      // Inherit capital goods from monthly outputs
      totalCapitalGoods = monthlyOutputs.reduce(
        (sum, m) => sum + m.partII.currentInputVat.totalCapitalGoods,
        0,
      );
      // Re-compute non-capital and services from expenses
      for (const exp of expenses) {
        if (!exp.bir?.inputVatAmount || exp.bir.inputVatAmount <= 0) continue;
        if (exp.bir.vatClassification === "non-creditable") continue;
        const purchaseType = this._resolvePurchaseType(exp);
        if (purchaseType === "goods-other-than-capital") {
          totalGoodsOtherThanCapital += exp.bir.inputVatAmount;
        } else if (purchaseType === "services") {
          totalServices += exp.bir.inputVatAmount;
        }
        // capital-goods skipped — inherited from monthly
      }
    } else {
      // Full direct computation with amortization
      for (const exp of expenses) {
        if (!exp.bir?.inputVatAmount || exp.bir.inputVatAmount <= 0) continue;
        if (exp.bir.vatClassification === "non-creditable") continue;
        const purchaseType = this._resolvePurchaseType(exp);
        const creditable = this._computeCreditableInputVat(
          exp,
          purchaseType,
          period,
        );
        switch (purchaseType) {
          case "capital-goods":
            totalCapitalGoods += creditable;
            break;
          case "goods-other-than-capital":
            totalGoodsOtherThanCapital += creditable;
            break;
          case "services":
            totalServices += creditable;
            break;
        }
      }
    }

    const totalCurrentInputVat =
      totalCapitalGoods + totalGoodsOtherThanCapital + totalServices;

    return {
      vatableSalesAmount,
      vatableSalesOutputVat,
      zeroRatedSalesAmount,
      exemptSalesAmount,
      totalSales,
      totalOutputVat,
      totalCapitalGoods,
      totalGoodsOtherThanCapital,
      totalServices,
      totalCurrentInputVat,
    };
  }

  // ==========================================================================
  // ── PRIVATE: MONTHLY AGGREGATION ─────────────────────────────────────────
  // ==========================================================================

  private _extractMonthlyOutputs(
    priorOutputs: BaseFilingOutput[],
    taxYear: number,
  ): Form2550MFilingOutput[] {
    const quarterMonths = this._getQuarterMonths(this._quarter);
    return priorOutputs.filter(
      (o): o is Form2550MFilingOutput =>
        o.formCode === "2550M" &&
        o.taxYear === taxYear &&
        "month" in o &&
        quarterMonths.includes((o as Form2550MFilingOutput).month),
    );
  }

  private _aggregateMonthlyOutputs(
    outputs: Form2550MFilingOutput[],
  ): MonthlyAggregateResult {
    return outputs.reduce(
      (acc, m) => ({
        vatableSalesAmount:
          acc.vatableSalesAmount + m.partI.vatableSales.amount,
        vatableSalesOutputVat:
          acc.vatableSalesOutputVat + m.partI.vatableSales.outputVat,
        zeroRatedSalesAmount:
          acc.zeroRatedSalesAmount + m.partI.zeroRatedSales.amount,
        exemptSalesAmount: acc.exemptSalesAmount + m.partI.exemptSales.amount,
        totalOutputVat: acc.totalOutputVat + m.partI.totalOutputVat,
        totalCurrentInputVat:
          acc.totalCurrentInputVat +
          m.partII.currentInputVat.totalCurrentInputVat,
        netCreditableInputVat:
          acc.netCreditableInputVat + m.partII.netCreditableInputVat,
        vatPayable: acc.vatPayable + m.partIII.vatPayable,
      }),
      {
        vatableSalesAmount: 0,
        vatableSalesOutputVat: 0,
        zeroRatedSalesAmount: 0,
        exemptSalesAmount: 0,
        totalOutputVat: 0,
        totalCurrentInputVat: 0,
        netCreditableInputVat: 0,
        vatPayable: 0,
      },
    );
  }

  // ==========================================================================
  // ── PRIVATE: RECONCILIATION ───────────────────────────────────────────────
  // ==========================================================================

  private _reconcile(
    pathA: DirectPathResult,
    pathB: MonthlyAggregateResult | null,
    monthlyOutputs: Form2550MFilingOutput[],
    quarterMonths: number[],
  ): VATReconciliationResult {
    const tolerance = this._reconciliationTolerance;
    const monthsPresent = monthlyOutputs.map((m) => m.month).sort();
    const monthsMissing = quarterMonths.filter(
      (m) => !monthsPresent.includes(m),
    );

    if (!pathB) {
      return {
        matched: true,
        monthsFound: 0,
        monthsPresent: [],
        monthsMissing: quarterMonths,
        fields: [],
        tolerance,
      };
    }

    const compare = (
      field: string,
      direct: number,
      monthly: number,
    ): VATReconciliationFieldResult => {
      const difference = Math.abs(direct - monthly);
      return {
        field,
        directAmount: direct,
        monthlyAmount: monthly,
        difference,
        matched: difference <= tolerance,
      };
    };

    const fields: VATReconciliationFieldResult[] = [
      compare(
        "vatableSales",
        pathA.vatableSalesAmount,
        pathB.vatableSalesAmount,
      ),
      compare("outputVat", pathA.totalOutputVat, pathB.totalOutputVat),
      compare(
        "zeroRatedSales",
        pathA.zeroRatedSalesAmount,
        pathB.zeroRatedSalesAmount,
      ),
      compare("exemptSales", pathA.exemptSalesAmount, pathB.exemptSalesAmount),
      compare(
        "totalCurrentInputVat",
        pathA.totalCurrentInputVat,
        pathB.totalCurrentInputVat,
      ),
    ];

    return {
      matched: fields.every((f) => f.matched),
      monthsFound: monthlyOutputs.length,
      monthsPresent,
      monthsMissing,
      fields,
      tolerance,
    };
  }

  // ==========================================================================
  // ── PRIVATE: PART BUILDERS ────────────────────────────────────────────────
  // ==========================================================================

  private _buildPartI(
    pathA: DirectPathResult,
    monthlyOutputs: Form2550MFilingOutput[],
    quarterMonths: number[],
  ): Form2550QPartI {
    const byMonth =
      monthlyOutputs.length > 0
        ? quarterMonths.map((month) => {
            const mo = monthlyOutputs.find((m) => m.month === month);
            return {
              month,
              vatableSales: mo?.partI.vatableSales.amount ?? 0,
              outputVat: mo?.partI.vatableSales.outputVat ?? 0,
              zeroRatedSales: mo?.partI.zeroRatedSales.amount ?? 0,
              exemptSales: mo?.partI.exemptSales.amount ?? 0,
            };
          })
        : undefined;

    return {
      vatableSales: {
        amount: pathA.vatableSalesAmount,
        outputVat: pathA.vatableSalesOutputVat,
      },
      zeroRatedSales: {
        amount: pathA.zeroRatedSalesAmount,
        outputVat: 0,
      },
      exemptSales: {
        amount: pathA.exemptSalesAmount,
        outputVat: 0,
      },
      totalSales: pathA.totalSales,
      totalOutputVat: pathA.totalOutputVat,
      byMonth,
    };
  }

  private _buildPartII(
    pathA: DirectPathResult,
    beginningExcessInputVat: number,
    partI: Form2550QPartI,
    capitalGoodsSource: Form2550QPartII["capitalGoodsSource"],
  ): Form2550QPartII {
    // Build a minimal InputVATBreakdown from direct path totals
    const currentInputVat: InputVATBreakdown = {
      capitalGoods: [], // entries omitted at quarterly level
      goodsOtherThanCapital: [],
      services: [],
      totalCapitalGoods: pathA.totalCapitalGoods,
      totalGoodsOtherThanCapital: pathA.totalGoodsOtherThanCapital,
      totalServices: pathA.totalServices,
      totalCurrentInputVat: pathA.totalCurrentInputVat,
    };

    const totalAvailableInputVat =
      beginningExcessInputVat + pathA.totalCurrentInputVat;

    // Apportion non-creditable input VAT on exempt sales
    let inputVatOnExemptSales = 0;
    if (partI.totalSales > 0 && partI.exemptSales.amount > 0) {
      const exemptRatio = partI.exemptSales.amount / partI.totalSales;
      inputVatOnExemptSales = totalAvailableInputVat * exemptRatio;
    }

    const netCreditableInputVat = Math.max(
      0,
      totalAvailableInputVat - inputVatOnExemptSales,
    );

    return {
      beginningExcessInputVat,
      currentInputVat,
      totalAvailableInputVat,
      inputVatOnExemptSales,
      inputVatOnZeroRatedSales: 0,
      netCreditableInputVat,
      capitalGoodsSource,
    };
  }

  private _buildPartIII(
    partI: Form2550QPartI,
    partII: Form2550QPartII,
  ): Form2550QPartIII {
    const outputVat = partI.totalOutputVat;
    const creditableInputVat = partII.netCreditableInputVat;
    const vatWithheldOnGoods = this._vatWithheld.vatWithheldOnGoods;
    const vatWithheldOnServices = this._vatWithheld.vatWithheldOnServices;
    const totalVatWithheld = vatWithheldOnGoods + vatWithheldOnServices;

    const { vatPayable, excessInputVat, isExcessInput } =
      AdapterComputationHelpers.computeVatPayable({
        outputVat,
        inputVat: creditableInputVat,
        priorExcessInputVat: 0,
      });

    const finalVatPayable = Math.max(0, vatPayable - totalVatWithheld);
    const finalExcessInputVat = isExcessInput
      ? excessInputVat + totalVatWithheld
      : Math.max(0, totalVatWithheld - vatPayable);

    return {
      outputVat,
      creditableInputVat,
      vatWithheldOnGoods,
      vatWithheldOnServices,
      totalVatWithheld,
      vatPayable: finalVatPayable,
      excessInputVat: finalExcessInputVat,
      isExcessInput: finalVatPayable === 0,
    };
  }

  private _buildPartIV(
    grossVatPayable: number,
    monthlyOutputs: Form2550MFilingOutput[],
    quarterMonths: number[],
  ): Form2550QPartIV {
    // Credit back VAT already remitted via monthly 2550M returns
    const monthlyPaymentBreakdown = quarterMonths.map((month) => {
      const mo = monthlyOutputs.find((m) => m.month === month);
      return {
        month,
        amountPaid: mo?.partIV.totalAmountDue ?? 0,
      };
    });

    const monthlyPaymentsAlreadyMade = monthlyPaymentBreakdown.reduce(
      (sum, m) => sum + m.amountPaid,
      0,
    );

    const net = grossVatPayable - monthlyPaymentsAlreadyMade;
    const isOverpayment = net < 0;
    const balanceVatPayable = Math.max(0, net);
    const overpaymentAmount = Math.max(0, -net);

    const surcharge = this._penalties?.surcharge ?? 0;
    const interest = this._penalties?.interest ?? 0;
    const compromise = this._penalties?.compromise ?? 0;
    const totalPenalties = surcharge + interest + compromise;

    const totalAmountDue = isOverpayment
      ? 0
      : Math.max(0, balanceVatPayable - this._taxPaidAmended + totalPenalties);

    return {
      grossVatPayable,
      monthlyPaymentsAlreadyMade,
      monthlyPaymentBreakdown,
      balanceVatPayable,
      isOverpayment,
      overpaymentAmount,
      taxPaidAmended: this._taxPaidAmended,
      surcharge,
      interest,
      compromise,
      totalPenalties,
      totalAmountDue,
    };
  }

  // ==========================================================================
  // ── PRIVATE: HELPERS (mirrors Form2550MAdapter) ───────────────────────────
  // ==========================================================================

  private _getQuarterMonths(quarter: 1 | 2 | 3 | 4): number[] {
    return {
      1: [1, 2, 3],
      2: [4, 5, 6],
      3: [7, 8, 9],
      4: [10, 11, 12],
    }[quarter];
  }

  private _classifyInvoice(
    inv: ResolvedInvoice | RawInvoiceSummary,
  ): VATClassification {
    const isRaw = "kind" in inv && inv.kind === "raw-summary";

    if (!isRaw) {
      const resolved = inv as ResolvedInvoice;
      const metaClass = (resolved as any).metadata?.vatClassification;
      if (metaClass) return metaClass as VATClassification;

      const lineItems: any[] = (resolved as any).lineItems ?? [];
      if (lineItems.length > 0) {
        for (const line of lineItems) {
          const taxes = line.taxes;

          if (taxes.hasTaxType("vat")) {
            const vatTax = taxes.getByType("vat")!;
            return vatTax.rate >= 0.12 ? "vatable" : "zero-rated";
          }

          // Check metadata override at line level
          const lineMeta = line.metadata?.vatClassification;
          if (lineMeta) return lineMeta as VATClassification;
        }
      }

      if ((resolved as any).taxAmount > 0) return "vatable";
    }

    const raw = inv as RawInvoiceSummary;
    if (raw.vatAmount > 0) return "vatable";
    return "exempt";
  }

  private _getInvoiceAmount(
    inv: ResolvedInvoice | RawInvoiceSummary,
    field: "total" | "vat",
  ): number {
    if ("kind" in inv && inv.kind === "raw-summary") {
      const raw = inv as RawInvoiceSummary;
      return field === "total" ? raw.grossAmount : raw.vatAmount;
    }
    const resolved = inv as ResolvedInvoice;
    return field === "total" ? resolved.totalAmount : resolved.taxAmount;
  }

  private _resolvePurchaseType(exp: ExpenseRecord): InputVATPurchaseType {
    if (exp.bir?.purchaseType) return exp.bir.purchaseType;
    if (exp.bir?.isDepreciation) return "capital-goods";
    switch (exp.category) {
      case "cost-of-sales":
      case "supplies":
        return "goods-other-than-capital";
      case "depreciation":
        return "capital-goods";
      default:
        return "services";
    }
  }

  private _computeCreditableInputVat(
    exp: ExpenseRecord,
    purchaseType: InputVATPurchaseType,
    period: FilingPeriod,
  ): number {
    const totalInputVat = exp.bir?.inputVatAmount ?? 0;
    // ── TRAIN Law compliance: amortization abolished from Jan 1, 2022 ──────
    // RMC 21-2022: capital goods purchased on/after Jan 1, 2022 → outright claim.
    // Capital goods purchased before Jan 1, 2022 → legacy amortization continues.
    const AMORTIZATION_CUTOFF = "2022-01-01";
    if (exp.expenseDate >= AMORTIZATION_CUTOFF || purchaseType !== "capital-goods") {
      return totalInputVat; // full outright claim
    }

    // Pre-2022 large capital good: continue legacy amortization
    const isLargeCapital = exp.totalAmount > this._amortizationThreshold;
    if (!isLargeCapital) return totalInputVat;

    const purchaseDate = new Date(exp.expenseDate);
    const periodStart = new Date(period.start);
    const monthsElapsed =
      (periodStart.getFullYear() - purchaseDate.getFullYear()) * 12 +
      (periodStart.getMonth() - purchaseDate.getMonth()) +
      1;

    // For quarterly: credit 3 months' worth if all 3 fall within window
    let creditableMonths = 0;
    for (let m = 0; m < 3; m++) {
      const month = monthsElapsed + m;
      if (month >= 1 && month <= this._amortizationMonths) {
        creditableMonths++;
      }
    }

    return (totalInputVat / this._amortizationMonths) * creditableMonths;
  }
}

// =============================================================================
// ── INTERNAL TYPES ────────────────────────────────────────────────────────────
// =============================================================================

interface DirectPathResult {
  vatableSalesAmount: number;
  vatableSalesOutputVat: number;
  zeroRatedSalesAmount: number;
  exemptSalesAmount: number;
  totalSales: number;
  totalOutputVat: number;
  totalCapitalGoods: number;
  totalGoodsOtherThanCapital: number;
  totalServices: number;
  totalCurrentInputVat: number;
}

interface MonthlyAggregateResult {
  vatableSalesAmount: number;
  vatableSalesOutputVat: number;
  zeroRatedSalesAmount: number;
  exemptSalesAmount: number;
  totalOutputVat: number;
  totalCurrentInputVat: number;
  netCreditableInputVat: number;
  vatPayable: number;
}
