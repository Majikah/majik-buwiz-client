import { KEY_ALGO } from "../crypto/constants";
import { MajikInvoiceContact } from "./majik-invoice-contact";
import {
  MajikInvoiceContactDirectoryData,
  MajikInvoiceContactMeta,
  SerializedMajikInvoiceContact,
} from "./types";
import { MAJIK_API_RESPONSE } from "../types";
import { base64ToArrayBuffer } from "../utils/utilities";
import { MajikInvoiceContactDirectoryError } from "./errors";

/* -------------------------------
 * MajikInvoiceContactDirectory Class
 * ------------------------------- */

export class MajikInvoiceContactDirectory {
  private contacts: Map<string, MajikInvoiceContact> = new Map();
  private fingerprintMap: Map<string, string> = new Map(); // fingerprint → contact id

  constructor(initialContacts?: MajikInvoiceContact[]) {
    if (initialContacts?.length) {
      initialContacts.forEach((c) => this.addContact(c));
    }
  }

  /* ================================
   * Contact Management
   * ================================ */

  addContact(contact: MajikInvoiceContact): this {
    if (
      !contact?.id ||
      !contact?.publicKey ||
      !contact?.fingerprint ||
      !contact?.mlKey
    ) {
      throw new MajikInvoiceContactDirectoryError("Invalid contact");
    }

    if (!(contact instanceof MajikInvoiceContact)) {
      throw new MajikInvoiceContactDirectoryError("Invalid contact instance");
    }
    if (this.contacts.has(contact.id)) {
      throw new MajikInvoiceContactDirectoryError(
        `Contact with id "${contact.id}" already exists`,
      );
    }
    this.contacts.set(contact.id, contact);
    this.fingerprintMap.set(contact.fingerprint, contact.id);
    return this;
  }

  addContacts(contacts: MajikInvoiceContact[]): this {
    contacts.forEach((c) => this.addContact(c));
    return this;
  }

  removeContact(id: string): MAJIK_API_RESPONSE {
    this.assertId(id);
    const contact = this.contacts.get(id);
    if (contact) {
      this.fingerprintMap.delete(contact.fingerprint);
      this.contacts.delete(id);
      return {
        message: "Contact removed successfully",
        success: true,
      };
    } else {
      return {
        message: "Contact not found",
        success: false,
      };
    }
  }

  updateContactMeta(
    id: string,
    meta: Partial<
      Omit<MajikInvoiceContactMeta, "createdAt" | "updatedAt" | "blocked">
    >,
  ): MajikInvoiceContact {
    const contact = this.getContact(id);
    if (!contact)
      throw new MajikInvoiceContactDirectoryError("Contact not found");

    if (meta) {
      contact.updateMetadata(meta);
    }

    return contact;
  }

  getContact(id: string): MajikInvoiceContact | undefined {
    this.assertId(id);
    return this.contacts.get(id);
  }

  getContactByFingerprint(
    fingerprint: string,
  ): MajikInvoiceContact | undefined {
    if (!fingerprint) {
      throw new MajikInvoiceContactDirectoryError(
        "Fingerprint must be a non-empty string",
      );
    }
    const contactId = this.fingerprintMap.get(fingerprint);
    return contactId ? this.contacts.get(contactId) : undefined;
  }

  /**
   * Get contact by public key (base64)
   * Uses MajikInvoiceContact.getPublicKeyBase64() for canonical comparison
   */
  async getContactByPublicKeyBase64(
    publicKeyBase64: string,
  ): Promise<MajikInvoiceContact | undefined> {
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string") {
      throw new MajikInvoiceContactDirectoryError(
        "Public key must be a non-empty base64 string",
      );
    }

    for (const contact of this.contacts.values()) {
      const contactKey = await contact.getPublicKeyBase64();
      if (contactKey === publicKeyBase64) {
        return contact;
      }
    }

    return undefined;
  }

  hasFingerprint(fingerprint: string): boolean {
    return this.fingerprintMap.has(fingerprint);
  }

  listContacts(
    sortedByLabel = false,
    majikahOnly = false,
  ): MajikInvoiceContact[] {
    let contacts = [...this.contacts.values()];

    if (majikahOnly) {
      contacts = contacts.filter((c) => c.isMajikahRegistered());
    }

    if (sortedByLabel) {
      contacts.sort((a, b) =>
        (a.meta.label || "").localeCompare(b.meta.label || ""),
      );
    }

    return contacts;
  }

  hasContact(id: string): boolean {
    return this.contacts.has(id);
  }

  /**
   * Checks if a contact exists by their public key (base64)
   */
  async hasContactByPublicKeyBase64(publicKeyBase64: string): Promise<boolean> {
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string") {
      throw new MajikInvoiceContactDirectoryError(
        "Public key must be a non-empty base64 string",
      );
    }

    const contact = await this.getContactByPublicKeyBase64(publicKeyBase64);
    return contact !== undefined;
  }

  clear(): this {
    this.contacts.clear();
    this.fingerprintMap.clear();
    return this;
  }

  setMajikahStatus(id: string, status: boolean): MajikInvoiceContact {
    const contact = this.getContact(id);
    if (!contact)
      throw new MajikInvoiceContactDirectoryError("Contact not found");

    contact.setMajikahStatus(status);

    return contact;
  }

  isMajikahIdentityChecked(id: string): boolean {
    const contact = this.getContact(id);
    if (!contact)
      throw new MajikInvoiceContactDirectoryError("Contact not found");
    return contact.isMajikahIdentityChecked();
  }

  isMajikahRegistered(id: string): boolean {
    const contact = this.getContact(id);
    if (!contact)
      throw new MajikInvoiceContactDirectoryError("Contact not found");
    return contact.isMajikahRegistered();
  }

  /* ================================
   * Serialization / Persistence
   * ================================ */

  async toJSON(): Promise<MajikInvoiceContactDirectoryData> {
    const contactsData: SerializedMajikInvoiceContact[] = [];
    for (const contact of this.contacts.values()) {
      contactsData.push(await contact.toJSON());
    }
    return { contacts: contactsData };
  }

  async fromJSON(data: MajikInvoiceContactDirectoryData): Promise<this> {
    if (!data?.contacts) {
      throw new MajikInvoiceContactDirectoryError("Invalid serialized data");
    }

    this.clear();

    for (const item of data.contacts) {
      const raw = base64ToArrayBuffer(item.publicKeyBase64);
      let publicKey: CryptoKey | { raw: Uint8Array };
      try {
        publicKey = await crypto.subtle.importKey(
          "raw",
          raw,
          KEY_ALGO,
          true,
          [],
        );
      } catch (e) {
        // Fallback: create a raw-key wrapper when the browser does not support the namedCurve
        publicKey = { raw: new Uint8Array(raw) };
      }

      const contact = MajikInvoiceContact.create(
        item.id,
        publicKey as any,
        item.mlKey,
        item.fingerprint,
        item.meta,
        item.edPublicKeyBase64,
        item.mlDsaPublicKeyBase64,
      );
      this.contacts.set(contact.id, contact);
      this.fingerprintMap.set(contact.fingerprint, contact.id);
    }

    return this;
  }

  /* ================================
   * Validation Helpers
   * ================================ */

  private assertId(id: string) {
    if (!id || typeof id !== "string") {
      throw new MajikInvoiceContactDirectoryError(
        "Contact ID must be a non-empty string",
      );
    }
  }
}
