/**
 * @file bir-types.ts
 * @description Pure vocabulary types for the BIR tax accounting system.
 *
 * Zero logic. Zero dependencies on MajikInvoice internals.
 * Everything in the tax-accounting package imports from here.
 *
 * Designed to be jurisdiction-aware (BIR/Philippines first) while
 * keeping the core adapter contract jurisdiction-agnostic enough
 * to extend later.
 */

import { ExpenseRecord } from "../../expenses/expense-record";
import { ISODateString } from "../../types";
import { ResolvedInvoice } from "./invoice-types";

// =============================================================================
// ── ISO PRIMITIVES (re-declared locally to avoid coupling to invoice types) ──
// =============================================================================



/** ISO 8601 datetime — YYYY-MM-DDTHH:mm:ssZ */
export type ISODateTimeString = string;

/** ISO 4217 currency code */
export type CurrencyCode = string;

// =============================================================================
// ── FILING PERIOD ─────────────────────────────────────────────────────────────
// =============================================================================

/**
 * A bounded date range representing the period a filing covers.
 * For quarterly filings: e.g. { start: "2024-01-01", end: "2024-03-31" }
 * For annual filings:    e.g. { start: "2024-01-01", end: "2024-12-31" }
 */
export interface FilingPeriod {
  start: ISODateString;
  end: ISODateString;
  year: number;
  /** 1–4 for quarterly adapters; undefined for monthly and annual */
  quarter?: 1 | 2 | 3 | 4;
  /** 1–12 for monthly adapters; undefined for quarterly and annual */
  month?: number;
}

/**
 * How frequently a form must be filed.
 * Drives the filing chain — monthly outputs feed quarterly, quarterly feed annual.
 */
export type FilingFrequency = "monthly" | "quarterly" | "annual" | "per-event";

// =============================================================================
// ── TAXPAYER PROFILE ──────────────────────────────────────────────────────────
// =============================================================================

/**
 * Legal classification of the taxpaying entity.
 *
 * Drives which forms are applicable:
 *   individual   → 1701A, 1701Q, 1800, 1801
 *   corporation  → 1702RT, 1702Q (future)
 *   partnership  → 1702MX (future)
 *   estate/trust → 1701Q (estates and trusts are explicitly in scope)
 */
export type EntityType =
  | "individual"
  | "corporation"
  | "partnership"
  | "estate"
  | "trust";

/**
 * The taxpayer's VAT/tax registration regime.
 *
 * vat            → files 2550M / 2550Q; cannot file 2551Q
 * percentage-tax → files 2551Q; cannot file 2550M / 2550Q
 * exempt         → neither VAT nor percentage tax; still files income tax
 */
export type TaxRegime = "vat" | "percentage-tax" | "exempt";

/**
 * Income tax rate election — only relevant for individual/self-employed filers.
 * Corporations always use graduated rates.
 *
 * graduated      → Part IV-A of 1701A/1701Q; uses tax table
 * flat-8-percent → Part IV-B of 1701A/1701Q; simpler, no deductions needed
 *                  only available if gross receipts ≤ ₱3M and elected at Q1
 */
export type TaxRateElection = "graduated" | "flat-8-percent";

/**
 * How deductions are computed for income tax purposes.
 * Only meaningful when taxRateElection is "graduated".
 *
 * itemized → actual expenses supported by receipts/records
 * osd      → 40% of gross receipts, no expense substantiation needed
 */
export type DeductionMethod = "itemized" | "osd";

/**
 * The accounting method the taxpayer uses.
 * Affects when income and expenses are recognized for tax purposes.
 */
export type AccountingMethod = "cash" | "accrual";

/**
 * Alphanumeric Tax Code — BIR's classification code for income payment types.
 * Used primarily in withholding tax forms to identify the nature of payment.
 *
 * @example "WC158" — professional fees paid to individuals
 * @example "WI010" — rent paid to individuals
 * @example "WC010" — rent paid to corporations
 */
export type ATCCode = string;

/**
 * The full profile of the taxpaying entity.
 * This is the stable identity that every filing context and adapter references.
 * One TaxAccountant instance = one TaxpayerProfile.
 */
export interface TaxpayerProfile {
  // ── Identity ──────────────────────────────────────────────────────────────
  tin: string;
  rdoCode: string;
  legalName: string;
  tradeName?: string;

