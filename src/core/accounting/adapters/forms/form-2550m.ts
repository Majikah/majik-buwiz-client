import { LineItem } from "@majikah/majik-invoice";
import type {
  AdapterCapabilities,
  FilingPeriod,
  PeriodFilingContext,
  ValidationIssue,
  ResolvedInvoice,
  RawInvoiceSummary,
  BaseFilingOutput,
} from "../../types";

import {
  AbstractBaseTaxAdapter,
  AdapterComputationHelpers,
} from "../base-adapter";
import { ExpenseRecord } from "../../../expenses/expense-record";

// =============================================================================
// ── VAT CLASSIFICATION TYPES ──────────────────────────────────────────────────
// =============================================================================

export type VATClassification = "vatable" | "zero-rated" | "exempt";

export type InputVATPurchaseType =
  | "capital-goods"
  | "goods-other-than-capital"
  | "services"
  | "other";

// =============================================================================
// ── ADAPTER CONFIG ────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Capital goods input VAT amortization configuration.
 * BIR rule: input VAT on capital goods exceeding the threshold
 * must be amortized over the specified number of months.
 */
export interface CapitalGoodsAmortizationConfig {
  /**
   * Asset cost threshold above which amortization applies.
   * Default: ₱1,000,000
   */
  amortizationThreshold?: number;

  /**
   * Number of months over which input VAT is amortized.
   * Default: 60 months
   */
  amortizationMonths?: number;
}

/**
 * VAT withheld on government money payments.
 * Applicable when the taxpayer transacts with government entities
 * that are required to withhold VAT before payment.
 */
export interface VATWithheldConfig {
  /**
   * VAT withheld by government on sale of goods.
   * Sourced from BIR Form 2306 issued by the government entity.
   */
  vatWithheldOnGoods?: number;

  /**
   * VAT withheld by government on sale of services.
   */
  vatWithheldOnServices?: number;
}

export interface Form2550MPenalties {
  surcharge?: number;
  interest?: number;
  compromise?: number;
}

export interface Form2550MAdapterConfig {
  /**
   * Capital goods amortization settings.
   * Defaults to BIR standard: threshold ₱1M, 60 months.
   */
  capitalGoodsConfig?: CapitalGoodsAmortizationConfig;

  /**
   * VAT withheld on government money payments.
   * Optional — zero if not provided.
   */
  vatWithheld?: VATWithheldConfig;

  /**
   * Penalties for late filing.
   */
  penalties?: Form2550MPenalties;

  /**
   * Whether this is an amended return.
   */
  isAmended?: boolean;

  /**
   * Tax paid on previously filed return (amended only).
   */
  taxPaidAmended?: number;
}

// =============================================================================
// ── OUTPUT TYPES ──────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Sales classification breakdown for output VAT.
 */
export interface VATSalesBreakdown {
  /** Gross sales amount (tax-exclusive for vatable, face value for others) */
  amount: number;
  /** Output VAT on this classification */
  outputVat: number;
}

/**
 * Input VAT entry for a single expense after amortization applied.
 */
export interface InputVATEntry {
  expenseId: string;
  description: string;
  purchaseType: InputVATPurchaseType;
  purchaseAmount: number;
  totalInputVat: number;
  /**
   * Amount creditable THIS month.
   * For non-capital or small capital goods: equals totalInputVat.
   * For large capital goods: totalInputVat / amortizationMonths.
   */
  creditableThisMonth: number;
  isAmortized: boolean;
  /** If amortized: which month of the amortization schedule this is */
  amortizationMonth?: number;
  /** If amortized: total months in schedule */
  amortizationMonths?: number;
}

/**
 * Input VAT breakdown by purchase type.
 */
export interface InputVATBreakdown {
  capitalGoods: InputVATEntry[];
  goodsOtherThanCapital: InputVATEntry[];
  services: InputVATEntry[];
  totalCapitalGoods: number;
  totalGoodsOtherThanCapital: number;
  totalServices: number;
  totalCurrentInputVat: number;
}

/**
 * Part I — Output VAT section.
 */
export interface Form2550MPartI {
  /** Vatable sales (subject to 12% VAT) */
  vatableSales: VATSalesBreakdown;
  /** Zero-rated sales (0% VAT — input VAT still creditable) */
  zeroRatedSales: VATSalesBreakdown;
  /** Exempt sales (outside VAT system — input VAT non-creditable) */
  exemptSales: VATSalesBreakdown;
  /** Total gross sales across all classifications */
  totalSales: number;
  /** Total output VAT (only from vatable sales) */
  totalOutputVat: number;
}

