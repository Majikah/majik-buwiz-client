/**
 * @file filing-context.ts
 * @description FilingContextBuilder — assembles, validates, and normalizes
 * a PeriodFilingContext from raw inputs before any adapter touches the data.
 *
 * Responsibilities:
 *   1. Accept MajikInvoice[] or RawInvoiceSummary[] as invoice input
 *   2. Filter invoices by period (issueDate within period.start–period.end)
 *   3. Resolve encrypted MajikInvoice → RawInvoiceSummary when locked
 *   4. Normalize currencies per the chosen CurrencyHandlingConfig
 *   5. Filter expenses by date within period
 *   6. Validate Form 2307 certificates fall within period
 *   7. Validate priorPeriodOutputs are chronologically before current period
 *   8. Check TaxpayerProfile completeness for the period type
 *   9. Enforce entity type compatibility when an adapter is provided
 *  10. Produce a ValidationResult — throw on errors unless dryRun: true
 *
 * Dependencies:
 *   - bir-types.ts  (all shared types)
 *   - @thezelijah/majik-money (MajikMoney, CurrencyDefinition)
 *   - MajikInvoice / GeneralInvoice (for invoice resolution)
 */

import { ExpenseRecord } from "../expenses/expense-record";
import type {
  BaseFilingOutput,
  AdapterCapabilities,
  CurrencyCode,
  FilingPeriod,
  Form2307Certificate,
  PeriodFilingContext,
  RawInvoiceSummary,
  TaxpayerProfile,
  ValidationIssue,
  ValidationResult,
  FilingChain,
} from "./types/bir-types";
import {
  CurrencyDefinition,
  CurrencyHandlingConfig,
  FilingContextBuilderInput,
} from "./types/filing-types";
import { ResolvableInvoice, ResolvedInvoice } from "./types/invoice-types";

// ---------------------------------------------------------------------------
// FilingContextBuilder
// ---------------------------------------------------------------------------

/**
 * Fluent builder for PeriodFilingContext.
 *
 * @example — basic usage
 * ```ts
 * const ctx = await FilingContextBuilder
 *   .from({
 *     profile,
 *     period: FilingPeriodHelper.q1(2024),
 *     taxYear: 2024,
 *     currency: "PHP",
 *     invoices: majikInvoices,
 *     expenses: myExpenses,
 *   })
 *   .build();
 * ```
 *
 * @example — with currency conversion
 * ```ts
 * const ctx = await FilingContextBuilder
 *   .from({ ...base, currencyHandling: {
 *     mode: "convert",
 *     rates: { USD: 56.50, EUR: 61.20 },
 *     targetCurrencyDefinition: PHP_CURRENCY_DEF,
 *   }})
 *   .build();
 * ```
 */
export class FilingContextBuilder {
  private readonly input: FilingContextBuilderInput;
  private readonly issues: ValidationIssue[] = [];

  private constructor(input: FilingContextBuilderInput) {
    this.input = input;
  }

  // ── Static entry point ────────────────────────────────────────────────────

  static from(input: FilingContextBuilderInput): FilingContextBuilder {
    return new FilingContextBuilder(input);
  }

  // ── Main build ────────────────────────────────────────────────────────────

