export type TaxMetadata = {
  label: string;
  rate: number;
};
// =============================================================================
// ── ATC CODE REFERENCE ────────────────────────────────────────────────────────
// =============================================================================

/**
 * Common ATC codes for percentage tax (Section 116 NIRC).
 * Used for Part II transaction rows on Form 2551Q.
 *
 * This is not exhaustive — other ATC codes exist for specific industries.
 * Provide the correct ATC via config.transactionRows[].atcCode.
 */
export const PERCENTAGE_TAX_ATC = {
  /** PT010 — Persons exempt from VAT (Sec 116) */
  NON_VAT_PERSONS: "PT010",

  /** PT040 — Domestic carriers and keepers of garages */
  DOMESTIC_CARRIERS: "PT040",

  /** PT041 — International carriers */
  INTERNATIONAL_CARRIERS: "PT041",

  /** PT060 — Franchise (electric, gas, water utilities) */
  FRANCHISE_UTILITIES: "PT060",

  /** PT070 — Franchise (radio/TV, ≤ 10M gross) */
  FRANCHISE_RADIO_TV: "PT070",

  /** PT090 — Overseas dispatch / communication */
  OVERSEAS_COMMUNICATION: "PT090",

  /** PT101 — Banks & non-bank financial intermediaries */
  BANKS_FINANCIAL: "PT101",

  /** PT102 — Dividends */
  DIVIDENDS: "PT102",

  /** PT103 — Royalties, rentals, and other income */
  ROYALTIES_RENTALS: "PT103",

  /** PT111 — Finance companies (gross receipts) */
  FINANCE_COMPANIES: "PT111",

  /** PT112 — Interest, commissions, discounts (loan/lease) */
  FINANCE_INTEREST: "PT112",

  /** PT120 — Life insurance premiums */
  LIFE_INSURANCE: "PT120",

  /** PT130 — Insurance-related */
  INSURANCE: "PT130",

  /** PT140 — Cockpits */
  COCKPITS: "PT140",

  /** PT150 — Cabarets, night/day clubs */
  CABARETS: "PT150",

  /** PT160 — Boxing exhibitions */
  BOXING: "PT160",

  /** PT170 — Professional basketball games */
  BASKETBALL: "PT170",

  /** PT180 — Jai-alai & race tracks */
  JAI_ALAI_RACE_TRACK: "PT180",
} as const;

export type PercentageTaxATC =
  (typeof PERCENTAGE_TAX_ATC)[keyof typeof PERCENTAGE_TAX_ATC];

// ============================================================================
// PERCENTAGE TAX ATC METADATA
// ============================================================================

export const PERCENTAGE_TAX_ATC_METADATA = {
  PT010: {
    label: "Persons exempt from VAT (Sec. 116)",
    rate: 3,
  },

  PT040: {
    label: "Domestic carriers and keepers of garages",
    rate: 3,
  },

  PT041: {
    label: "International carriers",
    rate: 3,
  },

  PT060: {
    label: "Franchise utilities (electric/gas/water)",
    rate: 2,
  },

  PT070: {
    label: "Franchise radio/TV ≤ ₱10M gross receipts",
    rate: 3,
  },

  PT090: {
    label: "Overseas dispatch/communication",
    rate: 10,
  },

  PT101: {
    label: "Banks & non-bank financial intermediaries",
    rate: 5,
  },

  PT102: {
    label: "Dividends",
    rate: 0,
  },

  PT103: {
    label: "Royalties/rentals/other income",
    rate: 5,
  },

  PT111: {
    label: "Finance companies — gross receipts",
    rate: 5,
  },

  PT112: {
    label: "Interest/commissions/discounts",
    rate: 5,
  },

  PT120: {
    label: "Life insurance premiums",
    rate: 2,
  },

  PT130: {
    label: "Insurance-related activities",
    rate: 5,
  },

  PT140: {
    label: "Cockpits",
    rate: 18,
  },

  PT150: {
    label: "Cabarets/night/day clubs",
    rate: 18,
  },

  PT160: {
    label: "Boxing exhibitions",
    rate: 10,
  },

  PT170: {
    label: "Professional basketball games",
    rate: 15,
  },

  PT180: {
    label: "Jai-alai & race tracks",
    rate: 30,
  },
} as const satisfies Record<PercentageTaxATC, TaxMetadata>;

export type PercentageTaxMetadata =
  (typeof PERCENTAGE_TAX_ATC_METADATA)[PercentageTaxATC];

/**
 * Expanded Withholding Tax (EWT) ATC Codes — Individual
 *
 * Used for BIR Form 1601-EQ / 2307 generation.
 *
 * Prefix:
 *   WI = Individual
 */
