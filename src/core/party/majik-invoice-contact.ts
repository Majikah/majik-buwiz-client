import { MajikRecipient } from "@majikah/majik-envelope";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
} from "../utils/utilities";
import { MajikInvoiceContactError } from "./errors";
import type {
  InvoiceContactAddress,
  MajikInvoiceContactCard,
  MajikInvoiceContactData,
  MajikInvoiceContactMeta,
  SerializedMajikInvoiceContact,
} from "./types";
import { MajikContact } from "@majikah/majik-contact";
import { ExpectedSigner } from "@majikah/majik-signature";
import { TaxpayerProfile } from "../accounting/types";

// ---------------------------------------------------------------------------
// MajikInvoiceContact
// ---------------------------------------------------------------------------

/**
 * Majik Invoice Contact
 * ---
 *
 * @description MajikInvoiceContact — a MajikContact whose `meta` carries the
 * full party/tax identity of a billing entity (issuer or recipient).
 *
 * Structural contract:
 *   - Mirrors MajikContact field-for-field on the crypto side:
 *       id, publicKey, fingerprint, mlKey, edPublicKeyBase64, mlDsaPublicKeyBase64
 *   - `meta` is widened from MajikContactMeta to MajikInvoiceContactMeta,
 *     adding legalName, tin, address, tax fields, etc.
 *   - `toContactCard()` is async (matches MajikContact) and returns a
 *     MajikInvoiceContactCard — a strict superset of MajikContactCard.
 *   - All assertion, update, block/unblock, and serialization patterns
 *     follow MajikContact's conventions exactly.
 *
 * Immutable after construction (audit-critical):
 *   id, publicKey, fingerprint, mlKey, edPublicKeyBase64, mlDsaPublicKeyBase64,
 *
 * Mutable via update methods:
 *   meta.label, meta.notes, meta.blocked, meta.tradeName,
 *   meta.natureOfBusiness, meta.taxExempt, meta.taxExemptRef,
 *   meta.address, meta.email, meta.phone, meta.website, meta.metadata
 *   meta.legalName, meta.tin, meta.taxIdType
 */
export class MajikInvoiceContact {
  // --- Crypto fields (identical to MajikContact) ----------------------------

  public readonly id: string;
  public readonly publicKey: CryptoKey | { raw: Uint8Array };
  public readonly fingerprint: string;
  public readonly mlKey: string;
  public readonly edPublicKeyBase64: string;
  public readonly mlDsaPublicKeyBase64: string;

  // --- Meta (widened from MajikContactMeta → MajikInvoiceContactMeta) -------

  /**
   * All party/tax identity data lives here, following the same pattern as
   * MajikContact.meta. The object itself is public and mutable (matching
   * MajikContact's contract), but audit-critical fields (`legalName`,
   * `tin`, `taxIdType`) are protected by the update methods' assertion guards.
   */
  public meta: MajikInvoiceContactMeta;

  // --- Majikah registration status (identical to MajikContact) --------------

