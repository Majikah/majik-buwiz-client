/**
 * @file majik-invoice-contact.types.ts
 * @description Type definitions for MajikInvoiceContact.
 *
 * Mirrors the MajikContact type architecture exactly:
 *   MajikContactMeta       → MajikInvoiceContactMeta
 *   MajikContactData       → MajikInvoiceContactData
 *   SerializedMajikContact → SerializedMajikInvoiceContact
 *   MajikContactCard       → MajikContactCard (re-used as-is, no change)
 *
 * The only structural difference from MajikContact is that `meta` is widened
 * from a simple label/notes bag into a full party record carrying all
 * tax, legal, and address information.
 */

import { ISODateTimeString } from "@majikah/majik-invoice";
import { TaxpayerCategory, TaxpayerType, VATType } from "./enums";
import { TaxpayerProfile } from "../accounting/types";

export type ContactManagerQueryMode = "id" | "public_key";

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/**
 * Structured postal address — globally compatible, BIR-aware.
 * Identical to PartyAddress in the GeneralInvoice domain; redeclared here
 * so this file has no cross-domain import dependency.
 */
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

// ---------------------------------------------------------------------------
// MajikInvoiceContactMeta
// ---------------------------------------------------------------------------

/**
 * The `meta` bag of a MajikInvoiceContact.
 *
 * Replaces MajikContactMeta's flat label/notes shape with a full party record.
 * All invoice-party-specific fields live here so the class's crypto fields
 * (`id`, `publicKey`, `fingerprint`, `mlKey`, etc.) remain clean and unchanged.
 *
 * All fields in this meta bag are considered mutable and may be
 * updated by user-facing settings or administrative actions. The
 * previous distinction between "immutable" audit fields and
 * mutable display fields has been removed to allow editing of the
 * full party record from the UI. Consumers should still take care
 * to record audit trails when important identity fields are changed.
 */
export interface MajikInvoiceContactMeta {
  // --- Shared with MajikContactMeta (same field names, same semantics) -------

  /** Display name — typically tradeName or legalName */
  label: string;
  /** Free-text notes */
  notes: string;
  /** Whether this contact is blocked from receiving invoices */
  blocked: boolean;
  /** ISO 8601 datetime — when this contact was created */
  createdAt: ISODateTimeString;
  /** ISO 8601 datetime — when this contact was last mutated */
  updatedAt: ISODateTimeString;

  // --- Party / tax identity fields ------------------------------------------

  /** Legal registered name — immutable after construction */
  legalName: string;
  /** Trade / DBA name */
  tradeName?: string;
  /** Nature of business or industry classification */
  natureOfBusiness?: string;

  // --- Tax fields -----------------------------------------------------------

  /** Tax Identification Number — immutable after construction */
  tin?: string;
  /** Type of tax identifier (e.g. "BIR TIN", "VAT", "EIN") — immutable */
  taxIdType?: string;
  /** Whether this party is tax-exempt */
  taxExempt?: boolean;
  /** Exemption reference number, if applicable */
  taxExemptRef?: string;

  taxProfile?: InvoiceContactTaxProfile;

  // --- Contact fields -------------------------------------------------------

  /** Structured postal address */
  address?: InvoiceContactAddress;
  /** Contact email */
  email?: string;
  /** Contact phone */
  phone?: string;
  /** Website URL */
  website?: string;
  /** Arbitrary extra fields */
  metadata?: Record<string, unknown>;

  bir?: InvoiceContactBIRProfile;
}

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
  /** Legal classification aligned with BIR */
  taxpayerType: TaxpayerType;

  /** More specific classification */
  taxpayerCategory?: TaxpayerCategory;

  /** VAT classification */
  vatType?: VATType;

  /** Subject to percentage tax (2551Q) */
  isPercentageTax?: boolean;

  /** Is this entity a withholding agent */
  isWithholdingAgent?: boolean;

  /** Optional: ATC default mapping hint */
  defaultATC?: string;
}

// ---------------------------------------------------------------------------
// MajikInvoiceContactData — constructor input (mirrors MajikContactData)
// ---------------------------------------------------------------------------

/**
 * Raw input shape passed to the MajikInvoiceContact constructor.
 * Mirrors MajikContactData exactly in structure; only `meta` is widened.
 */
