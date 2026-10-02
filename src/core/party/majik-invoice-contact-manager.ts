import { MAJIK_API_RESPONSE } from "../types";
import { MajikInvoiceContactManagerError } from "./errors";
import {
  ContactManagerQueryMode,
  MajikInvoiceContactCard,
  MajikInvoiceContactData,
  MajikInvoiceContactGroupMeta,
  MajikInvoiceContactManagerJSON,
} from "./types";
import {
  arrayBufferToBase64,
  arrayToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
} from "../utils/utilities";
import { KEY_ALGO } from "../crypto/constants";
import { gunzipSync, gzipSync } from "fflate";
import { MajikInvoiceContactStorageAdapter } from "../storage/contact-directory/contacts/_types";
import { MajikInvoiceContactGroupStorageAdapter } from "../storage/contact-directory/groups/_types";
import { InMemoryContactAdapter } from "../storage/contact-directory/contacts/adapter-memory";
import { InMemoryContactGroupAdapter } from "../storage/contact-directory/groups/adapter-memory";
import { MajikKeyAddress } from "@majikah/majik-key";
import { MajikInvoiceContactDirectory } from "./majik-invoice-contact-directory";
import { MajikInvoiceContactGroupManager } from "./majik-invoice-contact-groups";
import { MajikInvoiceContact } from "./majik-invoice-contact";
import { MajikInvoiceContactGroup } from "./majik-invoice-contact-group";
import { MajikRecipient } from "@majikah/majik-envelope";
import { ExpectedSigner } from "@majikah/majik-signature";

// ---------------------------------------------------------------------------
// MajikInvoiceContactManager
// ---------------------------------------------------------------------------

export interface MajikInvoiceContactManagerAdapters {
  contacts?: MajikInvoiceContactStorageAdapter;
  groups?: MajikInvoiceContactGroupStorageAdapter;
}

export class MajikInvoiceContactManager {
  private readonly directory: MajikInvoiceContactDirectory;
  private readonly groupManager: MajikInvoiceContactGroupManager;
  private _contactAdapter: MajikInvoiceContactStorageAdapter;
  private _groupAdapter: MajikInvoiceContactGroupStorageAdapter;

  constructor(
    directory?: MajikInvoiceContactDirectory,
    groupManager?: MajikInvoiceContactGroupManager,
    adapters?: MajikInvoiceContactManagerAdapters,
  ) {
    this.directory = directory ?? new MajikInvoiceContactDirectory();

    if (groupManager) {
      this.assertGroupManagerInstance(groupManager);
      this.groupManager = groupManager;
    } else {
      this.groupManager = new MajikInvoiceContactGroupManager(this.directory);
    }

    this._contactAdapter = adapters?.contacts ?? new InMemoryContactAdapter();
    this._groupAdapter = adapters?.groups ?? new InMemoryContactGroupAdapter();
  }

  // ── Adapter management ────────────────────────────────────────────────────

  get contactAdapter(): MajikInvoiceContactStorageAdapter {
    return this._contactAdapter;
  }

  get groupAdapter(): MajikInvoiceContactGroupStorageAdapter {
    return this._groupAdapter;
  }