  private majikah_registered?: boolean;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(data: MajikInvoiceContactData) {
    this.assertId(data.id);
    this.assertPublicKey(data.publicKey);
    this.assertMLKey(data.mlKey);
    this.assertFingerprint(data.fingerprint);
    this.assertLegalName(data.meta?.legalName);

    if (data.meta?.tin !== undefined) this.assertTIN(data.meta.tin);
    // if (data.meta?.email !== undefined) this.assertEmail(data.meta.email);
    // if (data.meta?.phone !== undefined) this.assertPhone(data.meta.phone);
    // if (data.meta?.address !== undefined) this.assertAddress(data.meta.address);

    // Crypto fields
    this.id = data.id;
    this.publicKey = data.publicKey;
    this.fingerprint = data.fingerprint;
    this.mlKey = data.mlKey;
    this.edPublicKeyBase64 = data.edPublicKeyBase64 || "";
    this.mlDsaPublicKeyBase64 = data.mlDsaPublicKeyBase64 || "";

    // Meta — merge defaults exactly as MajikContact does
    const now = new Date().toISOString();
    this.meta = {
      // MajikContactMeta-compatible fields
      label:
        data.meta?.label || data.meta?.tradeName || data.meta?.legalName || "",
      notes: data.meta?.notes || "",
      blocked: data.meta?.blocked || false,
      createdAt: data.meta?.createdAt || now,
      updatedAt: data.meta?.updatedAt || now,

      // Party identity — legalName is required, rest are optional
      legalName: data.meta!.legalName!.trim(),
      tradeName: data.meta?.tradeName?.trim(),
      natureOfBusiness: data.meta?.natureOfBusiness?.trim(),

      // Tax fields
      tin: data.meta?.tin?.trim(),
      taxIdType: data.meta?.taxIdType?.trim(),
      taxExempt: data.meta?.taxExempt ?? false,
      taxExemptRef: data.meta?.taxExemptRef?.trim(),
      taxProfile: data.meta?.taxProfile,

      // Contact fields
      address: data.meta?.address ? { ...data.meta.address } : undefined,
      email: data.meta?.email?.trim().toLowerCase(),
      phone: data.meta?.phone?.trim(),
      website: data.meta?.website?.trim(),
      metadata: data.meta?.metadata ? { ...data.meta.metadata } : undefined,
    };
    this.hydrateBIRProfile();

    this.majikah_registered = data.majikah_registered;
  }

  // ---------------------------------------------------------------------------
  // Static factory: create() — mirrors MajikContact.create()
  // ---------------------------------------------------------------------------

  static create(
    id: string,
    publicKey: CryptoKey | { raw: Uint8Array },
    mlKey: string,
    fingerprint: string,
    meta?: Partial<MajikInvoiceContactMeta>,
    edPublicKeyBase64?: string,
    mlDsaPublicKeyBase64?: string,
  ): MajikInvoiceContact {
    return new MajikInvoiceContact({
      id,
      publicKey,
      fingerprint,
      mlKey,
      meta,
      edPublicKeyBase64,
      mlDsaPublicKeyBase64,
    });
  }

  toBIRProfile(): TaxpayerProfile {
    if (!this.meta.tin?.trim()) {
      throw new MajikInvoiceContactError(
        "Cannot construct TaxpayerProfile without TIN",
        "INVALID_TAXPAYER_PROFILE",
        { field: "meta.tin" },
      );
    }
    this.hydrateBIRProfile();

    return {
      tin: this.meta.tin,
      legalName: this.meta.legalName,
      tradeName: this.meta.tradeName,

      email: this.meta.email,
      phone: this.meta.phone,

      address: this.meta.address ? { ...this.meta.address } : undefined,

      rdoCode: this.meta.bir!.rdoCode,

      entityType: this.meta.bir!.entityType,
      taxRegime: this.meta.bir!.taxRegime,

      taxRateElection: this.meta.bir!.taxRateElection,
      deductionMethod: this.meta.bir!.deductionMethod,
      accountingMethod: this.meta.bir!.accountingMethod,

      vatRegistrationDate: this.meta.bir!.vatRegistrationDate,

      registeredActivities: this.meta.bir!.registeredActivities
        ? [...this.meta.bir!.registeredActivities]
        : undefined,

      functionalCurrency: this.meta.bir!.functionalCurrency,

      metadata: this.meta.metadata ? { ...this.meta.metadata } : undefined,

      spouse: this.meta.bir!.spouse ? { ...this.meta.bir!.spouse } : undefined,
    };
  }