/**
 * Part II — Input VAT section.
 */
export interface Form2550MPartII {
  /**
   * Beginning balance — excess input VAT carried forward from prior month.
   * Sourced from prior period output's excessInputVat field.
   */
  beginningExcessInputVat: number;
  /** Current month input VAT by purchase type */
  currentInputVat: InputVATBreakdown;
  /** Total available input VAT (beginning + current) */
  totalAvailableInputVat: number;
  /**
   * Less: input VAT attributable to exempt sales (non-creditable).
   * Computed as: totalAvailableInputVat × (exemptSales / totalSales)
   */
  inputVatOnExemptSales: number;
  /**
   * Less: input VAT attributable to zero-rated sales.
   * Zero-rated sales still generate creditable input VAT —
   * this field is informational only (zero in most cases).
   */
  inputVatOnZeroRatedSales: number;
  /** Net creditable input VAT after non-creditable exclusions */
  netCreditableInputVat: number;
}

/**
 * Part III — VAT Payable computation.
 */
export interface Form2550MPartIII {
  /** Output VAT from Part I */
  outputVat: number;
  /** Net creditable input VAT from Part II */
  creditableInputVat: number;
  /** VAT withheld on government money payments */
  vatWithheldOnGoods: number;
  vatWithheldOnServices: number;
  totalVatWithheld: number;
  /**
   * VAT Payable = outputVat - creditableInputVat - totalVatWithheld.
   * Zero if result is negative (excess input VAT instead).
   */
  vatPayable: number;
  /**
   * Excess input VAT to carry forward to next month.
   * Zero if vatPayable > 0.
   */
  excessInputVat: number;
  isExcessInput: boolean;
}

/**
 * Part IV — Summary (penalties + total due).
 */
export interface Form2550MPartIV {
  vatPayable: number;
  taxPaidAmended: number;
  surcharge: number;
  interest: number;
  compromise: number;
  totalPenalties: number;
  totalAmountDue: number;
}

/**
 * Full typed output of Form2550MAdapter.
 */
export interface Form2550MOutput {
  formCode: "2550M";
  month: number;
  taxYear: number;
  partI: Form2550MPartI;
  partII: Form2550MPartII;
  partIII: Form2550MPartIII;
  partIV: Form2550MPartIV;
  isAmended: boolean;
  /** Resolved amortization config used for this computation */
  capitalGoodsConfig: Required<CapitalGoodsAmortizationConfig>;
}

// We need to extend BaseFilingOutput for the adapter contract

export interface Form2550MFilingOutput
  extends BaseFilingOutput<"2550M">, Form2550MOutput {}

// =============================================================================
// ── FORM 2550M ADAPTER ────────────────────────────────────────────────────────
// =============================================================================

/**
 * Form2550MAdapter
 * ---
 *
 * @file form-2550m.ts
 * @description Form2550MAdapter — BIR Form 2550M
 * Monthly Value-Added Tax Declaration.
 *
 * ⚠️  COMPLIANCE NOTE (as of January 1, 2023):
 * Per RMC No. 5-2023 implementing Section 37 of the TRAIN Law (RA 10963),
 * the monthly VAT declaration (Form 2550M) is NO LONGER MANDATORY.
 * VAT-registered taxpayers now file only the Quarterly VAT Return (Form 2550Q).
 *
 * However, per RMC No. 52-2023, monthly filing remains OPTIONAL.
 * Taxpayers may still voluntarily file 2550M for the first two months of each
 * quarter without a prescribed deadline. Non-filing does not create open cases
 * with the BIR as long as 2550Q is filed quarterly.
 *
 * This adapter remains available for taxpayers who opt into voluntary monthly filing.
 * For mandatory compliance, use Form2550QAdapter instead.
 *
 * Handles:
 *   - Output VAT broken down into vatable (12%), zero-rated (0%), and exempt sales
 *   - Input VAT by purchase type: capital goods, goods other than capital, services
 *   - Capital goods input VAT amortization (configurable threshold + duration)
 *   - Prior month excess input VAT carryforward (from FilingChain or context)
 *   - VAT withheld on government money payments (optional config)
 *   - VAT payable or excess input VAT to carry forward
 *
 * VAT classification per invoice line:
 *   Priority 1: line.metadata.vatClassification (manual override)
 *   Priority 2: derived from TaxDetail
 *     taxType === 'VAT' && rate === 0.12  → vatable
 *     taxType === 'VAT' && rate === 0     → zero-rated
 *     no VAT TaxDetail                   → exempt
 *
 * Valid for: any entity type
 * Tax regime: vat only
 *
 * Usage:
 * ```ts
 * const adapter = new Form2550MAdapter({
 *   capitalGoodsConfig: {
 *     amortizationThreshold: 1_000_000,
 *     amortizationMonths: 60,
 *   },
 * });
 *
 * const ta = TaxAccountant.init({
 *   adapter,
 *   context: await FilingContextBuilder.from({
 *     profile,
 *     period: FilingPeriodHelper.month(2024, 3),
 *     taxYear: 2024,
 *     currency: "PHP",
 *     invoices: marchInvoices,
 *     expenses: marchExpenses,
 *     priorPeriodOutputs: [febOutput], // for excess input VAT carryforward
 *   }).build(),
 * });
 *
 * const output = ta.prepare();
 * console.log(output.partIII.vatPayable);
 * console.log(output.partIII.excessInputVat); // carries to next month
 * ```
 */