export const EWT_ATC_INDIVIDUAL = {
  /** WI010 — Professional/talent fees */
  PROFESSIONAL_FEES: "WI010",

  /** WI020 — Professional entertainers ≤ ₱720k */
  PROFESSIONAL_ENTERTAINERS_LOW: "WI020",

  /** WI021 — Professional entertainers > ₱720k */
  PROFESSIONAL_ENTERTAINERS_HIGH: "WI021",

  /** WI030 — Professional athletes ≤ ₱720k */
  PROFESSIONAL_ATHLETES_LOW: "WI030",

  /** WI031 — Professional athletes > ₱720k */
  PROFESSIONAL_ATHLETES_HIGH: "WI031",

  /** WI040 — Movie/stage/radio/TV directors ≤ ₱720k */
  DIRECTORS_LOW: "WI040",

  /** WI041 — Movie/stage/radio/TV directors > ₱720k */
  DIRECTORS_HIGH: "WI041",

  /** WI050 — Management & technical consultants */
  MANAGEMENT_TECHNICAL: "WI050",

  /** WI060 — Bookkeeping agents/agencies */
  BOOKKEEPING: "WI060",

  /** WI070 — Insurance agents & adjusters */
  INSURANCE_AGENTS: "WI070",

  /** WI080 — Other talent fees ≤ ₱720k */
  TALENT_FEES_LOW: "WI080",

  /** WI081 — Other talent fees > ₱720k */
  TALENT_FEES_HIGH: "WI081",

  /** WI090 — Directors not employees */
  DIRECTORS_NON_EMPLOYEE: "WI090",

  /** WI100 — Rentals */
  RENTALS: "WI100",

  /** WI110 — Cinematic film rentals */
  FILM_RENTALS: "WI110",

  /** WI120 — Prime contractors/sub-contractors */
  CONTRACTORS: "WI120",

  /** WI130 — Estate/trust beneficiaries */
  ESTATE_TRUST: "WI130",

  /** WI140 — Brokers & agents commissions */
  BROKERS_COMMISSION: "WI140",

  /** WI141 — Medical practitioners via partnership */
  MEDICAL_PARTNERSHIP: "WI141",

  /** WI151 — Medical/dental/vet via hospitals */
  MEDICAL_HOSPITALS: "WI151",

  /** WI152 — General professional partnerships */
  GENERAL_PROFESSIONAL_PARTNERSHIP: "WI152",

  /** WI156 — Credit card payments */
  CREDIT_CARD: "WI156",

  /** WI157 — Government goods suppliers */
  GOV_GOODS: "WI157",

  /** WI158 — Top 10k corp goods suppliers */
  TOP_10K_GOODS: "WI158",

  /** WI159 — Overtime services */
  OVERTIME_SERVICES: "WI159",

  /** WI160 — Top 10k corp service suppliers */
  TOP_10K_SERVICES: "WI160",

  /** WI515 — MLM commissions/rebates */
  MLM: "WI515",

  /** WI530 — Funeral embalmers */
  EMBALMERS: "WI530",

  /** WI535 — Funeral parlors */
  FUNERAL_PARLORS: "WI535",

  /** WI540 — Tolling paid to refineries */
  REFINERIES: "WI540",

  /** WI610 — Agricultural products */
  AGRICULTURAL_PRODUCTS: "WI610",

  /** WI630 — Minerals/quarry resources */
  MINERALS: "WI630",
} as const;

/**
 * Expanded Withholding Tax (EWT) ATC Codes — Corporate
 *
 * Prefix:
 *   WC = Corporation
 */
export const EWT_ATC_CORPORATE = {
  /** WC010 — Professional/talent fees */
  PROFESSIONAL_FEES: "WC010",

  /** WC100 — Rentals */
  RENTALS: "WC100",

  /** WC110 — Cinematic film rentals */
  FILM_RENTALS: "WC110",

  /** WC120 — Prime contractors/sub-contractors */
  CONTRACTORS: "WC120",

  /** WC140 — Brokers & agents commissions */
  BROKERS_COMMISSION: "WC140",

  /** WC156 — Credit card payments */
  CREDIT_CARD: "WC156",

  /** WC157 — Government goods suppliers */
  GOV_GOODS: "WC157",

  /** WC158 — Top 10k corp goods suppliers */
  TOP_10K_GOODS: "WC158",

  /** WC160 — Top 10k corp service suppliers */
  TOP_10K_SERVICES: "WC160",

  /** WC515 — MLM commissions/rebates */
  MLM: "WC515",

  /** WC535 — Funeral parlors */
  FUNERAL_PARLORS: "WC535",

  /** WC540 — Tolling paid to refineries */
  REFINERIES: "WC540",

  /** WC610 — Agricultural products */
  AGRICULTURAL_PRODUCTS: "WC610",

  /** WC630 — Minerals/quarry resources */
  MINERALS: "WC630",
} as const;

export type EWTIndividualATC =
  (typeof EWT_ATC_INDIVIDUAL)[keyof typeof EWT_ATC_INDIVIDUAL];

export type EWTCorporateATC =
  (typeof EWT_ATC_CORPORATE)[keyof typeof EWT_ATC_CORPORATE];

export type EWTATC = EWTIndividualATC | EWTCorporateATC;

// ============================================================================
// EWT ATC METADATA — INDIVIDUAL
// ============================================================================