  /**
   * Assembles and validates the PeriodFilingContext.
   *
   * @throws {FilingContextError} if validation errors exist and dryRun !== true
   */
  async build(): Promise<PeriodFilingContext> {
    const {
      profile,
      period,
      taxYear,
      currency,
      options,
      expenses,
      receivedCertificates,
      issuedCertificates,
      priorPeriodOutputs,
      currencyHandling = { mode: "strict" },
      adapterCapabilities,
    } = this.input;

    // ── Step 1: Validate profile completeness ─────────────────────────────
    this._validateProfile(profile, period);

    // ── Step 2: Validate period is internally consistent ──────────────────
    this._validatePeriod(period, taxYear);

    // ── Step 3: Enforce adapter compatibility if provided ─────────────────
    if (adapterCapabilities) {
      this._enforceAdapterCompatibility(adapterCapabilities, profile);
    }

    // ── Step 4: Resolve and filter invoices ───────────────────────────────
    const resolvedInvoices = await this._resolveInvoices(
      this.input.invoices ?? [],
      period,
      currency,
      currencyHandling,
    );

    // ── Step 5: Filter and validate expenses ──────────────────────────────
    const filteredExpenses = this._filterExpenses(
      expenses ?? [],
      period,
      currency,
      currencyHandling,
    );

    // ── Step 6: Validate certificates fall within period ─────────────────
    const filteredReceived = this._filterCertificates(
      receivedCertificates ?? [],
      period,
      "receivedCertificates",
    );
    const filteredIssued = this._filterCertificates(
      issuedCertificates ?? [],
      period,
      "issuedCertificates",
    );

    // ── Step 7: Validate prior period outputs are chronologically prior ───
    this._validatePriorPeriodOutputs(priorPeriodOutputs ?? [], period);

    // ── Step 8: Validate adapter-specific requirements ────────────────────
    if (adapterCapabilities) {
      this._validateAdapterRequirements(
        adapterCapabilities,
        filteredExpenses,
        filteredReceived,
        filteredIssued,
        priorPeriodOutputs ?? [],
      );
    }

    // ── Step 9: Check for errors and throw if not dryRun ─────────────────
    const validation = this._buildValidationResult();
    const hasErrors = validation.errors.length > 0;

    if (hasErrors && !options?.dryRun) {
      throw new FilingContextError(
        `FilingContextBuilder: ${validation.errors.length} error(s) found. ` +
          `Pass options.dryRun: true to proceed with a partial context.\n` +
          validation.errors.map((e) => `  [${e.code}] ${e.message}`).join("\n"),
        validation,
      );
    }

    // ── Step 10: Assemble the final context ───────────────────────────────
    const context: PeriodFilingContext = {
      profile,
      period,
      taxYear,
      currency,
      options,
      invoices: resolvedInvoices,
      expenses: filteredExpenses,
      receivedCertificates: filteredReceived,
      issuedCertificates: filteredIssued,
      priorPeriodOutputs: priorPeriodOutputs ?? [],
    };

    return context;
  }

  // ==========================================================================
  // ── PRIVATE VALIDATION METHODS ─────────────────────────────────────────────
  // ==========================================================================

  private _validateProfile(
    profile: TaxpayerProfile,
    _period: FilingPeriod,
  ): void {
    if (!profile.tin?.trim()) {
      this._addError(
        "PROFILE_MISSING_TIN",
        "TIN is required on TaxpayerProfile",
        "profile.tin",
      );
    } else if (
      !/^\d{3}-\d{3}-\d{3}-\d{3}$/.test(profile.tin.trim()) &&
      !/^\d{9}$/.test(profile.tin.trim().replace(/-/g, ""))
    ) {
      this._addWarning(
        "PROFILE_TIN_FORMAT",
        `TIN "${profile.tin}" does not match expected BIR format (NNN-NNN-NNN-NNN)`,
        "profile.tin",
      );
    }

    if (!profile.rdoCode?.trim()) {
      this._addError(
        "PROFILE_MISSING_RDO",
        "RDO code is required on TaxpayerProfile",
        "profile.rdoCode",
      );
    }

    if (!profile.legalName?.trim()) {
      this._addError(
        "PROFILE_MISSING_NAME",
        "Legal name is required on TaxpayerProfile",
        "profile.legalName",
      );
    }

    if (!profile.entityType) {
      this._addError(
        "PROFILE_MISSING_ENTITY_TYPE",
        "entityType is required on TaxpayerProfile",
        "profile.entityType",
      );
    }

    if (!profile.taxRegime) {
      this._addError(
        "PROFILE_MISSING_REGIME",
        "taxRegime is required on TaxpayerProfile",
        "profile.taxRegime",
      );
    }

    if (!profile.accountingMethod) {
      this._addError(
        "PROFILE_MISSING_ACCOUNTING_METHOD",
        "accountingMethod is required on TaxpayerProfile",
        "profile.accountingMethod",
      );
    }

    if (!profile.functionalCurrency?.trim()) {
      this._addError(
        "PROFILE_MISSING_CURRENCY",
        "functionalCurrency is required on TaxpayerProfile",
        "profile.functionalCurrency",
      );
    }

    // Individual filers need rate election for income tax forms
    if (profile.entityType === "individual" && !profile.taxRateElection) {
      this._addWarning(
        "PROFILE_MISSING_RATE_ELECTION",
        "taxRateElection ('graduated' | 'flat-8-percent') is recommended for individual filers",
        "profile.taxRateElection",
      );
    }

    // Graduated path without deduction method
    if (profile.taxRateElection === "graduated" && !profile.deductionMethod) {
      this._addWarning(
        "PROFILE_MISSING_DEDUCTION_METHOD",
        "deductionMethod ('itemized' | 'osd') is required when taxRateElection is 'graduated'",
        "profile.deductionMethod",
      );
    }

    // VAT-registered needs a registration date
    if (profile.taxRegime === "vat" && !profile.vatRegistrationDate) {
      this._addWarning(
        "PROFILE_MISSING_VAT_DATE",
        "vatRegistrationDate is recommended for VAT-registered taxpayers",
        "profile.vatRegistrationDate",
      );
    }
  }