  /**
   * Swap both adapters at runtime. Does NOT migrate data.
   *
   * Migration pattern:
   * ```ts
   * const snap = await manager.toJSON();
   * manager.setAdapters({ contacts: new IDBContactAdapter(), groups: new IDBGroupAdapter() });
   * await manager.hydrate();                    // warms from new (empty) adapters
   * await manager.bulkRestoreFromJSON(snap);    // writes old data into new adapters
   * ```
   */
  setAdapters(adapters: MajikInvoiceContactManagerAdapters): void {
    if (adapters.contacts) this._contactAdapter = adapters.contacts;
    if (adapters.groups) this._groupAdapter = adapters.groups;
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Load all contacts and groups from the adapters into the in-memory
   * directory and group manager. Call once after construction (or after
   * swapping adapters).
   *
   * Restoration order:
   *  1. Contacts — must come first so groups can validate member existence.
   *  2. Groups — restored via groupManager.fromJSON() which rebuilds the
   *     reverse index and re-bootstraps system groups.
   *  3. Orphan pruning — any group member ID not present in the restored
   *     directory is silently removed (guards against data drift).
   */
  async hydrate(): Promise<void> {
    // ── 1. Contacts ───────────────────────────────────────────────────────
    const serializedContacts = await this._contactAdapter.list();
    this.directory.clear();

    for (const item of serializedContacts) {
      try {
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
        } catch {
          publicKey = { raw: new Uint8Array(raw) };
        }

        const contact = MajikInvoiceContact.createInvoiceContact(
          item.id,
          publicKey as any,
          item.mlKey,
          item.fingerprint,
          item.meta,
          item.edPublicKeyBase64,
          item.mlDsaPublicKeyBase64,
        );
        // Use the internal map directly to avoid addContact's duplicate-check
        // (re-hydrating from persisted state, not user-facing add)
        this.directory["contacts"].set(contact.id, contact);
        this.directory["fingerprintMap"].set(contact.fingerprint, contact.id);
      } catch (err) {
        console.warn(
          `MajikInvoiceContactManager.hydrate: skipping malformed contact "${item?.id}":`,
          err,
        );
      }
    }

    // ── 2. Groups ─────────────────────────────────────────────────────────
    const serializedGroups = await this._groupAdapter.list();
    this.groupManager.fromJSON({ groups: serializedGroups });

    // ── 3. Orphan pruning ─────────────────────────────────────────────────
    MajikInvoiceContactManager.pruneOrphanedMembers(
      this.directory,
      this.groupManager,
    );
  }

  // ── Write-through helpers ─────────────────────────────────────────────────

  /**
   * Persists a single contact to the adapter (called after every mutating
   * operation that affects a contact's serialized form).
   */
  private async persistContact(contact: MajikInvoiceContact): Promise<void> {
    const json = await contact.toJSON();
    await this._contactAdapter.save(json);
  }

  /**
   * Persists a single group to the adapter.
   */
  private async persistGroup(group: MajikInvoiceContactGroup): Promise<void> {
    await this._groupAdapter.save(group.toJSON());
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Adds a contact to the directory and persists it to the adapter.
   */
  async addContact(contact: MajikInvoiceContact): Promise<this> {
    this.directory.addContact(contact);
    await this.persistContact(contact);
    return this;
  }

  /**
   * Adds multiple contacts atomically — adapter write uses bulkSave.
   */
  async addContacts(contacts: MajikInvoiceContact[]): Promise<this> {
    this.directory.addContacts(contacts);
    const jsons = await Promise.all(contacts.map((c) => c.toJSON()));
    await this._contactAdapter.bulkSave(jsons);
    return this;
  }

  /**
   * Removes a contact from the directory, all groups, and the adapter.
   */
  async removeContact(id: string): Promise<MAJIK_API_RESPONSE> {
    const result = this.directory.removeContact(id);
    if (result.success) {
      this.groupManager.handleContactRemoved(id);
      await this._contactAdapter.remove(id);
      // Persist every group whose membership changed
      await this._persistAllGroups();
    }
    return result;
  }

  /**
   * Updates contact metadata and persists the change.
   */
  async updateContactMeta(
    id: string,
    meta: Partial<MajikInvoiceContactData["meta"]>,
  ): Promise<MajikInvoiceContact> {
    const contact = this.directory.updateContactMeta(id, meta);
    await this.persistContact(contact);
    return contact;
  }

  /**
   * Blocks a contact and persists both the contact and the Blocked group.
   */
  async blockContact(id: string): Promise<MajikInvoiceContact> {
    const contact = this.directory.blockContact(id);
    const blocked = this.groupManager.addContactToGroupIfAbsent(
      this.groupManager.getBlockedGroup().id,
      id,
    );
    await this.persistContact(contact);
    await this.persistGroup(blocked);
    return contact;
  }

  /**
   * Unblocks a contact and persists both the contact and the Blocked group.
   */
  async unblockContact(id: string): Promise<MajikInvoiceContact> {
    const contact = this.directory.unblockContact(id);
    const blocked = this.groupManager.removeContactFromGroupIfPresent(
      this.groupManager.getBlockedGroup().id,
      id,
    );
    await this.persistContact(contact);
    await this.persistGroup(blocked);
    return contact;
  }

  async setMajikahStatus(
    id: string,
    status: boolean,
  ): Promise<MajikInvoiceContact> {
    const contact = this.directory.setMajikahStatus(id, status);
    await this.persistContact(contact);
    return contact;
  }

  /**
   * Clears all contacts and groups from both the in-memory stores and adapters.
   */
  async clear(): Promise<this> {
    const allContactIds = this.directory.listContacts().map((c) => c.id);
    this.directory.clear();
    allContactIds.forEach((id) => this.groupManager.handleContactRemoved(id));

    this.directory.clear();
    this.groupManager.clear();
    await this._contactAdapter.clear();
    await this._groupAdapter.clear();
    return this;
  }

  // ── Sync reads (unchanged from original) ──────────────────────────────────

  getContact(id: string): MajikInvoiceContact | undefined {
    return this.directory.getContact(id);
  }

  getContactByFingerprint(
    fingerprint: string,
  ): MajikInvoiceContact | undefined {
    return this.directory.getContactByFingerprint(fingerprint);
  }

  async getContactByAddress(
    address: MajikKeyAddress,
  ): Promise<MajikInvoiceContact | undefined> {
    return await this.directory.getContactByAddress(address);
  }

  getContactsByIds(ids: string[], strict = false): MajikInvoiceContact[] {
    if (!ids?.length) return [];

    const seen = new Set<string>();
    const results: MajikInvoiceContact[] = [];

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);

      const contact = this.directory.getContact(id);

      if (!contact) {
        if (strict) {
          throw new MajikInvoiceContactManagerError(`Contact not found: ${id}`);
        }
        continue;
      }

      results.push(contact);
    }