export const EWT_ATC_INDIVIDUAL_METADATA = {
  WI010: {
    label: "Professional/talent fees",
    rate: 10,
  },

  WI020: {
    label: "Professional entertainers ≤ ₱720k",
    rate: 10,
  },

  WI021: {
    label: "Professional entertainers > ₱720k",
    rate: 20,
  },

  WI030: {
    label: "Professional athletes ≤ ₱720k",
    rate: 10,
  },

  WI031: {
    label: "Professional athletes > ₱720k",
    rate: 20,
  },

  WI040: {
    label: "Movie/stage/radio/TV directors ≤ ₱720k",
    rate: 10,
  },

  WI041: {
    label: "Movie/stage/radio/TV directors > ₱720k",
    rate: 20,
  },

  WI050: {
    label: "Management & technical consultants",
    rate: 10,
  },

  WI060: {
    label: "Bookkeeping agents/agencies",
    rate: 10,
  },

  WI070: {
    label: "Insurance agents & adjusters",
    rate: 10,
  },

  WI080: {
    label: "Other talent fees ≤ ₱720k",
    rate: 10,
  },

  WI081: {
    label: "Other talent fees > ₱720k",
    rate: 20,
  },

  WI090: {
    label: "Directors not employed by company",
    rate: 20,
  },

  WI100: {
    label: "Rentals / real & personal properties",
    rate: 5,
  },

  WI110: {
    label: "Cinematographic film rentals",
    rate: 5,
  },

  WI120: {
    label: "Prime contractors/sub-contractors",
    rate: 2,
  },

  WI130: {
    label: "Income distribution to estate/trust beneficiaries",
    rate: 15,
  },

  WI140: {
    label: "Broker commissions & agent fees",
    rate: 10,
  },

  WI141: {
    label: "Medical practitioners via partnership",
    rate: 10,
  },

  WI151: {
    label: "Medical/dental/vet via hospitals/HMOs",
    rate: 10,
  },

  WI152: {
    label: "General professional partnerships",
    rate: 10,
  },

  WI156: {
    label: "Payments made by credit card companies",
    rate: 1,
  },

  WI157: {
    label: "Government local purchase of goods",
    rate: 2,
  },

  WI158: {
    label: "Top 10k private corporations — goods",
    rate: 1,
  },

  WI159: {
    label: "Overtime services to government personnel",
    rate: 15,
  },

  WI160: {
    label: "Top 10k private corporations — services",
    rate: 2,
  },

  WI515: {
    label: "MLM commissions/rebates/discounts",
    rate: 10,
  },

  WI530: {
    label: "Gross payments to embalmers",
    rate: 1,
  },

  WI535: {
    label: "Payments by pre-need companies to funeral parlors",
    rate: 1,
  },

  WI540: {
    label: "Tolling fees paid to refineries",
    rate: 5,
  },

  WI610: {
    label: "Agricultural products",
    rate: 1,
  },

  WI630: {
    label: "Minerals/mineral products/quarry resources",
    rate: 1,
  },
} as const satisfies Record<EWTIndividualATC, TaxMetadata>;

// ============================================================================
// EWT ATC METADATA — CORPORATE
// ============================================================================

export const EWT_ATC_CORPORATE_METADATA = {
  WC010: {
    label: "Professional/talent fees",
    rate: 10,
  },

  WC100: {
    label: "Rentals / real & personal properties",
    rate: 5,
  },

  WC110: {
    label: "Cinematographic film rentals",
    rate: 5,
  },

  WC120: {
    label: "Prime contractors/sub-contractors",
    rate: 2,
  },

  WC140: {
    label: "Broker commissions & agent fees",
    rate: 10,
  },

  WC156: {
    label: "Payments made by credit card companies",
    rate: 1,
  },

  WC157: {
    label: "Government local purchase of goods",
    rate: 2,
  },

  WC158: {
    label: "Top 10k private corporations — goods",
    rate: 1,
  },

  WC160: {
    label: "Top 10k private corporations — services",
    rate: 2,
  },

  WC515: {
    label: "MLM commissions/rebates/discounts",
    rate: 10,
  },

  WC535: {
    label: "Payments by pre-need companies to funeral parlors",
    rate: 1,
  },

  WC540: {
    label: "Tolling fees paid to refineries",
    rate: 5,
  },

  WC610: {
    label: "Agricultural products",
    rate: 1,
  },

  WC630: {
    label: "Minerals/mineral products/quarry resources",
    rate: 1,
  },
} as const satisfies Record<EWTCorporateATC, TaxMetadata>;

export const EWT_ATC_METADATA = {
  ...EWT_ATC_INDIVIDUAL_METADATA,
  ...EWT_ATC_CORPORATE_METADATA,
} as const satisfies Record<EWTIndividualATC | EWTCorporateATC, TaxMetadata>;

export type EWTMetadata = (typeof EWT_ATC_METADATA)[
  | EWTIndividualATC
  | EWTCorporateATC];
