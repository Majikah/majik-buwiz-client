import { MajikContact } from "@majikah/majik-contact";
import type { MajikRecipient } from "@majikah/majik-envelope";
import type { ExpectedSigner } from "@majikah/majik-signature";
import { base64ToArrayBuffer, base64ToUint8Array } from "../utils/utilities";
import {
  MajikInvoiceContactError,
  type MajikInvoiceContactErrorCode,
} from "./errors";
import type {
  InvoiceContactAddress,
  InvoiceContactBIRProfile,
  MajikInvoiceContactCard,
  MajikInvoiceContactData,
  MajikInvoiceContactMeta,
  SerializedMajikInvoiceContact,
} from "./types";
import type { TaxpayerProfile } from "../accounting/types";
import { X25519RawKey } from "@majikah/majik-key";

/**
 * MajikInvoiceContact — a MajikContact whose `meta` carries the party/tax
 * identity of a billing entity (issuer or recipient).
 *
 * Inherited unchanged from MajikContact: id, publicKey, fingerprint, mlKey,
 * edPublicKeyBase64, mlDsaPublicKeyBase64, block/unblock/setBlocked/isBlocked,
 * updateLabel/updateNotes, Majikah registration status, getAddress /
 * getPublicKeyBase64.
 *
 * Overridden: toJSON, toContactCard, getDisplayName, updateMeta, and the
 * protected `fail()` hook (so base validation throws MajikInvoiceContactError
 * with codes). All meta fields are mutable; updateMeta() validates them.
 *
 * NOTE: static `create` / `fromJSON` are inherited from MajikContact and return
 * a plain MajikContact. Use createInvoiceContact() / fromInvoiceJSON() here
 * (TS forbids narrowing the generic base statics).
 */
export class MajikInvoiceContact extends MajikContact<MajikInvoiceContactMeta> {
  constructor(data: MajikInvoiceContactData) {
    super({ ...data, meta: MajikInvoiceContact.buildMeta(data.meta) });
  }