  // ── Classification ────────────────────────────────────────────────────────
  entityType: EntityType;
  taxRegime: TaxRegime;

  // ── Tax elections (individual filers) ─────────────────────────────────────
  taxRateElection?: TaxRateElection;
  deductionMethod?: DeductionMethod;
  accountingMethod: AccountingMethod;

  // ── Registration ──────────────────────────────────────────────────────────
  vatRegistrationDate?: ISODateString;
  registeredActivities?: ATCCode[];

  // ── Address ───────────────────────────────────────────────────────────────
  address?: TaxpayerAddress;

  // ── Contact ───────────────────────────────────────────────────────────────
  email?: string;
  phone?: string;

  // ── Spouse (for individual filers — 1701A Part V) ─────────────────────────
  spouse?: SpouseProfile;

  // ── Currency ──────────────────────────────────────────────────────────────
  /**
   * Functional currency of this taxpayer's books.
   * Almost always "PHP" for BIR filings.
   * Stored here so adapters can validate that invoice currencies match.
   */
  functionalCurrency: CurrencyCode;

  // ── Metadata ──────────────────────────────────────────────────────────────
  metadata?: Record<string, unknown>;
}

export interface TaxpayerAddress {
  line1: string;
  line2?: string;
  city: string;
  province?: string;
  postalCode?: string;
  zipCode?: string;
  country: string;
}

/**
 * Spouse information — required for married individual filers
 * who declare combined income on 1701A Part V.
 */
export interface SpouseProfile {
  tin?: string;
  lastName: string;
  firstName: string;
  middleName?: string;
  rdoCode?: string;
  taxRateElection?: TaxRateElection;
  deductionMethod?: DeductionMethod;
  registeredActivities?: ATCCode[];
}

// =============================================================================
// ── FORM 2307 CERTIFICATE ─────────────────────────────────────────────────────
// =============================================================================

/**
 * BIR Form 2307 — Certificate of Creditable Tax Withheld at Source.
 *
 * Issued BY the payor (your client) TO the payee (you).
 * The withheld amounts flow into your income tax credits:
 *   → 1701Q item 38G  (CWT withheld this quarter)
 *   → 1701A item 60   (CWT withheld for the year)
 *
 * Also issued BY you (as payor) TO your suppliers.
 * Those flow into your withholding tax remittance forms:
 *   → 0619E / 1601EQ
 */
export interface Form2307Certificate {
  id: string;

  // ── Payor (the one who withheld) ──────────────────────────────────────────
  payorName: string;
  payorTin: string;
  payorAddress?: string;

  // ── Payee (the one from whom tax was withheld) ────────────────────────────
  payeeName: string;
  payeeTin: string;

  // ── Classification ────────────────────────────────────────────────────────
  atcCode: ATCCode;
  /**
   * Nature of income payment as described in the ATC table.
   * @example "Professional fees", "Rental income"
   */
  incomePaymentDescription?: string;

  // ── Period ────────────────────────────────────────────────────────────────
  /**
   * The quarter/period this certificate covers.
   * BIR Form 2307 is issued per quarter.
   */
  period: FilingPeriod;

  // ── Amounts ───────────────────────────────────────────────────────────────
  incomePayment: number;
  taxWithheld: number;
  currency: CurrencyCode;

  // ── Reference ─────────────────────────────────────────────────────────────
  /**
   * Reference to the MajikInvoice this certificate relates to, if any.
   * Optional — some withholding is not invoice-linked (e.g. rent, salary).
   */
  invoiceId?: string;
  invoiceNumber?: string;

  // ── Timestamps ────────────────────────────────────────────────────────────
  issuedAt: ISODateString;

  metadata?: Record<string, unknown>;
}



// =============================================================================
// ── FILING OPTIONS ────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Runtime options passed to TaxAccountant.
 * Control validation strictness, dry-run mode, and output verbosity.
 */
export interface FilingOptions {
  /**
   * When true, compute() runs but does not throw on validation errors.
   * Useful for previewing a return before all data is finalized.
   * Default: false
   */
  dryRun?: boolean;

  /**
   * When true, throw on any validation warning (not just errors).
   * Use for final pre-submission checks.
   * Default: false
   */
  strict?: boolean;