export class Form2550MAdapter extends AbstractBaseTaxAdapter<
  PeriodFilingContext,
  Form2550MFilingOutput
> {
  // ── Identity ──────────────────────────────────────────────────────────────

  readonly formCode = "2550M" as const;
  readonly formTitle = "Monthly Value-Added Tax Declaration";
  readonly filingFrequency = "monthly" as const;

  readonly capabilities: AdapterCapabilities = {
    formCode: "2550M",
    formTitle: "Monthly Value-Added Tax Declaration",
    filingFrequency: "monthly",
    contextType: "period",
    requiresExpenses: false,
    requiresReceivedCertificates: false,
    requiresIssuedCertificates: false,
    requiresPriorPeriodOutputs: false, // recommended for carryforward
    requiredPriorFormCodes: [],
    validForEntityTypes: undefined, // all entity types
    validForRegimes: ["vat"],
  };

  // ── Config ────────────────────────────────────────────────────────────────

  private readonly _amortizationThreshold: number;
  private readonly _amortizationMonths: number;
  private readonly _vatWithheld: Required<VATWithheldConfig>;
  private readonly _penalties: Form2550MPenalties | undefined;
  private readonly _isAmended: boolean;
  private readonly _taxPaidAmended: number;

  constructor(config: Form2550MAdapterConfig = {}) {
    super();
    this._amortizationThreshold =
      config.capitalGoodsConfig?.amortizationThreshold ?? 1_000_000;
    this._amortizationMonths =
      config.capitalGoodsConfig?.amortizationMonths ?? 60;
    this._vatWithheld = {
      vatWithheldOnGoods: config.vatWithheld?.vatWithheldOnGoods ?? 0,
      vatWithheldOnServices: config.vatWithheld?.vatWithheldOnServices ?? 0,
    };
    this._penalties = config.penalties;
    this._isAmended = config.isAmended ?? false;
    this._taxPaidAmended = config.taxPaidAmended ?? 0;
  }

  // ==========================================================================
  // ── ABSTRACT IMPLEMENTATIONS ───────────────────────────────────────────────
  // ==========================================================================

  protected _validateContext(ctx: PeriodFilingContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Must be a monthly period
    if (ctx.period && ctx.period.month === undefined) {
      issues.push({
        severity: "error",
        code: "VAT2550M_NOT_MONTHLY",
        message:
          "Form 2550M requires a monthly filing period. " +
          "Use FilingPeriodHelper.month(year, month).",
        field: "period",
      });
    }

    // VAT regime check (also enforced by capabilities, but be explicit)
    if (ctx.profile.taxRegime !== "vat") {
      issues.push({
        severity: "error",
        code: "VAT2550M_WRONG_REGIME",
        message:
          `Form 2550M is only for VAT-registered taxpayers. ` +
          `Profile taxRegime is "${ctx.profile.taxRegime}".`,
        field: "profile.taxRegime",
      });
    }

    // No invoices — warn only
    if (!ctx.invoices || ctx.invoices.length === 0) {
      issues.push({
        severity: "warning",
        code: "VAT2550M_NO_INVOICES",
        message:
          "No invoices found for this month. " + "Output VAT will be zero.",
        field: "invoices",
      });
    }

    // Amended check
    if (this._isAmended && this._taxPaidAmended === 0) {
      issues.push({
        severity: "warning",
        code: "VAT2550M_AMENDED_NO_PRIOR",
        message:
          "isAmended is true but taxPaidAmended is 0. " +
          "Provide the previously paid VAT via config.taxPaidAmended.",
        field: "taxPaidAmended",
      });
    }

    return issues;
  }

  protected _computeOutput(
    ctx: PeriodFilingContext,
  ): Omit<Form2550MFilingOutput, "computedAt" | "validation"> {
    const invoices = ctx.invoices ?? [];
    const expenses = ctx.expenses ?? [];
    const currency = ctx.currency;

    // ── Part I: Output VAT ─────────────────────────────────────────────────
    const partI = this._computePartI(invoices);

    // ── Part II: Input VAT ─────────────────────────────────────────────────
    const beginningExcessInputVat =
      AdapterComputationHelpers.getPriorExcessInputVat(
        ctx.priorPeriodOutputs ?? [],
        ["2550M", "2550Q"],
      );

    const partII = this._computePartII(
      expenses,
      beginningExcessInputVat,
      partI,
      ctx.period,
    );

    // ── Part III: VAT Payable ──────────────────────────────────────────────
    const partIII = this._computePartIII(partI, partII);

    // ── Part IV: Summary ───────────────────────────────────────────────────
    const partIV = this._computePartIV(partIII.vatPayable);

    // ── Base output ────────────────────────────────────────────────────────
    const base = this._buildBaseOutput(ctx, {
      grossIncome: partI.totalSales,
      taxDue: partIII.vatPayable,
      taxCredits: partII.netCreditableInputVat + partIII.totalVatWithheld,
      currency,
    });

    return {
      ...base,
      formCode: "2550M",
      month: ctx.period.month!,
      taxYear: ctx.taxYear,
      partI,
      partII,
      partIII,
      partIV,
      isAmended: this._isAmended,
      capitalGoodsConfig: {
        amortizationThreshold: this._amortizationThreshold,
        amortizationMonths: this._amortizationMonths,
      },
      // Store excessInputVat in fieldMap so FilingChain consumers can find it
      fieldMap: {
        excessInputVat: partIII.excessInputVat,
      },
    };
  }

  protected _buildFieldMap(
    output: Form2550MFilingOutput,
  ): Record<string, number | string | boolean> {
    const p1 = output.partI;
    const p2 = output.partII;
    const p3 = output.partIII;
    const p4 = output.partIV;

    return {
      // Part I — Output VAT
      vatableSales: p1.vatableSales.amount,
      vatableSalesOutputVat: p1.vatableSales.outputVat,
      zeroRatedSales: p1.zeroRatedSales.amount,
      exemptSales: p1.exemptSales.amount,
      totalSales: p1.totalSales,
      totalOutputVat: p1.totalOutputVat,

      // Part II — Input VAT
      beginningExcessInputVat: p2.beginningExcessInputVat,
      inputVatCapitalGoods: p2.currentInputVat.totalCapitalGoods,
      inputVatGoodsOtherCapital: p2.currentInputVat.totalGoodsOtherThanCapital,
      inputVatServices: p2.currentInputVat.totalServices,
      totalCurrentInputVat: p2.currentInputVat.totalCurrentInputVat,
      totalAvailableInputVat: p2.totalAvailableInputVat,
      inputVatOnExemptSales: p2.inputVatOnExemptSales,
      netCreditableInputVat: p2.netCreditableInputVat,

      // Part III — VAT Payable
      outputVat: p3.outputVat,
      creditableInputVat: p3.creditableInputVat,
      vatWithheldGoods: p3.vatWithheldOnGoods,
      vatWithheldServices: p3.vatWithheldOnServices,
      totalVatWithheld: p3.totalVatWithheld,
      vatPayable: p3.vatPayable,
      excessInputVat: p3.excessInputVat,

      // Part IV — Summary
      totalAmountDue: p4.totalAmountDue,
      surcharge: p4.surcharge,
      interest: p4.interest,
      compromise: p4.compromise,
    };
  }

  // ==========================================================================
  // ── PRIVATE: PART I — OUTPUT VAT ──────────────────────────────────────────
  // ==========================================================================

  private _computePartI(
    invoices: Array<ResolvedInvoice | RawInvoiceSummary>,
  ): Form2550MPartI {
    let vatableSalesAmount = 0;
    let vatableSalesOutputVat = 0;
    let zeroRatedSalesAmount = 0;
    let exemptSalesAmount = 0;

    for (const inv of invoices) {
      const classification = this._classifyInvoice(inv);
      const saleAmount = this._getInvoiceSaleAmount(inv);

      switch (classification) {
        case "vatable": {
          // Extract the tax-exclusive base from totalAmount
          // totalAmount includes VAT if exclusive, so base = totalAmount - vatAmount
          const outputVat = this._getInvoiceVatAmount(inv);
          const base = saleAmount - outputVat;
          vatableSalesAmount += base;
          vatableSalesOutputVat += outputVat;
          break;
        }
        case "zero-rated":
          zeroRatedSalesAmount += saleAmount;
          break;
        case "exempt":
          exemptSalesAmount += saleAmount;
          break;
      }
    }

    const totalSales =
      vatableSalesAmount + zeroRatedSalesAmount + exemptSalesAmount;

    return {
      vatableSales: {
        amount: vatableSalesAmount,
        outputVat: vatableSalesOutputVat,
      },
      zeroRatedSales: {
        amount: zeroRatedSalesAmount,
        outputVat: 0,
      },
      exemptSales: {
        amount: exemptSalesAmount,
        outputVat: 0,
      },
      totalSales,
      totalOutputVat: vatableSalesOutputVat,
    };
  }

  // ==========================================================================
  // ── PRIVATE: PART II — INPUT VAT ──────────────────────────────────────────
  // ==========================================================================

  private _computePartII(
    expenses: ExpenseRecord[],
    beginningExcessInputVat: number,
    partI: Form2550MPartI,
    period: FilingPeriod,
  ): Form2550MPartII {
    // ── Resolve purchase type for each expense ────────────────────────────
    const capitalGoodsEntries: InputVATEntry[] = [];
    const goodsOtherEntries: InputVATEntry[] = [];
    const servicesEntries: InputVATEntry[] = [];

    for (const exp of expenses) {
      // Skip expenses with no input VAT or non-creditable
      if (
        !exp.bir?.inputVatAmount ||
        exp.bir.inputVatAmount <= 0 ||
        exp.bir.vatClassification === "non-creditable"
      ) {
        continue;
      }

      const purchaseType = this._resolvePurchaseType(exp);
      const entry = this._buildInputVATEntry(exp, purchaseType, period);

      switch (purchaseType) {
        case "capital-goods":
          capitalGoodsEntries.push(entry);
          break;
        case "goods-other-than-capital":
          goodsOtherEntries.push(entry);
          break;
        case "services":
          servicesEntries.push(entry);
          break;
      }
    }

    const totalCapitalGoods = capitalGoodsEntries.reduce(
      (s, e) => s + e.creditableThisMonth,
      0,
    );
    const totalGoodsOtherThanCapital = goodsOtherEntries.reduce(
      (s, e) => s + e.creditableThisMonth,
      0,
    );
    const totalServices = servicesEntries.reduce(
      (s, e) => s + e.creditableThisMonth,
      0,
    );
    const totalCurrentInputVat =
      totalCapitalGoods + totalGoodsOtherThanCapital + totalServices;

    const currentInputVat: InputVATBreakdown = {
      capitalGoods: capitalGoodsEntries,
      goodsOtherThanCapital: goodsOtherEntries,
      services: servicesEntries,
      totalCapitalGoods,
      totalGoodsOtherThanCapital,
      totalServices,
      totalCurrentInputVat,
    };

    const totalAvailableInputVat =
      beginningExcessInputVat + totalCurrentInputVat;

    // ── Non-creditable input VAT on exempt sales ──────────────────────────
    // Apportioned: exempt sales / total sales × total available input VAT
    let inputVatOnExemptSales = 0;
    if (partI.totalSales > 0 && partI.exemptSales.amount > 0) {
      const exemptRatio = partI.exemptSales.amount / partI.totalSales;
      inputVatOnExemptSales = totalAvailableInputVat * exemptRatio;
    }

    // Zero-rated sales: input VAT is creditable — informational only
    const inputVatOnZeroRatedSales = 0;

    const netCreditableInputVat = Math.max(
      0,
      totalAvailableInputVat - inputVatOnExemptSales,
    );

    return {
      beginningExcessInputVat,
      currentInputVat,
      totalAvailableInputVat,
      inputVatOnExemptSales,
      inputVatOnZeroRatedSales,
      netCreditableInputVat,
    };
  }

  // ==========================================================================
  // ── PRIVATE: PART III — VAT PAYABLE ───────────────────────────────────────
  // ==========================================================================

  private _computePartIII(
    partI: Form2550MPartI,
    partII: Form2550MPartII,
  ): Form2550MPartIII {
    const outputVat = partI.totalOutputVat;
    const creditableInputVat = partII.netCreditableInputVat;
    const vatWithheldOnGoods = this._vatWithheld.vatWithheldOnGoods;
    const vatWithheldOnServices = this._vatWithheld.vatWithheldOnServices;
    const totalVatWithheld = vatWithheldOnGoods + vatWithheldOnServices;

    const { vatPayable, excessInputVat, isExcessInput } =
      AdapterComputationHelpers.computeVatPayable({
        outputVat,
        inputVat: creditableInputVat,
        priorExcessInputVat: 0, // already included in partII.beginningExcessInputVat
      });

    // Apply VAT withheld — reduces VAT payable further
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

  // ==========================================================================
  // ── PRIVATE: PART IV — SUMMARY ────────────────────────────────────────────
  // ==========================================================================

  private _computePartIV(vatPayable: number): Form2550MPartIV {
    const surcharge = this._penalties?.surcharge ?? 0;
    const interest = this._penalties?.interest ?? 0;
    const compromise = this._penalties?.compromise ?? 0;
    const totalPenalties = surcharge + interest + compromise;
    const totalAmountDue = Math.max(
      0,
      vatPayable - this._taxPaidAmended + totalPenalties,
    );

    return {
      vatPayable,
      taxPaidAmended: this._taxPaidAmended,
      surcharge,
      interest,
      compromise,
      totalPenalties,
      totalAmountDue,
    };
  }

  // ==========================================================================
  // ── PRIVATE: VAT CLASSIFICATION ───────────────────────────────────────────
  // ==========================================================================

  /**
   * Classify an invoice as vatable, zero-rated, or exempt.
   *
   * Priority 1: metadata.vatClassification (manual override)
   * Priority 2: derived from TaxDetail
   *   VAT @ 12% → vatable
   *   VAT @ 0%  → zero-rated
   *   No VAT    → exempt
   */
  private _classifyInvoice(
    inv: ResolvedInvoice | RawInvoiceSummary,
  ): VATClassification {
    // Check manual override on invoice metadata
    const isRaw = "kind" in inv && inv.kind === "raw-summary";

    if (!isRaw) {
      const resolved = inv as ResolvedInvoice;
      const metaClassification = (resolved as any).metadata?.vatClassification;
      if (metaClassification) {
        return metaClassification as VATClassification;
      }

      // Derive from TaxDetail — check line items
      const lineItems: LineItem[] = [...resolved.lineItems];
      if (lineItems.length > 0) {
        // Use the first line item's VAT classification as representative
        // (mixed-classification invoices should be split into separate invoices)
        return this._classifyFromLineItems(lineItems);
      }

      // Fall back to checking taxAmount
      if (resolved.taxAmount > 0) return "vatable";
    }

    // RawInvoiceSummary: use vatAmount as signal
    const raw = inv as RawInvoiceSummary;
    if (raw.vatAmount > 0) return "vatable";

    return "exempt";
  }

  private _classifyFromLineItems(lineItems: LineItem[]): VATClassification {
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

    return "exempt";
  }

  private _getInvoiceSaleAmount(
    inv: ResolvedInvoice | RawInvoiceSummary,
  ): number {
    if ("kind" in inv && inv.kind === "raw-summary") {
      return (inv as RawInvoiceSummary).grossAmount;
    }
    return (inv as ResolvedInvoice).totalAmount;
  }

  private _getInvoiceVatAmount(
    inv: ResolvedInvoice | RawInvoiceSummary,
  ): number {
    if ("kind" in inv && inv.kind === "raw-summary") {
      return (inv as RawInvoiceSummary).vatAmount;
    }
    return (inv as ResolvedInvoice).taxAmount;
  }

  // ==========================================================================
  // ── PRIVATE: PURCHASE TYPE RESOLUTION ─────────────────────────────────────
  // ==========================================================================

  /**
   * Resolve the BIR purchase type for an expense entry.
   *
   * Priority 1: expense.purchaseType (explicitly set)
   * Priority 2: infer from expense.isDepreciation → capital-goods
   * Priority 3: infer from expense.category
   * Priority 4: default to "services"
   */
  private _resolvePurchaseType(exp: ExpenseRecord): InputVATPurchaseType {
    if (exp.bir?.purchaseType) return exp.bir.purchaseType;
    if (exp.bir?.isDepreciation) return "capital-goods";

    // Infer from category
    switch (exp.category) {
      case "cost-of-sales":
        return "goods-other-than-capital";
      case "compensation":
      case "professional-fees":
      case "rent":
      case "utilities":
      case "communication":
      case "transportation":
      case "insurance":
      case "representation":
        return "services";
      case "supplies":
        return "goods-other-than-capital";
      case "depreciation":
        return "capital-goods";
      default:
        return "services";
    }
  }

  // ==========================================================================
  // ── PRIVATE: INPUT VAT ENTRY BUILDER ──────────────────────────────────────
  // ==========================================================================

  /**
   * Build an InputVATEntry applying amortization rules if applicable.
   *
   * Amortization applies when:
   *   - purchaseType === "capital-goods"
   *   - expense.amount > amortizationThreshold
   *
   * The creditable amount this month = totalInputVat / amortizationMonths.
   * The amortization month number is derived from:
   *   expense.date → how many months ago from the filing period start.
   */
  private _buildInputVATEntry(
    exp: ExpenseRecord,
    purchaseType: InputVATPurchaseType,
    period: FilingPeriod,
  ): InputVATEntry {
    const totalInputVat = exp.bir?.inputVatAmount ?? 0;
    const isLargeCapitalGood =
      purchaseType === "capital-goods" &&
      exp.totalAmount > this._amortizationThreshold;

    if (!isLargeCapitalGood) {
      return {
        expenseId: exp.id,
        description: exp.description,
        purchaseType,
        purchaseAmount: exp.totalAmount,
        totalInputVat,
        creditableThisMonth: totalInputVat,
        isAmortized: false,
      };
    }

    // ── TRAIN Law compliance: amortization abolished from Jan 1, 2022 ──────
    // RMC 21-2022 / Section 35 TRAIN Law / Section 110(b) Tax Code:
    // Capital goods purchased ON OR AFTER January 1, 2022 → full outright claim.
    // Capital goods purchased BEFORE January 1, 2022 → continue amortization
    // schedule until fully utilized.
    const AMORTIZATION_CUTOFF = "2022-01-01";
    const isPurchasedAfterCutoff = exp.expenseDate >= AMORTIZATION_CUTOFF;

    if (isPurchasedAfterCutoff) {
      // Post-2022 purchase: claim full input VAT outright in purchase month/quarter
      return {
        expenseId: exp.id,
        description: exp.description,
        purchaseType,
        purchaseAmount: exp.totalAmount,
        totalInputVat,
        creditableThisMonth: totalInputVat,
        isAmortized: false,
      };
    }

    // Pre-2022 purchase: continue legacy amortization schedule
    const purchaseDate = new Date(exp.expenseDate);
    const periodStart = new Date(period.start);

    // Month difference: how far into the amortization schedule are we?
    const monthsElapsed =
      (periodStart.getFullYear() - purchaseDate.getFullYear()) * 12 +
      (periodStart.getMonth() - purchaseDate.getMonth()) +
      1;

    // Only creditable during the amortization window
    const isWithinWindow =
      monthsElapsed >= 1 && monthsElapsed <= this._amortizationMonths;

    const creditableThisMonth = isWithinWindow
      ? totalInputVat / this._amortizationMonths
      : 0;

    return {
      expenseId: exp.id,
      description: exp.description,
      purchaseType,
      purchaseAmount: exp.totalAmount,
      totalInputVat,
      creditableThisMonth,
      isAmortized: true,
      amortizationMonth: isWithinWindow ? monthsElapsed : undefined,
      amortizationMonths: this._amortizationMonths,
    };
  }
}