  private _validatePeriod(period: FilingPeriod, taxYear: number): void {
    if (!period.start || !period.end) {
      this._addError(
        "PERIOD_MISSING_DATES",
        "Period must have both start and end dates",
        "period",
      );
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(period.start)) {
      this._addError(
        "PERIOD_INVALID_START",
        `period.start "${period.start}" is not a valid YYYY-MM-DD date`,
        "period.start",
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(period.end)) {
      this._addError(
        "PERIOD_INVALID_END",
        `period.end "${period.end}" is not a valid YYYY-MM-DD date`,
        "period.end",
      );
    }

    if (period.start > period.end) {
      this._addError(
        "PERIOD_INVERTED",
        `period.start (${period.start}) cannot be after period.end (${period.end})`,
        "period",
      );
    }

    if (period.year !== taxYear) {
      this._addWarning(
        "PERIOD_YEAR_MISMATCH",
        `period.year (${period.year}) does not match taxYear (${taxYear})`,
        "period.year",
      );
    }

    // Validate quarter boundaries if quarter is specified
    if (period.quarter !== undefined) {
      const expected = FilingPeriodHelper.quarterBoundaries(
        taxYear,
        period.quarter,
      );
      if (period.start !== expected.start || period.end !== expected.end) {
        this._addWarning(
          "PERIOD_QUARTER_BOUNDARY",
          `Quarter ${period.quarter} of ${taxYear} should span ${expected.start}–${expected.end}, ` +
            `but got ${period.start}–${period.end}`,
          "period",
        );
      }
    }
  }

  // ── Adapter compatibility (hard enforce) ──────────────────────────────────

  /**
   * Hard-enforces entity type and regime compatibility.
   * Throws FilingContextError immediately — does not add to issues array.
   * This is intentionally a hard throw, not a validation issue, because
   * using the wrong adapter for an entity type is a programming error,
   * not a data issue.
   */
  private _enforceAdapterCompatibility(
    caps: AdapterCapabilities,
    profile: TaxpayerProfile,
  ): void {
    // Entity type enforcement
    if (caps.validForEntityTypes && caps.validForEntityTypes.length > 0) {
      if (!caps.validForEntityTypes.includes(profile.entityType)) {
        throw new FilingContextError(
          `Adapter "${caps.formCode}" (${caps.formTitle}) is only valid for ` +
            `entity types [${caps.validForEntityTypes.join(", ")}]. ` +
            `Profile entity type is "${profile.entityType}". ` +
            `Use the correct adapter for this entity type.`,
          this._buildValidationResult(),
        );
      }
    }

    // Tax regime enforcement
    if (caps.validForRegimes && caps.validForRegimes.length > 0) {
      if (!caps.validForRegimes.includes(profile.taxRegime)) {
        throw new FilingContextError(
          `Adapter "${caps.formCode}" (${caps.formTitle}) is only valid for ` +
            `tax regimes [${caps.validForRegimes.join(", ")}]. ` +
            `Profile tax regime is "${profile.taxRegime}". ` +
            `For example: Form 2551Q requires "percentage-tax" regime; ` +
            `Form 2550M requires "vat" regime.`,
          this._buildValidationResult(),
        );
      }
    }
  }

  // ── Invoice resolution ─────────────────────────────────────────────────────

  private async _resolveInvoices(
    inputs: Array<ResolvableInvoice | RawInvoiceSummary>,
    period: FilingPeriod,
    functionalCurrency: CurrencyCode,
    currencyHandling: CurrencyHandlingConfig,
  ): Promise<Array<ResolvedInvoice | RawInvoiceSummary>> {
    const resolved: Array<ResolvedInvoice | RawInvoiceSummary> = [];

    for (const input of inputs) {
      // ── Detect type ───────────────────────────────────────────────────────
      const isRaw = "kind" in input && input.kind === "raw-summary";

      let issueDate: string;
      let currency: string;
      let invoiceId: string;

      if (isRaw) {
        const raw = input as RawInvoiceSummary;
        issueDate = raw.issueDate;
        currency = raw.currency;
        invoiceId = raw.id;
      } else {
        const inv = input as ResolvableInvoice;
        issueDate = inv.public.issuedAt.slice(0, 10);
        currency = inv.public.currency;
        invoiceId = inv.id;
      }

      // ── Period filter ─────────────────────────────────────────────────────
      if (issueDate < period.start || issueDate > period.end) {
        // Outside period — silently skip, no issue raised
        continue;
      }

      // ── Currency handling ─────────────────────────────────────────────────
      if (currency !== functionalCurrency) {
        const handled = this._handleCurrencyMismatch(
          invoiceId,
          currency,
          functionalCurrency,
          currencyHandling,
          "invoice",
        );

        if (handled === "reject") continue;
        // lenient and convert — include the invoice as-is or post-conversion
        // Note: actual conversion of amounts happens inside the adapter
        // via the FxRateMap stored in the context. We only validate here.
      }

      // ── Resolve MajikInvoice → ResolvedInvoice or RawInvoiceSummary ──────
      if (isRaw) {
        resolved.push(input as RawInvoiceSummary);
      } else {
        const inv = input as ResolvableInvoice;

        if (inv.mode === "signed-only" || inv.hasDecryptedCache) {
          try {
            resolved.push(inv.invoice);
          } catch {
            // Fallback to public summary as RawInvoiceSummary
            const raw = this._invoiceToRawSummary(inv, true);
            resolved.push(raw);
            this._addWarning(
              "INVOICE_PARTIAL_DATA",
              `Invoice "${invoiceId}" could not be resolved to full data — ` +
                `using public summary only. Some adapter computations may be incomplete.`,
              `invoices[${invoiceId}]`,
            );
          }
        } else {
          // Encrypted and locked — degrade to raw summary
          const raw = this._invoiceToRawSummary(inv, true);
          resolved.push(raw);
          this._addWarning(
            "INVOICE_ENCRYPTED_LOCKED",
            `Invoice "${invoiceId}" is encrypted and has not been decrypted. ` +
              `Using public summary only. Call MajikInvoice.decrypt() before ` +
              `building the context for full adapter accuracy.`,
            `invoices[${invoiceId}]`,
          );
        }
      }
    }

    return resolved;
  }

  private _invoiceToRawSummary(
    inv: ResolvableInvoice,
    isPartial: boolean,
  ): RawInvoiceSummary {
    const totals = inv.invoice?.totals;

    return {
      kind: "raw-summary",
      id: inv.id,
      invoiceNumber: inv.public.invoiceNumber,
      issueDate: inv.public.issuedAt.slice(0, 10),
      currency: inv.public.currency,
      status: inv.public.status,

      // before discounts/taxes
      grossAmount: totals?.subtotalAmount ?? 0,

      // additive taxes only (VAT)
      vatAmount: totals?.taxTotalAmount ?? 0,

      // EWT / withholding taxes
      withholdingAmount: totals?.withholdingTotalAmount ?? 0,

      // declared invoice amount
      netAmount: totals?.grandTotalAmount ?? inv.public.totalAmount ?? 0,

      // discounts
      discountAmount: totals?.discountTotalAmount ?? 0,

      isPartial,
    };
  }
  // ── Expense filtering ──────────────────────────────────────────────────────

  private _filterExpenses(
    expenses: ExpenseRecord[],
    period: FilingPeriod,
    functionalCurrency: CurrencyCode,
    currencyHandling: CurrencyHandlingConfig,
  ): ExpenseRecord[] {
    const filtered: ExpenseRecord[] = [];

    for (const expense of expenses) {
      // Period filter
      if (expense.expenseDate < period.start || expense.expenseDate > period.end) {
        continue;
      }

      // Currency handling
      if (expense.currency !== functionalCurrency) {
        const handled = this._handleCurrencyMismatch(
          expense.id,
          expense.currency,
          functionalCurrency,
          currencyHandling,
          "expense",
        );
        if (handled === "reject") continue;
      }

      filtered.push(expense);
    }

    return filtered;
  }

  // ── Certificate filtering ─────────────────────────────────────────────────

  private _filterCertificates(
    certs: Form2307Certificate[],
    period: FilingPeriod,
    field: string,
  ): Form2307Certificate[] {
    const filtered: Form2307Certificate[] = [];

    for (const cert of certs) {
      // Certificate period must overlap with filing period
      const certStart = cert.period.start;
      const certEnd = cert.period.end;

      const overlaps = certStart <= period.end && certEnd >= period.start;

      if (!overlaps) {
        this._addWarning(
          "CERTIFICATE_OUTSIDE_PERIOD",
          `Form 2307 certificate "${cert.id}" (${certStart}–${certEnd}) ` +
            `does not overlap with filing period (${period.start}–${period.end}). ` +
            `It will be excluded from this filing.`,
          field,
        );
        continue;
      }

      filtered.push(cert);
    }

    return filtered;
  }

  // ── Prior period validation ────────────────────────────────────────────────

  private _validatePriorPeriodOutputs(
    priorOutputs: BaseFilingOutput[],
    currentPeriod: FilingPeriod,
  ): void {
    for (const prior of priorOutputs) {
      // Prior period end must be before current period start
      if (prior.period.end >= currentPeriod.start) {
        this._addError(
          "PRIOR_PERIOD_NOT_PRIOR",
          `Prior period output "${prior.formCode}" covers ${prior.period.start}–${prior.period.end}, ` +
            `which is not entirely before the current period start (${currentPeriod.start}). ` +
            `Ensure priorPeriodOutputs are from earlier periods only.`,
          "priorPeriodOutputs",
        );
      }

      // Warn if prior output has validation errors itself
      if (!prior.validation.valid) {
        this._addWarning(
          "PRIOR_PERIOD_HAS_ERRORS",
          `Prior period output "${prior.formCode}" (${prior.period.start}–${prior.period.end}) ` +
            `has ${prior.validation.errors.length} validation error(s). ` +
            `Accumulated figures may be inaccurate.`,
          "priorPeriodOutputs",
        );
      }
    }
  }

  // ── Adapter requirement validation ────────────────────────────────────────

  private _validateAdapterRequirements(
    caps: AdapterCapabilities,
    expenses: ExpenseRecord[],
    receivedCerts: Form2307Certificate[],
    issuedCerts: Form2307Certificate[],
    priorOutputs: BaseFilingOutput[],
  ): void {
    if (caps.requiresExpenses && expenses.length === 0) {
      this._addError(
        "MISSING_EXPENSES",
        `Adapter "${caps.formCode}" requires expense entries for this period ` +
          `but none were provided or none fall within the filing period.`,
        "expenses",
      );
    }

    if (caps.requiresReceivedCertificates && receivedCerts.length === 0) {
      this._addWarning(
        "MISSING_RECEIVED_CERTS",
        `Adapter "${caps.formCode}" typically uses received Form 2307 certificates ` +
          `for tax credit computation but none were provided.`,
        "receivedCertificates",
      );
    }

    if (caps.requiresIssuedCertificates && issuedCerts.length === 0) {
      this._addError(
        "MISSING_ISSUED_CERTS",
        `Adapter "${caps.formCode}" requires issued Form 2307 certificates ` +
          `(payor role) but none were provided.`,
        "issuedCertificates",
      );
    }

    if (caps.requiresPriorPeriodOutputs && priorOutputs.length === 0) {
      this._addWarning(
        "MISSING_PRIOR_OUTPUTS",
        `Adapter "${caps.formCode}" uses prior period outputs for accumulation ` +
          `but none were provided. Quarter/year-to-date figures may be understated.`,
        "priorPeriodOutputs",
      );
    }

    // Check required prior form codes are present
    if (caps.requiredPriorFormCodes && caps.requiredPriorFormCodes.length > 0) {
      for (const requiredCode of caps.requiredPriorFormCodes) {
        const found = priorOutputs.some((o) => o.formCode === requiredCode);
        if (!found) {
          this._addWarning(
            "MISSING_REQUIRED_PRIOR_FORM",
            `Adapter "${caps.formCode}" expects prior output from form "${requiredCode}" ` +
              `in priorPeriodOutputs but none was found. ` +
              `Accumulated figures from ${requiredCode} will be zero.`,
            "priorPeriodOutputs",
          );
        }
      }
    }
  }

  // ── Currency mismatch handler ──────────────────────────────────────────────

  /**
   * Handles a single currency mismatch according to the config mode.
   * Returns "reject" if the item should be excluded from the context,
   * "include" if it should be included (as-is or post-conversion).
   */
  private _handleCurrencyMismatch(
    itemId: string,
    itemCurrency: CurrencyCode,
    functionalCurrency: CurrencyCode,
    config: CurrencyHandlingConfig,
    itemType: "invoice" | "expense",
  ): "reject" | "include" {
    if (config.mode === "strict") {
      this._addError(
        "CURRENCY_MISMATCH",
        `${itemType} "${itemId}" is in ${itemCurrency} but functional currency ` +
          `is ${functionalCurrency}. Use currencyHandling: { mode: "convert" } ` +
          `to auto-convert, or pre-convert before building the context.`,
        itemType === "invoice" ? `invoices[${itemId}]` : `expenses[${itemId}]`,
      );
      return "reject";
    }

    if (config.mode === "lenient") {
      this._addWarning(
        "CURRENCY_MISMATCH_LENIENT",
        `${itemType} "${itemId}" is in ${itemCurrency} (functional: ${functionalCurrency}). ` +
          `Included as-is — amounts are NOT converted. ` +
          `Adapter figures may be inaccurate for this item.`,
        itemType === "invoice" ? `invoices[${itemId}]` : `expenses[${itemId}]`,
      );
      return "include";
    }

    // mode === "convert"
    if (!config.rates[itemCurrency]) {
      this._addError(
        "CURRENCY_NO_RATE",
        `${itemType} "${itemId}" is in ${itemCurrency} but no FX rate was provided ` +
          `for ${itemCurrency} → ${functionalCurrency} conversion. ` +
          `Add an entry to currencyHandling.rates for "${itemCurrency}".`,
        itemType === "invoice" ? `invoices[${itemId}]` : `expenses[${itemId}]`,
      );
      return "reject";
    }

    // Rate exists — item will be included; actual conversion happens in adapter
    // We store the rate config on the context so adapters can access it
    return "include";
  }

  // ── ValidationResult assembly ─────────────────────────────────────────────

  private _buildValidationResult(): ValidationResult {
    const errors = this.issues.filter((i) => i.severity === "error");
    const warnings = this.issues.filter((i) => i.severity === "warning");
    return {
      valid: errors.length === 0,
      issues: [...this.issues],
      errors,
      warnings,
    };
  }

  private _addError(code: string, message: string, field?: string): void {
    this.issues.push({ severity: "error", code, message, field });
  }

  private _addWarning(code: string, message: string, field?: string): void {
    this.issues.push({ severity: "warning", code, message, field });
  }
}

// =============================================================================
// ── FILING PERIOD HELPER ───────────────────────────────────────────────────────
// =============================================================================

/**
 * Convenience factory for common FilingPeriod shapes.
 * Removes the need for callers to manually compute quarter/month boundaries.
 *
 * @example
 * FilingPeriodHelper.q1(2024)
 * // → { start: "2024-01-01", end: "2024-03-31", year: 2024, quarter: 1 }
 *
 * FilingPeriodHelper.month(2024, 3)
 * // → { start: "2024-03-01", end: "2024-03-31", year: 2024, month: 3 }
 *
 * FilingPeriodHelper.annual(2024)
 * // → { start: "2024-01-01", end: "2024-12-31", year: 2024 }
 */
export const FilingPeriodHelper = {
  q1: (year: number): FilingPeriod => ({
    start: `${year}-01-01`,
    end: `${year}-03-31`,
    year,
    quarter: 1,
  }),

  q2: (year: number): FilingPeriod => ({
    start: `${year}-04-01`,
    end: `${year}-06-30`,
    year,
    quarter: 2,
  }),

  q3: (year: number): FilingPeriod => ({
    start: `${year}-07-01`,
    end: `${year}-09-30`,
    year,
    quarter: 3,
  }),

  q4: (year: number): FilingPeriod => ({
    start: `${year}-10-01`,
    end: `${year}-12-31`,
    year,
    quarter: 4,
  }),

  quarter: (year: number, quarter: 1 | 2 | 3 | 4): FilingPeriod => {
    const map = {
      1: FilingPeriodHelper.q1,
      2: FilingPeriodHelper.q2,
      3: FilingPeriodHelper.q3,
      4: FilingPeriodHelper.q4,
    };
    return map[quarter](year);
  },

  month: (year: number, month: number): FilingPeriod => {
    if (month < 1 || month > 12) {
      throw new RangeError(`Month must be 1–12, got ${month}`);
    }
    const paddedMonth = String(month).padStart(2, "0");
    const daysInMonth = new Date(year, month, 0).getDate();
    return {
      start: `${year}-${paddedMonth}-01`,
      end: `${year}-${paddedMonth}-${String(daysInMonth).padStart(2, "0")}`,
      year,
      month,
    };
  },

  annual: (year: number): FilingPeriod => ({
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    year,
  }),

  /**
   * Returns the canonical start/end dates for a given quarter.
   * Used internally to validate period boundaries.
   */
  quarterBoundaries: (
    year: number,
    quarter: 1 | 2 | 3 | 4,
  ): { start: string; end: string } => {
    const map: Record<number, { start: string; end: string }> = {
      1: { start: `${year}-01-01`, end: `${year}-03-31` },
      2: { start: `${year}-04-01`, end: `${year}-06-30` },
      3: { start: `${year}-07-01`, end: `${year}-09-30` },
      4: { start: `${year}-10-01`, end: `${year}-12-31` },
    };
    return map[quarter];
  },

  /**
   * Determine which quarter a given date falls into.
   * Returns null if the date is not parseable.
   */
  quarterOf: (date: string): 1 | 2 | 3 | 4 | null => {
    const month = new Date(date).getMonth() + 1; // 1-indexed
    if (month <= 3) return 1;
    if (month <= 6) return 2;
    if (month <= 9) return 3;
    if (month <= 12) return 4;
    return null;
  },

  /**
   * Returns true if a date falls within the given period (inclusive).
   */
  contains: (period: FilingPeriod, date: string): boolean => {
    return date >= period.start && date <= period.end;
  },

  /**
   * Returns true if two periods overlap at all.
   */
  overlaps: (a: FilingPeriod, b: FilingPeriod): boolean => {
    return a.start <= b.end && a.end >= b.start;
  },
} as const;

// =============================================================================
// ── CURRENCY CONVERSION HELPER ─────────────────────────────────────────────────
// =============================================================================

/**
 * Standalone helper for adapters to convert amounts at runtime.
 * Adapters call this when they encounter a non-functional-currency
 * amount and the context's currencyHandling is "convert".
 *
 * Note: This does NOT import MajikMoney directly — it accepts the
 * conversion function as a parameter to keep this file free of
 * hard dependencies on the money library.
 *
 * @example — inside an adapter
 * ```ts
 * const phpAmount = convertAmount(
 *   invoice.totalAmount,
 *   invoice.currency,
 *   ctx.currency,
 *   ctx.currencyHandling,
 *   (amount, rate, targetDef) => MajikMoney
 *     .fromMajor(amount, invoice.currency)
 *     .convert(rate, targetDef)
 *     .toMajor()
 * );
 * ```
 */
export function convertAmount(
  amount: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  currencyHandling: CurrencyHandlingConfig | undefined,
  converter: (
    amount: number,
    rate: number,
    targetDef: CurrencyDefinition,
  ) => number,
): number {
  if (fromCurrency === toCurrency) return amount;
  if (!currencyHandling || currencyHandling.mode !== "convert") return amount;

  const rate = currencyHandling.rates[fromCurrency];
  if (!rate) return amount; // already flagged as error during build()

  return converter(amount, rate, currencyHandling.targetCurrencyDefinition);
}

// =============================================================================
// ── FILING CHAIN IMPLEMENTATION ────────────────────────────────────────────────
// =============================================================================

/**
 * Concrete implementation of FilingChain.
 * Stores prior filing outputs indexed by formCode and period.
 * One instance per TaxAccountant, one per tax year.
 */
export class FilingChainImpl implements FilingChain {
  private readonly _store = new Map<string, BaseFilingOutput[]>();

