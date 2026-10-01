// ---------------------------------------------------------------------------
// Currency handling configuration
// ---------------------------------------------------------------------------

import { ExpenseRecord } from "../../expenses/expense-record";
import {
  AdapterCapabilities,
  BaseFilingOutput,
  CurrencyCode,

  FilingOptions,
  FilingPeriod,
  Form2307Certificate,
  RawInvoiceSummary,
  TaxpayerProfile,
} from "./bir-types";
import { ResolvableInvoice } from "./invoice-types";

/**
 * CurrencyDefinition mirrors @thezelijah/majik-money's CurrencyDefinition.
 * Declared here to avoid a hard import coupling — the caller passes it in.
 * Must match the shape MajikMoney.convert() expects.
 */
export interface CurrencyDefinition {
  code: CurrencyCode;
  symbol: string;
  minorUnits: number;
  name: string;
}

/**
 * FX rate map — keys are source currency codes, values are the rate
 * to multiply by to reach the functional (target) currency.
 *
 * @example
 * // To convert USD → PHP at ₱56.50 per $1:
 * { USD: 56.50, EUR: 61.20, SGD: 42.10 }
 */
export type FxRateMap = Record<CurrencyCode, number>;

/**
 * Three-mode discriminated union controlling how currency mismatches
 * are handled during context assembly.
 *
 * strict  — mismatched currencies are flagged as errors in ValidationResult.
 *           The context will not build unless dryRun: true.
 *
 * lenient — mismatched currencies are flagged as warnings and the invoice/
 *           expense is included as-is. Adapters receive the raw amount
 *           without conversion. Use only for previewing incomplete data.
 *
 * convert — amounts in foreign currencies are auto-converted to
 *           functionalCurrency using MajikMoney.convert() and the
 *           provided FxRateMap. Unconvertible currencies (not in the
 *           rate map) are flagged as errors.
 */
export type CurrencyHandlingConfig =
  | { mode: "strict" }
  | { mode: "lenient" }
  | {
      mode: "convert";
      rates: FxRateMap;
      /**
       * The target currency definition — must match profile.functionalCurrency.
       * Passed directly to MajikMoney.convert() as the targetCurrency arg.
       */
      targetCurrencyDefinition: CurrencyDefinition;
    };


// ---------------------------------------------------------------------------
// Builder input type
// ---------------------------------------------------------------------------

export interface FilingContextBuilderInput {
  profile: TaxpayerProfile;
  period: FilingPeriod;
  taxYear: number;
  currency: CurrencyCode;
  options?: FilingOptions;

  /**
   * Invoice inputs — accepts either:
   * - ResolvableInvoice[] (MajikInvoice instances)
   * - RawInvoiceSummary[] (pre-flattened, e.g. from a remote API)
   * - A mix of both
   */
  invoices?: Array<ResolvableInvoice | RawInvoiceSummary>;

  expenses?: ExpenseRecord[];
  receivedCertificates?: Form2307Certificate[];
  issuedCertificates?: Form2307Certificate[];
  priorPeriodOutputs?: BaseFilingOutput[];

  /**
   * Currency normalization config.
   * Defaults to { mode: "strict" } if omitted.
   */
  currencyHandling?: CurrencyHandlingConfig;

  /**
   * Optional adapter capabilities — when provided, the builder enforces
   * entity type compatibility and regime compatibility before returning.
   * If omitted, these checks happen later in TaxAccountant.
   */
  adapterCapabilities?: AdapterCapabilities;
}

// ---------------------------------------------------------------------------
// Normalization result — internal tracking per invoice/expense
// ---------------------------------------------------------------------------

export interface NormalizedAmount {
  originalCurrency: CurrencyCode;
  originalAmount: number;
  normalizedAmount: number;
  wasConverted: boolean;
  conversionRate?: number;
}