  private hydrateBIRProfile(): void {
    const bir = this.meta.bir;

    this.meta.bir = {
      // ---------------------------------------------------------------------
      // Existing BIR values preserved when present
      // ---------------------------------------------------------------------

      rdoCode: bir?.rdoCode ?? "000",

      entityType: bir?.entityType ?? "individual",

      taxRegime: bir?.taxRegime ?? "vat",

      accountingMethod: bir?.accountingMethod ?? "cash",

      taxRateElection: bir?.taxRateElection || "flat-8-percent",

      deductionMethod: bir?.deductionMethod,

      vatRegistrationDate: bir?.vatRegistrationDate,

      registeredActivities: bir?.registeredActivities
        ? [...bir.registeredActivities]
        : [],

      functionalCurrency: bir?.functionalCurrency ?? "PHP",

      spouse: bir?.spouse ? { ...bir.spouse } : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Static factory: fromJSON() — mirrors MajikContact.fromJSON()
  // ---------------------------------------------------------------------------

  static fromJSON(
    serialized: SerializedMajikInvoiceContact,
  ): MajikInvoiceContact {
    try {
      const publicKeyRaw = new Uint8Array(
        base64ToArrayBuffer(serialized.publicKeyBase64),
      );

      return new MajikInvoiceContact({
        id: serialized.id,
        fingerprint: serialized.fingerprint,
        publicKey: { raw: publicKeyRaw },
        mlKey: serialized.mlKey,
        edPublicKeyBase64: serialized.edPublicKeyBase64,
        mlDsaPublicKeyBase64: serialized.mlDsaPublicKeyBase64,
        meta: serialized.meta,
        majikah_registered: serialized.majikah_registered,
      });
    } catch (err) {
      if (err instanceof MajikInvoiceContactError) throw err;
      throw new MajikInvoiceContactError(
        "Failed to deserialize MajikInvoiceContact",
        "DESERIALIZATION_FAILED",
        { cause: err },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Serialization: toJSON() — mirrors MajikContact.toJSON()
  // ---------------------------------------------------------------------------

  async toJSON(): Promise<SerializedMajikInvoiceContact> {
    return {
      id: this.id,
      fingerprint: this.fingerprint,
      publicKeyBase64: await this.getPublicKeyBase64(),
      mlKey: this.mlKey,
      edPublicKeyBase64: this.edPublicKeyBase64,
      mlDsaPublicKeyBase64: this.mlDsaPublicKeyBase64,
      meta: { ...this.meta },
      majikah_registered: this.majikah_registered,
    };
  }

  // ---------------------------------------------------------------------------
  // toContactCard() — async, mirrors MajikContact.toContactCard()
  // Label uses tradeName ?? legalName from meta (party identity, not address-book label)
  // ---------------------------------------------------------------------------

  async toContactCard(): Promise<MajikInvoiceContactCard> {
    const publicKeyBase64 = await this.getPublicKeyBase64();

    return {
      id: this.id,
      publicKey: publicKeyBase64,
      fingerprint: this.fingerprint,
      // Use party's own naming, not the address-book label stored in meta.label
      label: this.meta.tradeName?.trim() || this.meta.legalName,
      mlKey: this.mlKey,
      edPublicKeyBase64: this.edPublicKeyBase64 || undefined,
      mlDsaPublicKeyBase64: this.mlDsaPublicKeyBase64 || undefined,
      partyMeta: {
        legalName: this.meta.legalName,
        tradeName: this.meta.tradeName,
        tin: this.meta.tin,
        taxIdType: this.meta.taxIdType,
        taxExempt: this.meta.taxExempt,
        taxExemptRef: this.meta.taxExemptRef,
        address: this.meta.address ? { ...this.meta.address } : undefined,
        email: this.meta.email,
        phone: this.meta.phone,
        website: this.meta.website,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // toMajikContact() — convert to base MajikContact
  // ---------------------------------------------------------------------------

  toMajikContact(): MajikContact {
    return MajikContact.create(
      this.id,
      this.publicKey,
      this.mlKey,
      this.fingerprint,
      {
        label: this.meta.label,
        notes: this.meta.notes,
        blocked: this.meta.blocked,
        createdAt: this.meta.createdAt,
        updatedAt: this.meta.updatedAt,
      },
      this.edPublicKeyBase64 || undefined,
      this.mlDsaPublicKeyBase64 || undefined,
    ).setMajikahStatus(this.isMajikahRegistered());
  }

  // ---------------------------------------------------------------------------
  // Static: toMajikContacts()
  // Safely converts an array of MajikInvoiceContact → MajikContact[]
  // ---------------------------------------------------------------------------

  static toMajikContacts(
    contacts?: MajikInvoiceContact[] | null,
  ): MajikContact[] {
    if (!contacts || contacts.length === 0) return [];

    return contacts.map((c) => c.toMajikContact());
  }

  // ---------------------------------------------------------------------------
  // Signing and Encryption Format
  // ---------------------------------------------------------------------------

  toExpectedSigner(): ExpectedSigner {
    if (
      !this.edPublicKeyBase64?.trim() ||
      !this.mlDsaPublicKeyBase64?.trim() ||
      !this.fingerprint?.trim()
    ) {
      throw new Error(`Invalid Keys. Cannot export to Expected Signer.`);
    }

    return {
      edPublicKey: this.edPublicKeyBase64,
      mlDsaPublicKey: this.mlDsaPublicKeyBase64,
      signerId: this.fingerprint,
    };
  }

  toMajikRecipient(): MajikRecipient {
    if (!this.mlKey?.trim() || !this.fingerprint?.trim()) {
      throw new Error(`Invalid Keys. Cannot export to Majik Recipient.`);
    }

    const mlPubKey = base64ToUint8Array(this.mlKey);
    return {
      fingerprint: this.fingerprint,
      mlKemPublicKey: mlPubKey,
    };
  }

  // ---------------------------------------------------------------------------
  // getPublicKeyBase64() — mirrors MajikContact exactly
  // ---------------------------------------------------------------------------

  async getPublicKeyBase64(): Promise<string> {
    try {
      const raw = await crypto.subtle.exportKey(
        "raw",
        this.publicKey as CryptoKey,
      );
      return arrayBufferToBase64(raw);
    } catch (e) {
      const maybe: any = this.publicKey as any;
      if (maybe && maybe.raw instanceof Uint8Array) {
        return arrayBufferToBase64(maybe.raw.buffer);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // getDisplayName() — mirrors MajikContact.getDisplayName()
  // Resolves: tradeName → legalName → publicKey (last resort)
  // ---------------------------------------------------------------------------

  async getDisplayName(): Promise<string> {
    return (
      this.meta.tradeName?.trim() ||
      this.meta.legalName ||
      (await this.getPublicKeyBase64())
    );
  }

  // ---------------------------------------------------------------------------
  // General metadata update
  // ---------------------------------------------------------------------------

  updateMetadata(
    metadata: Partial<
      Omit<MajikInvoiceContactMeta, "createdAt" | "updatedAt" | "blocked">
    >,
  ): this {
    if (!metadata) {
      throw new MajikInvoiceContactError(
        "New metadata must not be undefined. At least one field is required",
        "UPDATE_FAILED",
        { field: "meta.tradeName" },
      );
    }
    this.meta = {
      ...this.meta,
      ...metadata,
    };

    this.updateTimestamp();
    return this;
  }

  // ---------------------------------------------------------------------------
  // Label / notes — mirrors MajikContact.updateLabel() / updateNotes()
  // ---------------------------------------------------------------------------

  updateLabel(label: string): this {
    if (typeof label !== "string") {
      throw new MajikInvoiceContactError(
        "Label must be a string",
        "UPDATE_FAILED",
        { field: "meta.label" },
      );
    }
    this.meta.label = label;
    this.updateTimestamp();
    return this;
  }

  updateNotes(notes: string): this {
    if (typeof notes !== "string") {
      throw new MajikInvoiceContactError(
        "Notes must be a string",
        "UPDATE_FAILED",
        { field: "meta.notes" },
      );
    }
    this.meta.notes = notes;
    this.updateTimestamp();
    return this;
  }

  // ---------------------------------------------------------------------------
  // Majikah registration — mirrors MajikContact exactly
  // ---------------------------------------------------------------------------

  isMajikahIdentityChecked(): boolean {
    return this.majikah_registered !== undefined;
  }

  isMajikahRegistered(): boolean {
    return this.majikah_registered || false;
  }

  setMajikahStatus(status: boolean): this {
    this.majikah_registered = status;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Party meta update methods
  // ---------------------------------------------------------------------------

  updateTradeName(tradeName: string): this {
    if (typeof tradeName !== "string") {
      throw new MajikInvoiceContactError(
        "tradeName must be a string",
        "UPDATE_FAILED",
        { field: "meta.tradeName" },
      );
    }
    this.meta.tradeName = tradeName.trim();
    // Keep label in sync when it was auto-derived from tradeName
    if (!this.meta.label || this.meta.label === this.meta.legalName) {
      this.meta.label = tradeName.trim();
    }
    this.updateTimestamp();
    return this;
  }

  updateNatureOfBusiness(natureOfBusiness: string): this {
    if (typeof natureOfBusiness !== "string") {
      throw new MajikInvoiceContactError(
        "natureOfBusiness must be a string",
        "UPDATE_FAILED",
        { field: "meta.natureOfBusiness" },
      );
    }
    this.meta.natureOfBusiness = natureOfBusiness.trim();
    this.updateTimestamp();
    return this;
  }

  updateTaxExemption(taxExempt: boolean, taxExemptRef?: string): this {
    if (typeof taxExempt !== "boolean") {
      throw new MajikInvoiceContactError(
        "taxExempt must be a boolean",
        "UPDATE_FAILED",
        { field: "meta.taxExempt" },
      );
    }
    this.meta.taxExempt = taxExempt;
    if (taxExemptRef !== undefined) {
      if (typeof taxExemptRef !== "string") {
        throw new MajikInvoiceContactError(
          "taxExemptRef must be a string",
          "UPDATE_FAILED",
          { field: "meta.taxExemptRef" },
        );
      }
      this.meta.taxExemptRef = taxExemptRef.trim();
    }
    this.updateTimestamp();
    return this;
  }

  /**
   * Merges partial address into the existing address.
   * If no address exists yet, `line1`, `city`, and `country` must all be present.
   */
  updateAddress(address: Partial<InvoiceContactAddress>): this {
    const merged: InvoiceContactAddress = {
      ...(this.meta.address ?? { line1: "", city: "", country: "" }),
      ...address,
    };
    this.assertAddress(merged);
    this.meta.address = merged;
    this.updateTimestamp();
    return this;
  }

  updateEmail(email: string): this {
    this.assertEmail(email);
    this.meta.email = email.trim().toLowerCase();
    this.updateTimestamp();
    return this;
  }

  updatePhone(phone: string): this {
    this.assertPhone(phone);
    this.meta.phone = phone.trim();
    this.updateTimestamp();
    return this;
  }

  updateWebsite(website: string): this {
    if (!website || typeof website !== "string") {
      throw new MajikInvoiceContactError(
        "website must be a non-empty string",
        "UPDATE_FAILED",
        { field: "meta.website" },
      );
    }
    this.meta.website = website.trim();
    this.updateTimestamp();
    return this;
  }

  mergeMetadata(metadata: Record<string, unknown>): this {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new MajikInvoiceContactError(
        "metadata must be a plain object",
        "UPDATE_FAILED",
        { field: "meta.metadata" },
      );
    }
    this.meta.metadata = { ...(this.meta.metadata ?? {}), ...metadata };
    this.updateTimestamp();
    return this;
  }

  replaceMetadata(metadata: Record<string, unknown>): this {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new MajikInvoiceContactError(
        "metadata must be a plain object",
        "UPDATE_FAILED",
        { field: "meta.metadata" },
      );
    }
    this.meta.metadata = { ...metadata };
    this.updateTimestamp();
    return this;
  }

  // ---------------------------------------------------------------------------
  // Static helper — mirrors MajikContact.isBlocked()
  // ---------------------------------------------------------------------------

  static isBlocked(contact: MajikInvoiceContact): boolean {
    return !!contact.meta.blocked;
  }

  // ---------------------------------------------------------------------------
  // Private: timestamp + assertion helpers
  // ---------------------------------------------------------------------------

  private updateTimestamp(): void {
    this.meta.updatedAt = new Date().toISOString();
  }

  private assertId(id: string): void {
    if (!id || typeof id !== "string") {
      throw new MajikInvoiceContactError(
        "Contact ID must be a non-empty string",
        "INVALID_ID",
        { field: "id" },
      );
    }
  }

  private assertMLKey(key: string): void {
    if (!key || typeof key !== "string") {
      throw new MajikInvoiceContactError(
        "ML Key must be a non-empty string",
        "INVALID_ML_KEY",
        { field: "mlKey" },
      );
    }
  }

  private assertPublicKey(key: CryptoKey | { raw: Uint8Array }): void {
    if (!key) {
      throw new MajikInvoiceContactError(
        "Invalid public key",
        "INVALID_PUBLIC_KEY",
        { field: "publicKey" },
      );
    }
    const anyKey: any = key as any;
    if (anyKey && typeof anyKey === "object") {
      if (anyKey.type === "public") return;
      if (anyKey.raw instanceof Uint8Array) return;
    }
    throw new MajikInvoiceContactError(
      "publicKey must be a CryptoKey or { raw: Uint8Array }",
      "INVALID_PUBLIC_KEY",
      { field: "publicKey" },
    );
  }

  private assertFingerprint(fingerprint: string): void {
    if (!fingerprint || typeof fingerprint !== "string") {
      throw new MajikInvoiceContactError(
        "Fingerprint must be a non-empty string",
        "INVALID_FINGERPRINT",
        { field: "fingerprint" },
      );
    }
  }

  private assertLegalName(legalName?: string): void {
    if (!legalName || typeof legalName !== "string" || !legalName.trim()) {
      throw new MajikInvoiceContactError(
        "Legal Name must be a non-empty string",
        "INVALID_LEGAL_NAME",
        { field: "meta.legalName" },
      );
    }
  }

  private assertTIN(tin: string): void {
    if (typeof tin !== "string" || !tin.trim()) {
      throw new MajikInvoiceContactError(
        "TIN must be a non-empty string when provided",
        "INVALID_TIN",
        { field: "meta.tin" },
      );
    }
  }

  private assertEmail(email: string): void {
    if (typeof email !== "string" || !email.trim()) {
      throw new MajikInvoiceContactError(
        "meta.email must be a non-empty string when provided",
        "INVALID_EMAIL",
        { field: "meta.email" },
      );
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      throw new MajikInvoiceContactError(
        `Invalid email address: "${email}"`,
        "INVALID_EMAIL",
        { field: "meta.email" },
      );
    }
  }

  private assertPhone(phone: string): void {
    if (typeof phone !== "string" || !phone.trim()) {
      throw new MajikInvoiceContactError(
        "meta.phone must be a non-empty string when provided",
        "INVALID_PHONE",
        { field: "meta.phone" },
      );
    }
    // E.164-compatible
    const phoneRegex = /^[+\d][\d\s\-().]{4,19}$/;
    if (!phoneRegex.test(phone.trim())) {
      throw new MajikInvoiceContactError(
        `Invalid phone number: "${phone}"`,
        "INVALID_PHONE",
        { field: "meta.phone" },
      );
    }
  }

  private assertAddress(address: InvoiceContactAddress): void {
    if (!address || typeof address !== "object") {
      throw new MajikInvoiceContactError(
        "address must be an object",
        "INVALID_ADDRESS",
        { field: "meta.address" },
      );
    }
    if (!address.line1?.trim()) {
      throw new MajikInvoiceContactError(
        "address.line1 must be a non-empty string",
        "INVALID_ADDRESS",
        { field: "meta.address.line1" },
      );
    }
    if (!address.city?.trim()) {
      throw new MajikInvoiceContactError(
        "address.city must be a non-empty string",
        "INVALID_ADDRESS",
        { field: "meta.address.city" },
      );
    }
    if (!address.country?.trim()) {
      throw new MajikInvoiceContactError(
        "address.country must be a non-empty string",
        "INVALID_ADDRESS",
        { field: "meta.address.country" },
      );
    }
    if (!/^[A-Z]{2}$/.test(address.country.trim())) {
      throw new MajikInvoiceContactError(
        `address.country must be ISO 3166-1 alpha-2 (e.g. "PH", "US"). Got: "${address.country}"`,
        "INVALID_COUNTRY_CODE",
        { field: "meta.address.country" },
      );
    }
  }
}
