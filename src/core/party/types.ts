/**
 * @file types.ts (invoice contact domain)
 * Everything that can derive from @majikah/majik-contact now does.
 */
import type {
  MajikContactCard,
  MajikContactData,
  MajikContactGroupData,
  MajikContactGroupMeta,
  MajikContactGroupSetOptions,
  MajikContactMeta,
  SerializedMajikContact,
  SerializedMajikContactGroup,
} from "@majikah/majik-contact";
import { TaxpayerCategory, TaxpayerType, VATType } from "./enums";
import { TaxpayerProfile } from "../accounting/types";

export type ContactManagerQueryMode = "id" | "public_key";

// --- Address ---------------------------------------------------------------

export interface InvoiceContactAddress {
  line1: string;
  line2?: string;
  city: string;
  stateOrProvince?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 country code — e.g. "PH", "US" */
  country: string;
  branchCode?: string;
  district?: string;
}

// --- BIR / tax profile (unchanged) -----------------------------------------

export interface InvoiceContactBIRProfile extends Pick<
  TaxpayerProfile,
  | "rdoCode"
  | "entityType"
  | "taxRegime"
  | "taxRateElection"
  | "deductionMethod"
  | "accountingMethod"
  | "vatRegistrationDate"
  | "registeredActivities"
  | "functionalCurrency"
  | "spouse"
> {}

export interface InvoiceContactTaxProfile {
  taxpayerType: TaxpayerType;
  taxpayerCategory?: TaxpayerCategory;
  vatType?: VATType;
  isPercentageTax?: boolean;
  isWithholdingAgent?: boolean;
  defaultATC?: string;
}

// --- Meta ------------------------------------------------------------------

/**
 * Extends MajikContactMeta. The five base fields are optional there; here they
 * are redeclared required (narrowing is legal in an `extends`) because the
 * constructor always fills them. All fields are mutable via updateMeta().
 */
export interface MajikInvoiceContactMeta extends MajikContactMeta {
  label: string;
  notes: string;
  blocked: boolean;
  createdAt: string;
  updatedAt: string;

  legalName: string;
  tradeName?: string;
  natureOfBusiness?: string;

  tin?: string;
  taxIdType?: string;
  taxExempt?: boolean;
  taxExemptRef?: string;
  taxProfile?: InvoiceContactTaxProfile;

  address?: InvoiceContactAddress;
  email?: string;
  phone?: string;
  website?: string;
  metadata?: Record<string, unknown>;

  bir?: InvoiceContactBIRProfile;
}

// --- Data / serialized / card (all derived) --------------------------------

export interface MajikInvoiceContactData
  extends MajikContactData<MajikInvoiceContactMeta> {}

export interface SerializedMajikInvoiceContact
  extends SerializedMajikContact<MajikInvoiceContactMeta> {
  /** required here (optional on the base type) */
  meta: MajikInvoiceContactMeta;
}

export interface MajikInvoiceContactCard extends MajikContactCard {
  /** Party snapshot receivers can use to seed their own party record */
  partyMeta: Pick<
    MajikInvoiceContactMeta,
    | "legalName"
    | "tradeName"
    | "tin"
    | "taxIdType"
    | "taxExempt"
    | "taxExemptRef"
    | "address"
    | "email"
    | "phone"
    | "website"
  >;
}

/** Unchanged from today. */
export interface MajikInvoiceContactMetaUpdateInput {
  label?: string;
  notes?: string;
  blocked?: boolean;
  legalName?: string;
  tradeName?: string;
  natureOfBusiness?: string;
  tin?: string;
  taxIdType?: string;
  taxExempt?: boolean;
  taxExemptRef?: string;
  taxProfile?: Partial<InvoiceContactTaxProfile>;
  address?: Partial<InvoiceContactAddress>;
  email?: string;
  phone?: string;
  website?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

// --- Groups: identical to base, so aliases ---------------------------------

export type MajikInvoiceContactGroupMeta = MajikContactGroupMeta;
export type MajikInvoiceContactGroupData = MajikContactGroupData;
export type SerializedMajikInvoiceContactGroup = SerializedMajikContactGroup;
export type MajikInvoiceContactGroupSetOptions = MajikContactGroupSetOptions;

// --- Manager JSON (unchanged) ----------------------------------------------

export interface MajikInvoiceContactManagerJSON {
  contacts: MajikInvoiceContactDirectoryData;
  groups: MajikInvoiceContactGroupManagerData;
}
export interface MajikInvoiceContactDirectoryData {
  contacts: SerializedMajikInvoiceContact[];
}
export interface MajikInvoiceContactGroupManagerData {
  groups: SerializedMajikInvoiceContactGroup[];
}