    return results;
  }

  async getContactsByPublicKeys(
    publicKeys: string[],
    strict = false,
  ): Promise<MajikInvoiceContact[]> {
    if (!publicKeys?.length) return [];

    const uniqueKeys = [...new Set(publicKeys)];

    const contacts = await Promise.all(
      uniqueKeys.map(async (key) => {
        const contact = await this.directory.getContactByAddress(key);

        if (!contact && strict) {
          throw new MajikInvoiceContactManagerError(
            `Contact not found for publicKey: ${key}`,
          );
        }

        return contact;
      }),
    );

    return contacts.filter((c): c is MajikInvoiceContact => Boolean(c));
  }

  async getMajikRecipients(
    mode: ContactManagerQueryMode = "id",
    input: string[],
    strict?: boolean,
  ): Promise<MajikRecipient[]> {
    if (!input?.length)
      throw new MajikInvoiceContactManagerError(
        "At least 1 id/key is required",
      );

    const contacts =
      mode === "public_key"
        ? await this.getContactsByPublicKeys(input, strict)
        : this.getContactsByIds(input, strict);

    if (!contacts || contacts.length === 0) return [];

    const recipients: MajikRecipient[] = [];
    const seen = new Set<string>();
    const invalidContacts: string[] = [];

    for (const contact of contacts) {
      if (!contact) continue;

      // dedupe by fingerprint
      if (seen.has(contact.fingerprint)) continue;

      const mlPubKey = base64ToUint8Array(contact.mlKey);

      if (!mlPubKey) {
        invalidContacts.push(contact.fingerprint);
        continue;
      }

      recipients.push(contact.toMajikRecipient());

      seen.add(contact.fingerprint);
    }

    if (invalidContacts.length > 0) {
      throw new MajikInvoiceContactManagerError(
        `Invalid ML-KEM public key for contact(s): ${invalidContacts.join(", ")}`,
      );
    }

    return recipients;
  }

  async getExpectedSigners(
    mode: ContactManagerQueryMode = "id",
    input: string[],
    strict?: boolean,
  ): Promise<ExpectedSigner[]> {
    if (!input?.length)
      throw new MajikInvoiceContactManagerError(
        "At least 1 id/key is required",
      );

    const contacts =
      mode === "public_key"
        ? await this.getContactsByPublicKeys(input, strict)
        : this.getContactsByIds(input, strict);
    if (!contacts || contacts.length === 0) return [];

    const signers: ExpectedSigner[] = [];
    const seen = new Set<string>();
    const invalidContacts: string[] = [];

    for (const contact of contacts) {
      if (!contact) continue;

      // dedupe by fingerprint
      if (seen.has(contact.fingerprint)) continue;

      const mlDsaPublicKey = contact.mlDsaPublicKeyBase64;

      if (!mlDsaPublicKey?.trim()) {
        invalidContacts.push(contact.fingerprint);
        continue;
      }

      signers.push(contact.toExpectedSigner());

      seen.add(contact.fingerprint);
    }

    if (invalidContacts.length > 0) {
      throw new MajikInvoiceContactManagerError(
        `Invalid ML-KEM public key for contact(s): ${invalidContacts.join(", ")}`,
      );
    }

    return signers;
  }

  async getMajikahInvoiceData(
    mode: ContactManagerQueryMode = "id",
    input: string[],
    strict?: boolean,
  ): Promise<{
    recipients: MajikRecipient[];
    signers: ExpectedSigner[];
    publicKeys: MajikKeyAddress[];
  }> {
    if (!input?.length) {
      throw new MajikInvoiceContactManagerError(
        "At least 1 id/key is required",
      );
    }

    const contacts =
      mode === "public_key"
        ? await this.getContactsByPublicKeys(input, strict)
        : this.getContactsByIds(input, strict);

    if (!contacts?.length) {
      return { recipients: [], signers: [], publicKeys: [] };
    }

    const recipients: MajikRecipient[] = [];
    const signers: ExpectedSigner[] = [];
    const publicKeys: MajikKeyAddress[] = [];

    const seen = new Set<string>();

    const invalidRecipients: string[] = [];
    const invalidSigners: string[] = [];
    const invalidPublicKeys: string[] = [];

    for (const contact of contacts) {
      if (!contact) continue;

      if (seen.has(contact.fingerprint)) continue;

      // ---- recipient validation ----
      const mlPubKey = base64ToUint8Array(contact.mlKey);
      if (!mlPubKey) {
        invalidRecipients.push(contact.fingerprint);
      } else {
        recipients.push(contact.toMajikRecipient());
      }

      // ---- signer validation ----
      const mlDsaPublicKey = contact.mlDsaPublicKeyBase64;
      if (!mlDsaPublicKey?.trim()) {
        invalidSigners.push(contact.fingerprint);
      } else {
        signers.push(contact.toExpectedSigner());
      }

      // ---- public key validation ----
      const address = await contact.getAddress();
      if (!address?.trim()) {
        invalidPublicKeys.push(contact.fingerprint);
      } else {
        publicKeys.push(address);
      }

      seen.add(contact.fingerprint);
    }

    if (invalidRecipients.length > 0) {
      throw new MajikInvoiceContactManagerError(
        `Invalid ML-KEM public key for contact(s): ${invalidRecipients.join(", ")}`,
      );
    }

    if (invalidSigners.length > 0) {
      throw new MajikInvoiceContactManagerError(
        `Invalid ML-DSA public key for contact(s): ${invalidSigners.join(", ")}`,
      );
    }

    return { recipients, signers, publicKeys };
  }

  hasContact(id: string): boolean {
    return this.directory.hasContact(id);
  }

  hasFingerprint(fingerprint: string): boolean {
    return this.directory.hasFingerprint(fingerprint);
  }

  async hasContactByAddress(address: MajikKeyAddress): Promise<boolean> {
    return this.directory.hasContactByAddress(address);
  }

  listContacts(
    sortedByLabel = false,
    majikahOnly = false,
  ): MajikInvoiceContact[] {
    return this.directory.listContacts(sortedByLabel, majikahOnly);
  }

  isMajikahRegistered(id: string): boolean {
    return this.directory.isMajikahRegistered(id);
  }

  isMajikahIdentityChecked(id: string): boolean {
    return this.directory.isMajikahIdentityChecked(id);
  }

  // ── Group CRUD (now async, write-through) ─────────────────────────────────

  get group(): MajikInvoiceContactGroupManager {
    return this.groupManager;
  }

  get directory_(): MajikInvoiceContactDirectory {
    return this.directory;
  }

  async createGroup(
    id: string,
    name: string,
    meta?: Partial<Omit<MajikInvoiceContactGroupMeta, "name">>,
    initialMemberIds?: string[],
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.createGroup(
      id,
      name,
      meta,
      initialMemberIds,
    );
    await this.persistGroup(group);
    return group;
  }

  async addGroup(group: MajikInvoiceContactGroup): Promise<this> {
    this.groupManager.addGroup(group);
    await this.persistGroup(group);
    return this;
  }

  async removeGroup(id: string): Promise<MAJIK_API_RESPONSE> {
    const result = this.groupManager.removeGroup(id);
    if (result.success) {
      await this._groupAdapter.remove(id);
    }
    return result;
  }

  getGroup(id: string): MajikInvoiceContactGroup | undefined {
    return this.groupManager.getGroup(id);
  }

  getGroupOrThrow(id: string): MajikInvoiceContactGroup {
    return this.groupManager.getGroupOrThrow(id);
  }

  hasGroup(id: string): boolean {
    return this.groupManager.hasGroup(id);
  }

  listGroups(
    includeSystem = true,
    sortedByName = false,
  ): MajikInvoiceContactGroup[] {
    return this.groupManager.listGroups(includeSystem, sortedByName);
  }

  listUserGroups(sortedByName = true): MajikInvoiceContactGroup[] {
    return this.groupManager.listGroups(false, sortedByName);
  }

  listSystemGroups(): MajikInvoiceContactGroup[] {
    return this.groupManager.listGroups(true).filter((g) => g.isSystem);
  }

  async updateGroupMeta(
    id: string,
    meta: Partial<
      Pick<MajikInvoiceContactGroupMeta, "name" | "description" | "color">
    >,
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.updateGroupMeta(id, meta);
    await this.persistGroup(group);
    return group;
  }

  // ── Group membership (async, write-through) ───────────────────────────────

  async addContactToGroup(
    groupId: string,
    contactId: string,
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.addContactToGroup(groupId, contactId);
    await this.persistGroup(group);
    return group;
  }

  async addContactToGroupIfAbsent(
    groupId: string,
    contactId: string,
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.addContactToGroupIfAbsent(
      groupId,
      contactId,
    );
    await this.persistGroup(group);
    return group;
  }

  async addContactsToGroup(
    groupId: string,
    contactIds: string[],
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.addContactsToGroup(groupId, contactIds);
    await this.persistGroup(group);
    return group;
  }

  async removeContactFromGroup(
    groupId: string,
    contactId: string,
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.removeContactFromGroup(groupId, contactId);
    await this.persistGroup(group);
    return group;
  }

  async removeContactFromGroupIfPresent(
    groupId: string,
    contactId: string,
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.removeContactFromGroupIfPresent(
      groupId,
      contactId,
    );
    await this.persistGroup(group);
    return group;
  }

  async moveContactBetweenGroups(
    contactId: string,
    fromGroupId: string,
    toGroupId: string,
  ): Promise<void> {
    this.groupManager.moveContact(contactId, fromGroupId, toGroupId);
    // Persist both affected groups
    const from = this.groupManager.getGroup(fromGroupId);
    const to = this.groupManager.getGroup(toGroupId);
    const writes: Promise<void>[] = [];
    if (from) writes.push(this.persistGroup(from));
    if (to) writes.push(this.persistGroup(to));
    await Promise.all(writes);
  }

  // ── Group query pass-throughs (sync, unchanged) ───────────────────────────

  getContactsInGroup(groupId: string): MajikInvoiceContact[] {
    return this.groupManager.getContactsInGroup(groupId);
  }

  getContactsInGroupSorted(groupId: string): MajikInvoiceContact[] {
    return this.groupManager.getContactsInGroupSorted(groupId);
  }

  isContactInGroup(groupId: string, contactId: string): boolean {
    return this.groupManager.isContactInGroup(groupId, contactId);
  }

  getGroupsForContact(contactId: string): MajikInvoiceContactGroup[] {
    return this.groupManager.getGroupsForContact(contactId);
  }

  getGroupIdsForContact(contactId: string): string[] {
    return this.groupManager.getGroupIdsForContact(contactId);
  }

  // ── System group convenience (async, write-through) ───────────────────────

  async addToFavorites(contactId: string): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.addToFavorites(contactId);
    await this.persistGroup(group);
    return group;
  }

  async removeFromFavorites(
    contactId: string,
  ): Promise<MajikInvoiceContactGroup> {
    const group = this.groupManager.removeFromFavorites(contactId);
    await this.persistGroup(group);
    return group;
  }

  isFavorite(contactId: string): boolean {
    return this.groupManager.isFavorite(contactId);
  }

  isContactBlocked(contactId: string): boolean {
    return this.groupManager.isBlocked(contactId);
  }

  getFavoritesGroup(): MajikInvoiceContactGroup {
    return this.groupManager.getFavoritesGroup();
  }

  getBlockedGroup(): MajikInvoiceContactGroup {
    return this.groupManager.getBlockedGroup();
  }

  getFavoriteContacts(): MajikInvoiceContact[] {
    return this.groupManager.getContactsInGroup(
      this.groupManager.getFavoritesGroup().id,
    );
  }

  getBlockedContacts(): MajikInvoiceContact[] {
    return this.groupManager.getContactsInGroup(
      this.groupManager.getBlockedGroup().id,
    );
  }

  // ── Import / Export (unchanged) ───────────────────────────────────────────

  async exportContactAsJSON(contactId: string): Promise<string | null> {
    const contact = this.getContact(contactId);
    if (!contact) return null;

    const anyPub = contact.publicKey;
    const publicKeyBase64 = arrayBufferToBase64(
      anyPub.raw.buffer as ArrayBuffer,
    );

    return JSON.stringify(
      {
        id: contact.id,
        label: contact.meta?.label || "",
        publicKey: publicKeyBase64,
        fingerprint: contact.fingerprint,
        mlKey: contact.mlKey,
        edPublicKeyBase64: contact.edPublicKeyBase64,
        mlDsaPublicKeyBase64: contact.mlDsaPublicKeyBase64,
        partyMeta: contact.meta || {},
      } satisfies MajikInvoiceContactCard,
      null,
      2,
    );
  }

  async exportContactAsString(contactId: string): Promise<string | null> {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    return this.exportContactCompressed(contact);
  }

  async importContactFromJSON(jsonStr: string): Promise<MAJIK_API_RESPONSE> {
    try {
      const data: MajikInvoiceContactCard = JSON.parse(jsonStr);
      if (!data.id || !data.publicKey || !data.fingerprint) {
        return { success: false, message: "Invalid contact JSON" };
      }

      const rawBuffer = base64ToArrayBuffer(data.publicKey as string);

      const publicKey = { raw: new Uint8Array(rawBuffer) };

      const contact = new MajikInvoiceContact({
        id: data.id,
        publicKey,
        fingerprint: data.fingerprint,
        meta: {
          label: data.label,
          legalName: data.partyMeta.legalName || data.label,
        },
        mlKey: data.mlKey,
        edPublicKeyBase64: data.edPublicKeyBase64,
        mlDsaPublicKeyBase64: data.mlDsaPublicKeyBase64,
      });

      await this.addContact(contact);
      return { success: true, message: "Contact imported successfully" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async importContactFromString(
    base64Str: string,
  ): Promise<MAJIK_API_RESPONSE> {
    try {
      const contact = await this.importContactCompressed(base64Str);
      await this.addContact(contact);
      return { success: true, message: "Contact imported successfully" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  async exportContactCompressed(contact: MajikInvoiceContact): Promise<string> {
    const anyPub: any = contact.publicKey;

    const publicKeyBase64 = arrayBufferToBase64(anyPub.raw.buffer);

    const jsonObj: MajikInvoiceContactCard = {
      id: contact.id,
      label: contact.meta?.label || "",
      publicKey: publicKeyBase64,
      fingerprint: contact.fingerprint,
      mlKey: contact.mlKey,
      edPublicKeyBase64: contact.edPublicKeyBase64,
      mlDsaPublicKeyBase64: contact.mlDsaPublicKeyBase64,
      partyMeta: contact.meta || {},
    };

    const compressed = gzipSync(
      new TextEncoder().encode(JSON.stringify(jsonObj)),
    );
    return arrayToBase64(compressed);
  }

  async importContactCompressed(
    base64Str: string,
  ): Promise<MajikInvoiceContact> {
    const compressed = base64ToArrayBuffer(base64Str);
    const jsonStr = new TextDecoder().decode(
      gunzipSync(new Uint8Array(compressed)),
    );
    const data: MajikInvoiceContactCard = JSON.parse(jsonStr);

    const rawBuffer = base64ToArrayBuffer(data.publicKey as string);

    const publicKey = { raw: new Uint8Array(rawBuffer) };

    if (!data?.id || !publicKey || !data?.fingerprint || !data?.mlKey) {
      throw new Error("Invalid contact JSON");
    }

    return new MajikInvoiceContact({
      id: data.id,
      publicKey,
      fingerprint: data.fingerprint,
      meta: {
        label: data.label,
        legalName: data.partyMeta.legalName || data.label,
      },
      mlKey: data.mlKey,
      edPublicKeyBase64: data.edPublicKeyBase64,
      mlDsaPublicKeyBase64: data.mlDsaPublicKeyBase64,
    });
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  async toJSON(): Promise<MajikInvoiceContactManagerJSON> {
    return {
      contacts: await this.directory.toJSON(),
      groups: this.groupManager.toJSON(),
    };
  }

  /**
   * Restore from a JSON snapshot into the current adapters.
   * Writes all contacts and groups through to the adapters.
   * Used after setAdapters() to migrate data into a new store.
   */
  async bulkRestoreFromJSON(
    data: MajikInvoiceContactManagerJSON,
  ): Promise<void> {
    if (!data?.contacts || !data?.groups) {
      throw new MajikInvoiceContactManagerError(
        "bulkRestoreFromJSON: invalid payload — expected { contacts, groups }",
      );
    }

    await this._contactAdapter.bulkSave(data.contacts.contacts);
    await this._groupAdapter.bulkSave(data.groups.groups);
    await this.hydrate();
  }

  static async fromJSON(
    data: MajikInvoiceContactManagerJSON,
    adapters?: MajikInvoiceContactManagerAdapters,
  ): Promise<MajikInvoiceContactManager> {
    if (!data || typeof data !== "object") {
      throw new MajikInvoiceContactManagerError(
        "fromJSON: invalid payload — expected { contacts, groups }",
      );
    }
    if (!data.contacts) {
      throw new MajikInvoiceContactManagerError(
        "fromJSON: missing required field 'contacts'",
      );
    }
    if (!data.groups) {
      throw new MajikInvoiceContactManagerError(
        "fromJSON: missing required field 'groups'",
      );
    }

    const manager = new MajikInvoiceContactManager(
      undefined,
      undefined,
      adapters,
    );
    await manager.bulkRestoreFromJSON(data);
    return manager;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Persists every group currently in the group manager to the adapter.
   * Used after bulk contact removal where multiple groups may be affected.
   */
  private async _persistAllGroups(): Promise<void> {
    const all = this.groupManager.listGroups(true);
    await this._groupAdapter.bulkSave(all.map((g) => g.toJSON()));
  }

  private static pruneOrphanedMembers(
    directory: MajikInvoiceContactDirectory,
    groupManager: MajikInvoiceContactGroupManager,
  ): void {
    const allGroups = groupManager.listGroups(true);
    for (const group of allGroups) {
      const orphans = group
        .listMemberIds()
        .filter((id) => !directory.hasContact(id));
      for (const orphanId of orphans) {
        group.removeMemberIfPresent(orphanId);
        groupManager.handleContactRemoved(orphanId);
      }
    }
  }

  private assertGroupManagerInstance(gm: unknown): void {
    if (!gm || !(gm instanceof MajikInvoiceContactGroupManager)) {
      throw new MajikInvoiceContactManagerError(
        "groupManager must be a valid MajikInvoiceContactGroupManager instance",
      );
    }
  }
}
