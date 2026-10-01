import {
  EWTATC,
  EWTCorporateATC,
  EWTIndividualATC,
  PercentageTaxATC,
  TaxMetadata,
  EWT_ATC_METADATA,
  EWT_ATC_INDIVIDUAL_METADATA,
  EWT_ATC_CORPORATE_METADATA,
  PERCENTAGE_TAX_ATC_METADATA,
} from "../adapters/enums";

// =============================================================================
// ── EWT HELPERS ───────────────────────────────────────────────────────────────
// =============================================================================

/**
 * Get metadata for any EWT ATC code.
 */
export const getEWTMetadata = (atc: EWTATC): TaxMetadata => {
  return EWT_ATC_METADATA[atc];
};

/**
 * Get withholding tax rate for an EWT ATC.
 */
export const getEWTRate = (atc: EWTATC): number => {
  return EWT_ATC_METADATA[atc].rate;
};

/**
 * Get readable label for an EWT ATC.
 */
export const getEWTLabel = (atc: EWTATC): string => {
  return EWT_ATC_METADATA[atc].label;
};

/**
 * Check if ATC exists in registry.
 */
export const isEWTATC = (value: string): value is EWTATC => {
  return value in EWT_ATC_METADATA;
};

/**
 * Check if ATC is individual.
 */
export const isIndividualEWTATC = (atc: EWTATC): atc is EWTIndividualATC => {
  return atc in EWT_ATC_INDIVIDUAL_METADATA;
};

/**
 * Check if ATC is corporate.
 */
export const isCorporateEWTATC = (atc: EWTATC): atc is EWTCorporateATC => {
  return atc in EWT_ATC_CORPORATE_METADATA;
};

/**
 * Compute withholding amount.
 */
export const computeEWTAmount = (
  taxableAmount: number,
  atc: EWTATC,
): number => {
  const rate = getEWTRate(atc);

  return (taxableAmount * rate) / 100;
};

/**
 * Compute net amount after withholding.
 */
export const computeNetAfterEWT = (
  grossAmount: number,
  atc: EWTATC,
): number => {
  return grossAmount - computeEWTAmount(grossAmount, atc);
};

/**
 * Format ATC label for dropdowns/UI.
 *
 * Example:
 * WI010 — Professional/talent fees (10%)
 */
export const formatEWTATCOptionLabel = (atc: EWTATC): string => {
  const meta = getEWTMetadata(atc);

  return `${atc} — ${meta.label} (${meta.rate}%)`;
};

/**
 * Get all EWT ATC codes.
 */
export const getAllEWTATCs = (): EWTATC[] => {
  return Object.keys(EWT_ATC_METADATA) as EWTATC[];
};

/**
 * Get all individual EWT ATCs.
 */
export const getIndividualEWTATCs = (): EWTIndividualATC[] => {
  return Object.keys(EWT_ATC_INDIVIDUAL_METADATA) as EWTIndividualATC[];
};

/**
 * Get all corporate EWT ATCs.
 */
export const getCorporateEWTATCs = (): EWTCorporateATC[] => {
  return Object.keys(EWT_ATC_CORPORATE_METADATA) as EWTCorporateATC[];
};

/**
 * Dropdown-ready EWT options.
 */
export const getEWTOptions = () => {
  return getAllEWTATCs().map((atc) => ({
    value: atc,
    label: formatEWTATCOptionLabel(atc),
    rate: getEWTRate(atc),
  }));
};

/**
 * Dropdown-ready individual EWT options.
 */
export const getIndividualEWTOptions = () => {
  return getIndividualEWTATCs().map((atc) => ({
    value: atc,
    label: formatEWTATCOptionLabel(atc),
    rate: getEWTRate(atc),
  }));
};

/**
 * Dropdown-ready corporate EWT options.
 */
export const getCorporateEWTOptions = () => {
  return getCorporateEWTATCs().map((atc) => ({
    value: atc,
    label: formatEWTATCOptionLabel(atc),
    rate: getEWTRate(atc),
  }));
};

/**
 * Search EWT ATCs by label.
 */
export const searchEWTATCs = (query: string): EWTATC[] => {
  const normalized = query.toLowerCase();

  return getAllEWTATCs().filter((atc) => {
    const meta = EWT_ATC_METADATA[atc];

    return (
      atc.toLowerCase().includes(normalized) ||
      meta.label.toLowerCase().includes(normalized)
    );
  });
};

// =============================================================================
// ── PERCENTAGE TAX HELPERS ───────────────────────────────────────────────────
// =============================================================================

/**
 * Get percentage tax metadata.
 */
export const getPercentageTaxMetadata = (
  atc: PercentageTaxATC,
): TaxMetadata => {
  return PERCENTAGE_TAX_ATC_METADATA[atc];
};

/**
 * Get percentage tax rate.
 */
export const getPercentageTaxRate = (atc: PercentageTaxATC): number => {
  return PERCENTAGE_TAX_ATC_METADATA[atc].rate;
};

/**
 * Get percentage tax label.
 */
export const getPercentageTaxLabel = (atc: PercentageTaxATC): string => {
  return PERCENTAGE_TAX_ATC_METADATA[atc].label;
};

/**
 * Check if valid percentage tax ATC.
 */
export const isPercentageTaxATC = (
  value: string,
): value is PercentageTaxATC => {
  return value in PERCENTAGE_TAX_ATC_METADATA;
};

/**
 * Compute percentage tax amount.
 */
export const computePercentageTaxAmount = (
  taxableAmount: number,
  atc: PercentageTaxATC,
): number => {
  const rate = getPercentageTaxRate(atc);

  return (taxableAmount * rate) / 100;
};

/**
 * Format percentage tax option label.
 */
export const formatPercentageTaxOptionLabel = (
  atc: PercentageTaxATC,
): string => {
  const meta = getPercentageTaxMetadata(atc);

  return `${atc} — ${meta.label} (${meta.rate}%)`;
};

/**
 * Get all percentage tax ATCs.
 */
export const getAllPercentageTaxATCs = (): PercentageTaxATC[] => {
  return Object.keys(PERCENTAGE_TAX_ATC_METADATA) as PercentageTaxATC[];
};

/**
 * Dropdown-ready percentage tax options.
 */
export const getPercentageTaxOptions = () => {
  return getAllPercentageTaxATCs().map((atc) => ({
    value: atc,
    label: formatPercentageTaxOptionLabel(atc),
    rate: getPercentageTaxRate(atc),
  }));
};

/**
 * Search percentage tax ATCs.
 */
export const searchPercentageTaxATCs = (query: string): PercentageTaxATC[] => {
  const normalized = query.toLowerCase();

  return getAllPercentageTaxATCs().filter((atc) => {
    const meta = PERCENTAGE_TAX_ATC_METADATA[atc];

    return (
      atc.toLowerCase().includes(normalized) ||
      meta.label.toLowerCase().includes(normalized)
    );
  });
};
