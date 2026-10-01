export const TAXPAYER_CATEGORY = {
  COMPENSATION: "compensation",
  PROFESSIONAL: "professional",
  SOLE_PROPRIETOR: "sole_proprietor",
  MIXED_INCOME: "mixed_income",
  OPC: "one_person_corporation", // One Person Corporation,
  MSME: "msme", // Micro, Small, and Medium Enterprise
  DOMESTIC_CORPORATION: "domestic_corporation",
  FOREIGN_CORPORATION: "foreign_corporation",
  PARTNERSHIP: "partnership",
  GPP: "general_professional_partnership",
  COOPERATIVE: "cooperative",
  NON_PROFIT: "non_profit",
} as const;

export type TaxpayerCategory =
  (typeof TAXPAYER_CATEGORY)[keyof typeof TAXPAYER_CATEGORY];

export const TAXPAYER_TYPE = {
  INDIVIDUAL_PROFESSIONAL: "individual-professional",
  INDIVIDUAL_BUSINESS: "individual-business",
  CORPORATION: "corporation",
  PARTNERSHIP: "partnership",
  COOPERATIVE: "cooperative",
  // NON_INDIVIDUAL: "non_individual",
} as const;

export type TaxpayerType = (typeof TAXPAYER_TYPE)[keyof typeof TAXPAYER_TYPE];

export const VAT_TYPE = {
  VAT: "VAT",
  NON_VAT: "NON_VAT",
  EXEMPT: "EXEMPT",
} as const;

export type VATType = (typeof VAT_TYPE)[keyof typeof VAT_TYPE];