export interface MajikInvoiceContactData {
  id: string;
  /** X25519 KEM public key — WebCrypto CryptoKey or raw-key wrapper */
  publicKey: CryptoKey | { raw: Uint8Array };
  fingerprint: string;
  /** ML-KEM-768 public key, base64-encoded */
  mlKey: string;
  /** Ed25519 public key, base64-encoded (32 bytes) */
  edPublicKeyBase64?: string;
  /** ML-DSA-87 public key, base64-encoded (2592 bytes) */
  mlDsaPublicKeyBase64?: string;
  meta?: Partial<MajikInvoiceContactMeta>;
  majikah_registered?: boolean;
}

// ---------------------------------------------------------------------------
// SerializedMajikInvoiceContact — JSON persistence shape
// (mirrors SerializedMajikContact; publicKey is base64 string here)
// ---------------------------------------------------------------------------

/**
 * Fully serialized MajikInvoiceContact — safe for storage and wire transport.
 * Mirrors SerializedMajikContact with `meta` widened to MajikInvoiceContactMeta.
 */
export interface SerializedMajikInvoiceContact {
  id: string;
  fingerprint: string;
  /** X25519 KEM public key, base64-encoded */
  publicKeyBase64: string;
  /** ML-KEM-768 public key, base64-encoded */
  mlKey: string;
  /** Ed25519 public key, base64-encoded */
  edPublicKeyBase64?: string;
  /** ML-DSA-87 public key, base64-encoded */
  mlDsaPublicKeyBase64?: string;
  meta: MajikInvoiceContactMeta;
  majikah_registered?: boolean;
}

// ---------------------------------------------------------------------------
// MajikInvoiceContactCard — wire/share shape (mirrors MajikContactCard)
// ---------------------------------------------------------------------------

/**
 * Lean shareable card for this contact — all crypto fields included,
 * party metadata exposed as `partyMeta` for receivers who want to
 * pre-populate their own party records.
 *
 * Structurally compatible with MajikContactCard so it can be passed to
 * any API that accepts MajikContactCard.
 */
export interface MajikInvoiceContactCard {
  id: string;
  publicKey: string;
  fingerprint: string;
  /** Label derived from tradeName ?? legalName at export time */
  label: string;
  mlKey: string;
  edPublicKeyBase64?: string;
  mlDsaPublicKeyBase64?: string;
  /** Party metadata snapshot — receivers can use this to seed a Party record */
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

// ---------------------------------------------------------------------------
// Meta update input — explicit shape, excludes immutable fields
// ---------------------------------------------------------------------------

/**
 * Fields on MajikInvoiceContactMeta that are mutable after construction.
 * `legalName`, `tin`, and `taxIdType` are intentionally excluded —
 * they are audit-critical and must not change after a contact is issued.
 */
export interface MajikInvoiceContactMetaUpdateInput {
  // Identity & display
  label?: string;
  notes?: string;
  blocked?: boolean;
  legalName?: string;
  tradeName?: string;
  natureOfBusiness?: string;

  // Tax fields
  tin?: string;
  taxIdType?: string;
  taxExempt?: boolean;
  taxExemptRef?: string;
  taxProfile?: Partial<InvoiceContactTaxProfile>;

  // Contact & address
  address?: Partial<InvoiceContactAddress>;
  email?: string;
  phone?: string;
  website?: string;

  // Misc
  metadata?: Record<string, unknown>;

  // Audit timestamps (editable if required by caller)
  createdAt?: ISODateTimeString;
  updatedAt?: ISODateTimeString;
}

/* -------------------------------
 * Group Types
 * ------------------------------- */

export interface MajikInvoiceContactGroupMeta {
  name: string;
  description: string;
  photoBase64: string | null;
  createdAt: string;
  updatedAt: string;
  color?: string;
}

export interface MajikInvoiceContactGroupData {
  id: string;
  meta?: Partial<MajikInvoiceContactGroupMeta>;
  memberIds?: string[];
  isSystem?: boolean;
}

export interface SerializedMajikInvoiceContactGroup {
  id: string;
  meta: MajikInvoiceContactGroupMeta;
  memberIds: string[];
  isSystem: boolean;
}

export interface MajikInvoiceContactGroupSetOptions {
  /**
   * Override the ID for the resulting group.
   * Defaults to the ID of the first group in the array when not provided.
   */
  id?: string;
  /**
   * Override the name for the resulting group.
   * Defaults to the name of the first group in the array when not provided.
   */
  name?: string;
}

/* -------------------------------
 * Types
 * ------------------------------- */

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