  add(output: BaseFilingOutput): void {
    const key = this._key(output.formCode, output.taxYear);
    const existing = this._store.get(key) ?? [];
    // Replace if same period already exists (amended return scenario)
    const idx = existing.findIndex(
      (o) =>
        o.period.start === output.period.start &&
        o.period.end === output.period.end,
    );
    if (idx >= 0) {
      existing[idx] = output;
    } else {
      existing.push(output);
    }
    // Keep sorted by period start ascending
    existing.sort((a, b) => a.period.start.localeCompare(b.period.start));
    this._store.set(key, existing);
  }

  getByForm(formCode: string, year: number): BaseFilingOutput[] {
    return [...(this._store.get(this._key(formCode, year)) ?? [])];
  }

  getByQuarter(
    formCode: string,
    year: number,
    quarter: 1 | 2 | 3 | 4,
  ): BaseFilingOutput[] {
    return this.getByForm(formCode, year).filter(
      (o) => o.period.quarter === quarter,
    );
  }

  getLatest(formCode: string): BaseFilingOutput | undefined {
    // Search all years, return the most recent by period end
    const all: BaseFilingOutput[] = [];
    for (const [key, outputs] of this._store.entries()) {
      if (key.startsWith(`${formCode}::`)) {
        all.push(...outputs);
      }
    }
    if (all.length === 0) return undefined;
    return all.sort((a, b) => b.period.end.localeCompare(a.period.end))[0];
  }

  clear(formCode?: string, year?: number): void {
    if (!formCode) {
      this._store.clear();
      return;
    }
    if (!year) {
      // Clear all years for this formCode
      for (const key of this._store.keys()) {
        if (key.startsWith(`${formCode}::`)) {
          this._store.delete(key);
        }
      }
      return;
    }
    this._store.delete(this._key(formCode, year));
  }

  private _key(formCode: string, year: number): string {
    return `${formCode}::${year}`;
  }
}

// =============================================================================
// ── ERROR CLASS ────────────────────────────────────────────────────────────────
// =============================================================================

export class FilingContextError extends Error {
  readonly validation: ValidationResult;

  constructor(message: string, validation: ValidationResult) {
    super(message);
    this.name = "FilingContextError";
    this.validation = validation;
  }
}