  /**
   * Include a detailed field-by-field breakdown in the output
   * mapping each computed value to its BIR form item number.
   * Default: true
   */
  includeFieldMap?: boolean;

  /**
   * Include audit trail — which invoices and expenses contributed
   * to each computed line item.
   * Default: false (can be large)
   */
  includeAuditTrail?: boolean;

  /**
   * Override today's date for testing or backdated filing scenarios.
   * Default: current system date
   */
  asOfDate?: ISODateString;
}

// =============================================================================
// ── VALIDATION ────────────────────────────────────────────────────────────────
// =============================================================================

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  field?: string;
  message: string;
  /** BIR form item number this issue relates to, if applicable */
  formItem?: string;
}

export interface ValidationResult {
  valid: boolean;
  /** True if there are no errors (warnings are allowed) */
  issues: ValidationIssue[];
  /** Convenience — errors only */
  errors: ValidationIssue[];
  /** Convenience — warnings only */
  warnings: ValidationIssue[];
}

// =============================================================================
// ── BASE FILING OUTPUT ────────────────────────────────────────────────────────
// =============================================================================

/**
 * Every adapter's compute() returns something that extends BaseFilingOutput.
 * This is the minimum shape the TaxAccountant and FilingChain need
 * to manage outputs regardless of which form produced them.
 */
export interface BaseFilingOutput<TFormCode extends string = string> {
  // ── Identity ──────────────────────────────────────────────────────────────
  formCode: TFormCode;
  formTitle: string;
  filingFrequency: FilingFrequency;

  // ── Period ────────────────────────────────────────────────────────────────
  period: FilingPeriod;
  taxYear: number;

  // ── Taxpayer snapshot ─────────────────────────────────────────────────────
  /** Snapshot of the profile at time of computation — not a live reference */
  taxpayer: Pick<TaxpayerProfile, "tin" | "legalName" | "rdoCode">;

  // ── Key figures (universally meaningful across all forms) ─────────────────
  grossIncome: number;
  taxDue: number;
  taxCredits: number;
  taxPayable: number;
  currency: CurrencyCode;

  // ── Status ────────────────────────────────────────────────────────────────
  /**
   * "draft"     — computed but not yet validated for submission
   * "validated" — passed all validation checks; ready to submit
   * "amended"   — this is a corrected return
   */
  status: "draft" | "validated" | "amended";
  isOverpayment: boolean;
  overpaymentAmount: number;

  // ── Validation ────────────────────────────────────────────────────────────
  validation: ValidationResult;

  // ── Audit trail (optional — controlled by FilingOptions) ──────────────────
  /** IDs of invoices that contributed to this filing */
  invoiceIds?: string[];
  /** IDs of expense entries that contributed to this filing */
  expenseIds?: string[];

  // ── Field map (optional — controlled by FilingOptions) ────────────────────
  /**
   * Maps BIR form item numbers to their computed values.
   * @example { "36A": 500000, "37A": 25000, "38A": 475000 }
   */
  fieldMap?: Record<string, number | string | boolean>;

  // ── Timestamps ────────────────────────────────────────────────────────────
  computedAt: ISODateTimeString;
}

/**
 * Human-readable summary of a filing output.
 * Used by dashboards and notification systems — no raw numbers.
 */
export interface FilingSummary {
  formCode: string;
  formTitle: string;
  period: string;
  taxpayerName: string;
  grossIncome: string;
  taxDue: string;
  taxCredits: string;
  taxPayable: string;
  isOverpayment: boolean;
  overpaymentAmount: string;
  status: BaseFilingOutput["status"];
  validationIssueCount: number;
  computedAt: string;
}

// =============================================================================
// ── ADAPTER CONTEXT HIERARCHY ─────────────────────────────────────────────────
// =============================================================================

/**
 * The root context — only fields that are truly universal across ALL adapters
 * including event-triggered ones like estate tax and donor's tax.
 *
 * Every adapter context extends this.
 */
export interface BaseFilingContext {
  profile: TaxpayerProfile;
  taxYear: number;
  currency: CurrencyCode;
  options?: FilingOptions;
}

/**
 * Context for period-based adapters — income tax, VAT, percentage tax,
 * and withholding tax remittance forms.
 *
 * This is what 1701Q, 1701A, 2550M, 2550Q, 2551Q, 1601EQ all consume.
 */