  static createInvoiceContact(
    id: string,
    publicKey: X25519RawKey,
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

  static fromInvoiceJSON(
    serialized: SerializedMajikInvoiceContact,
  ): MajikInvoiceContact {
    try {
      return new MajikInvoiceContact({
        id: serialized.id,
        fingerprint: serialized.fingerprint,
        publicKey: {
          raw: new Uint8Array(base64ToArrayBuffer(serialized.publicKeyBase64)),
        },
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

  protected override fail(
    message: string,
    code: string,
    field?: string,
  ): never {
    throw new MajikInvoiceContactError(
      message,
      code as MajikInvoiceContactErrorCode,
      { field },
    );
  }

  override async toJSON(): Promise<SerializedMajikInvoiceContact> {
    return { ...(await super.toJSON()), meta: { ...this.meta } };
  }

  override async toContactCard(): Promise<MajikInvoiceContactCard> {
    const card = await super.toContactCard();
    return {
      ...card,
      label: this.meta.tradeName?.trim() || this.meta.legalName,
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

  override async getDisplayName(): Promise<string> {
    return (
      this.meta.tradeName?.trim() ||
      this.meta.legalName ||
      (await this.getAddress())
    );
  }

  override updateMeta(updates: Partial<MajikInvoiceContactMeta>): this {
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      throw new MajikInvoiceContactError(
        "New metadata must be a plain object",
        "UPDATE_FAILED",
        { field: "meta" },
      );
    }
    if ("legalName" in updates)
      MajikInvoiceContact.assertLegalName(updates.legalName);
    if (updates.tin !== undefined) MajikInvoiceContact.assertTIN(updates.tin);
    if (updates.email !== undefined)
      MajikInvoiceContact.assertEmail(updates.email);
    if (updates.phone !== undefined)
      MajikInvoiceContact.assertPhone(updates.phone);
    if (updates.address !== undefined)
      MajikInvoiceContact.assertAddress(updates.address);
    super.updateMeta(updates);
    this.meta.bir = MajikInvoiceContact.hydrateBIR(this.meta.bir);
    return this;
  }

  /** @deprecated use updateMeta() */
  updateMetadata(
    metadata: Partial<
      Omit<MajikInvoiceContactMeta, "createdAt" | "updatedAt" | "blocked">
    >,
  ): this {
    return this.updateMeta(metadata);
  }

  toBIRProfile(): TaxpayerProfile {
    if (!this.meta.tin?.trim()) {
      throw new MajikInvoiceContactError(
        "Cannot construct TaxpayerProfile without TIN",
        "INVALID_TAXPAYER_PROFILE",
        { field: "meta.tin" },
      );
    }
    const bir = MajikInvoiceContact.hydrateBIR(this.meta.bir);
    return {
      tin: this.meta.tin,
      legalName: this.meta.legalName,
      tradeName: this.meta.tradeName,
      email: this.meta.email,
      phone: this.meta.phone,
      address: this.meta.address ? { ...this.meta.address } : undefined,
      rdoCode: bir.rdoCode,
      entityType: bir.entityType,
      taxRegime: bir.taxRegime,
      taxRateElection: bir.taxRateElection,
      deductionMethod: bir.deductionMethod,
      accountingMethod: bir.accountingMethod,
      vatRegistrationDate: bir.vatRegistrationDate,
      registeredActivities: bir.registeredActivities
        ? [...bir.registeredActivities]
        : undefined,
      functionalCurrency: bir.functionalCurrency,
      metadata: this.meta.metadata ? { ...this.meta.metadata } : undefined,
      spouse: bir.spouse ? { ...bir.spouse } : undefined,
    };
  }

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
    if (!this.mlKey?.trim() || !this.fingerprint?.trim())
      throw new Error(`Invalid Keys. Cannot export to Majik Recipient.`);
    return {
      fingerprint: this.fingerprint,
      mlKemPublicKey: base64ToUint8Array(this.mlKey),
    };
  }

  // ----- pure helpers (static so they can run before super()) -----
  private static buildMeta(
    meta?: Partial<MajikInvoiceContactMeta>,
  ): MajikInvoiceContactMeta {
    MajikInvoiceContact.assertLegalName(meta?.legalName);
    if (meta?.tin !== undefined) MajikInvoiceContact.assertTIN(meta.tin);
    const now = new Date().toISOString();
    const legalName = meta!.legalName!.trim();
    return {
      label: meta?.label || meta?.tradeName || legalName,
      notes: meta?.notes || "",
      blocked: meta?.blocked || false,
      createdAt: meta?.createdAt || now,
      updatedAt: meta?.updatedAt || now,
      legalName,
      tradeName: meta?.tradeName?.trim(),
      natureOfBusiness: meta?.natureOfBusiness?.trim(),
      tin: meta?.tin?.trim(),
      taxIdType: meta?.taxIdType?.trim(),
      taxExempt: meta?.taxExempt ?? false,
      taxExemptRef: meta?.taxExemptRef?.trim(),
      taxProfile: meta?.taxProfile,
      address: meta?.address ? { ...meta.address } : undefined,
      email: meta?.email?.trim().toLowerCase(),
      phone: meta?.phone?.trim(),
      website: meta?.website?.trim(),
      metadata: meta?.metadata ? { ...meta.metadata } : undefined,
      bir: MajikInvoiceContact.hydrateBIR(meta?.bir),
    };
  }

  private static hydrateBIR(
    bir?: Partial<InvoiceContactBIRProfile>,
  ): InvoiceContactBIRProfile {
    return {
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

  private static err(
    message: string,
    code: MajikInvoiceContactErrorCode,
    field: string,
  ): never {
    throw new MajikInvoiceContactError(message, code, { field });
  }
  private static assertLegalName(v?: string): void {
    if (!v || typeof v !== "string" || !v.trim())
      MajikInvoiceContact.err(
        "Legal Name must be a non-empty string",
        "INVALID_LEGAL_NAME",
        "meta.legalName",
      );
  }
  private static assertTIN(v: string): void {
    if (typeof v !== "string" || !v.trim())
      MajikInvoiceContact.err(
        "TIN must be a non-empty string when provided",
        "INVALID_TIN",
        "meta.tin",
      );
  }
  private static assertEmail(v: string): void {
    if (typeof v !== "string" || !v.trim())
      MajikInvoiceContact.err(
        "meta.email must be a non-empty string when provided",
        "INVALID_EMAIL",
        "meta.email",
      );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()))
      MajikInvoiceContact.err(
        `Invalid email address: "${v}"`,
        "INVALID_EMAIL",
        "meta.email",
      );
  }
  private static assertPhone(v: string): void {
    if (typeof v !== "string" || !v.trim())
      MajikInvoiceContact.err(
        "meta.phone must be a non-empty string when provided",
        "INVALID_PHONE",
        "meta.phone",
      );
    if (!/^[+\d][\d\s\-().]{4,19}$/.test(v.trim()))
      MajikInvoiceContact.err(
        `Invalid phone number: "${v}"`,
        "INVALID_PHONE",
        "meta.phone",
      );
  }
  private static assertAddress(a: InvoiceContactAddress): void {
    if (!a || typeof a !== "object")
      MajikInvoiceContact.err(
        "address must be an object",
        "INVALID_ADDRESS",
        "meta.address",
      );
    if (!a.line1?.trim())
      MajikInvoiceContact.err(
        "address.line1 must be a non-empty string",
        "INVALID_ADDRESS",
        "meta.address.line1",
      );
    if (!a.city?.trim())
      MajikInvoiceContact.err(
        "address.city must be a non-empty string",
        "INVALID_ADDRESS",
        "meta.address.city",
      );
    if (!a.country?.trim())
      MajikInvoiceContact.err(
        "address.country must be a non-empty string",
        "INVALID_ADDRESS",
        "meta.address.country",
      );
    if (!/^[A-Z]{2}$/.test(a.country.trim()))
      MajikInvoiceContact.err(
        `address.country must be ISO 3166-1 alpha-2 (e.g. "PH", "US"). Got: "${a.country}"`,
        "INVALID_COUNTRY_CODE",
        "meta.address.country",
      );
  }
}