export interface PeriodFilingContext extends BaseFilingContext {
  period: FilingPeriod;

  /**
   * Revenue-side: the invoices this taxpayer issued during the period.
   * Adapters filter by invoice.issueDate within period.start–period.end.
   */
  invoices: Array<ResolvedInvoice | RawInvoiceSummary>; // <-- Change ResolvableInvoice to ResolvedInvoice

  /**
   * Cost/deduction-side: expenses incurred during the period.
   * Required for:
   *   - Itemized deduction path on income tax adapters
   *   - Input VAT credit computation on VAT adapters
   *   - EWT remittance on withholding tax adapters (payor role)
   * Optional for OSD path and flat-8% income tax.
   */
  expenses?: ExpenseRecord[];

  /**
   * Form 2307 certificates RECEIVED by this taxpayer (payee role).
   * Feeds into income tax credit items (1701Q item 38G, 1701A item 60).
   */
  receivedCertificates?: Form2307Certificate[];

  /**
   * Form 2307 certificates ISSUED by this taxpayer (payor role).
   * Feeds into withholding tax remittance forms (0619E, 1601EQ).
   */
  issuedCertificates?: Form2307Certificate[];

  /**
   * Outputs from prior period filings — enables accumulation chains.
   *
   * For 1701Q Q2: provide the Q1 output so Q2 can include
   *   "Taxable Income Previous Quarter(s)" in item 35.
   * For 1701A: provide all 4 quarterly outputs.
   * For 2550Q: provide the 3 monthly 2550M outputs.
   */
  priorPeriodOutputs?: BaseFilingOutput[];
}

/**
 * Context for event-triggered adapters — estate tax, donor's tax,
 * capital gains tax, documentary stamp tax.
 *
 * Not used in Phase 1 build — defined now so the architecture is complete
 * and future adapters don't require changes to BaseFilingContext.
 */
export interface TransactionFilingContext extends BaseFilingContext {
  transaction: TaxableTransaction;
}

/**
 * Context for pure remittance adapters — 0605, 0619E, 0619F, 1600.
 * These forms don't compute tax — they just remit what was already withheld.
 */
export interface RemittanceFilingContext extends BaseFilingContext {
  period: FilingPeriod;
  issuedCertificates: Form2307Certificate[];
  paymentReference?: string;
}

// =============================================================================
// ── TAXABLE TRANSACTION (for event-triggered adapters — future) ───────────────
// =============================================================================

/**
 * Discriminated union of all event-triggered taxable transactions.
 * Each concrete adapter narrows to its specific member.
 * Not used in Phase 1 — defined here for architectural completeness.
 */
export type TaxableTransaction =
  | EstateTransaction
  | DonationTransaction
  | CapitalGainsTransaction
  | DocumentaryStampTransaction;

export interface EstateTransaction {
  kind: "estate";
  decedentName: string;
  dateOfDeath: ISODateString;
  grossEstate: AssetInventory[];
  allowableDeductions: EstateDeduction[];
  survivingSpouse?: SpouseProfile;
}

export interface DonationTransaction {
  kind: "donation";
  donor: { name: string; tin: string };
  donee: { name: string; tin: string };
  relationship: "stranger" | "relative";
  donations: DonatedAsset[];
  /** Prior donations in the same calendar year — affects graduated computation */
  priorDonationsThisYear?: DonationTransaction[];
}

export interface CapitalGainsTransaction {
  kind: "capital-gains";
  assetType: "real-property" | "shares-listed" | "shares-unlisted";
  seller: { name: string; tin: string };
  buyer: { name: string; tin: string };
  sellingPrice: number;
  costBasis: number;
  fairMarketValue: number;
  acquisitionDate: ISODateString;
  disposalDate: ISODateString;
  /** Required for real property — zonal value from BIR */
  zonalValue?: number;
}

export interface DocumentaryStampTransaction {
  kind: "documentary-stamp";
  documentType: string;
  documentValue: number;
  parties: Array<{ name: string; tin?: string }>;
  executionDate: ISODateString;
}

// ── Supporting types for transactions ─────────────────────────────────────────

export interface AssetInventory {
  description: string;
  fairMarketValue: number;
  assetType:
    | "real-property"
    | "personal-property"
    | "cash"
    | "receivables"
    | "shares"
    | "other";
}

export interface EstateDeduction {
  description: string;
  amount: number;
  deductionType:
    | "funeral-expenses"
    | "judicial-expenses"
    | "claims-against-estate"
    | "unpaid-mortgages"
    | "taxes"
    | "losses"
    | "standard-deduction"
    | "family-home"
    | "other";
}

export interface DonatedAsset {
  description: string;
  fairMarketValue: number;
  assetType:
    | "real-property"
    | "personal-property"
    | "cash"
    | "shares"
    | "other";
}

// =============================================================================
// ── RAW INVOICE SUMMARY ───────────────────────────────────────────────────────
// =============================================================================

/**
 * A lightweight invoice summary for cases where the full GeneralInvoice
 * is not available — e.g. encrypted MajikInvoice that hasn't been decrypted,
 * or invoices from an external system.
 *
 * Adapters accept either GeneralInvoice[] or RawInvoiceSummary[] via the
 * union type on PeriodFilingContext.invoices.
 */
export interface RawInvoiceSummary {
  kind: "raw-summary";
  id: string;
  invoiceNumber?: string;
  issueDate: ISODateString;
  currency: CurrencyCode;
  status: string;
  grossAmount: number;
  vatAmount: number;
  withholdingAmount: number;
  netAmount: number;
  discountAmount: number;
  /** Whether this invoice's full data is unavailable (e.g. encrypted) */
  isPartial: boolean;
}

// =============================================================================
// ── ADAPTER FILING CHAIN ──────────────────────────────────────────────────────
// =============================================================================

/**
 * Registry of prior filing outputs.
 * Allows adapters to look up what was filed in previous periods
 * without needing the caller to pass everything manually.
 *
 * The TaxAccountant holds one FilingChain per tax year.
 */
export interface FilingChain {
  /**
   * Register a completed filing output into the chain.
   */
  add(output: BaseFilingOutput): void;

  /**
   * Retrieve all outputs for a specific form code within a year.
   * @example chain.getByForm("2550M", 2024) → [jan, feb, mar, ...]
   */
  getByForm(formCode: string, year: number): BaseFilingOutput[];

  /**
   * Retrieve outputs for a specific quarter.
   * @example chain.getByQuarter("2550M", 2024, 1) → [jan2550M, feb2550M, mar2550M]
   */
  getByQuarter(
    formCode: string,
    year: number,
    quarter: 1 | 2 | 3 | 4,
  ): BaseFilingOutput[];

  /**
   * Retrieve the most recent output for a form code.
   * Useful for getting prior year excess credits.
   */
  getLatest(formCode: string): BaseFilingOutput | undefined;

  /**
   * Clear all outputs for a specific form code and year.
   */
  clear(formCode?: string, year?: number): void;
}

// =============================================================================
// ── ADAPTER CAPABILITY FLAGS ──────────────────────────────────────────────────
// =============================================================================

/**
 * Declares what a given adapter requires and produces.
 * Allows TaxAccountant to validate context completeness before running.
 */
export interface AdapterCapabilities {
  /** The adapter's primary form code */
  formCode: string;
  formTitle: string;
  filingFrequency: FilingFrequency;

  /** Which context type this adapter accepts */
  contextType: "period" | "transaction" | "remittance";

  /** Whether expenses are required (not just optional) for this adapter */
  requiresExpenses: boolean;

  /** Whether Form 2307 certificates are needed */
  requiresReceivedCertificates: boolean;
  requiresIssuedCertificates: boolean;

  /** Whether prior period outputs are needed for accumulation */
  requiresPriorPeriodOutputs: boolean;

  /**
   * Which prior form codes are needed in the filing chain.
   * @example Form1701AAdapter requires ["1701Q"]
   * @example Form2550QAdapter requires ["2550M"]
   */
  requiredPriorFormCodes?: string[];

  /**
   * Tax regime this adapter is valid for.
   * An adapter for 2551Q is only valid when profile.taxRegime === "percentage-tax".
   * An adapter for 2550M is only valid when profile.taxRegime === "vat".
   * undefined = valid for any regime (e.g. income tax forms)
   */
  validForRegimes?: TaxRegime[];

  /**
   * Entity types this adapter supports.
   * undefined = valid for any entity type
   */
  validForEntityTypes?: EntityType[];
}
