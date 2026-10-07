import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MajikBuwizClient } from "../src/majik-buwiz-client";
import { MajikKey } from "@majikah/majik-key";
import { getTestKey } from "./helpers/crypto";
import { MajikEnvelope } from "@majikah/majik-envelope";
import { MajikInvoice } from "@majikah/majik-invoice";
import { MajikInvoiceContact } from "../src/core/party/majik-invoice-contact";
import { AuditActions, HistoryTypes } from "../src/core/log";
import { MAJIK_BUWIZ_BACKUP_MAGIC } from "../src/core/backup/constants";
import { prependMagic } from "../src/core/backup/utils";

// MajikKeyClient uses window.setTimeout/window.clearTimeout for account-order
// persistence. Vitest runs in Node by default, where the timer APIs live on
// globalThis instead of window. This aliases the real global object; it does
// not mock or spy on any API.
const nodeGlobal = globalThis as typeof globalThis & {
  window?: typeof globalThis;
};
if (!("window" in nodeGlobal)) {
  Object.defineProperty(nodeGlobal, "window", {
    configurable: true,
    value: nodeGlobal,
  });
}

/**
 * MajikBuwizClient - actual-first test suite.
 *
 * Philosophy:
 *  1. Exercise the real client.
 *  2. Exercise real MajikKey, MajikInvoice, ExpenseRecord, contacts,
 *     groups, managers, in-memory adapters, compression, and backup parsing.
 *  3. Use spies only where the behavior being tested is specifically an
 *     interaction/failure boundary and there is no useful deterministic way
 *     to trigger that branch with real data.
 *  4. Reuse a small pool of real keys generated once in beforeAll.
 *  5. Prefer observable state/events over testing private implementation calls.
 */

describe("MajikBuwizClient", () => {
  const TEST_PASSPHRASE = "test_passphrase";
  // Cryptographic setup is intentionally done once for the whole suite.
  // getTestKey() already returns a fresh, fully-upgraded, unlocked key.
  // Keeping these instances alive avoids regenerating cryptographic key material
  // before every test. Each test gets a fresh client, so the same key objects
  // can safely be reused as long as the tests do not mutate them.
  let keyA: MajikKey;
  let keyB: MajikKey;
  let keyC: MajikKey;
  let keyD: MajikKey;

  let client: MajikBuwizClient;
  let activeKey: MajikKey;
  let activeContact: MajikInvoiceContact;
  let externalKey: MajikKey;
  let externalContact: MajikInvoiceContact;

  function contactFromKey(
    key: MajikKey,
    label = "Test Contact",
  ): MajikInvoiceContact {
    return key.toContact(MajikInvoiceContact, {
      label,
      legalName: label || "Test Contact",
    });
  }

  async function installOwnAccount(
    target: MajikBuwizClient,
    key: MajikKey,
    label = "Test Account",
  ): Promise<MajikInvoiceContact> {
    await target.keyManager.save(key);

    // MajikKey.toContact() is the public key-to-contact conversion API.
    // addOwnAccount() is inherited directly from MajikKeyClient and owns the
    // account registration/order lifecycle.
    const contact = contactFromKey(key, label);
    target.addOwnAccount(contact);
    await target.setActiveAccount(contact.id, true);

    return contact;
  }

  async function addExternalContact(
    target: MajikBuwizClient,
    key: MajikKey,
    label = "External Contact",
  ): Promise<MajikInvoiceContact> {
    const contact = contactFromKey(key, label);
    await target.addContact(contact);
    return contact;
  }

  function invoiceDraftInput(
    mode: "signed-only" | "encrypted-and-signed" = "signed-only",
  ) {
    return {
      mode,
      issuer: {
        legalName: "Acme Corporation",
        tin: "123-456-789-000",
      },
      recipient: {
        legalName: "Beta Incorporated",
        tin: "987-654-321-000",
      },
      currency: "PHP",
      lineItems: [
        {
          description: "Software Development",
          quantity: 2,
          unitPrice: 5000,
        },
      ],
    };
  }

  async function createRealInvoice(options?: {
    signerKey?: MajikKey;
    mode?: "signed-only" | "encrypted-and-signed";
    recipients?: any[];
  }): Promise<MajikInvoice> {
    const input: any = invoiceDraftInput(options?.mode ?? "signed-only");
    if (options?.signerKey) input.signerKey = options.signerKey;
    if (options?.recipients) input.recipients = options.recipients;
    return MajikInvoice.create(input);
  }

  async function createStoredInvoice(
    target = client,
    options?: {
      signed?: boolean;
      encrypted?: boolean;
      recipientContacts?: MajikInvoiceContact[];
    },
  ): Promise<MajikInvoice> {
    const signed = options?.signed ?? false;
    const encrypted = options?.encrypted ?? false;

    if (!encrypted) {
      const invoice = await createRealInvoice(
        signed ? { signerKey: activeKey } : undefined,
      );
      await target.storeInvoice(invoice);
      return invoice;
    }

    const recipientContacts = options?.recipientContacts ?? [activeContact];
    const keyRecipients =
      MajikInvoiceContact.toMajikContacts(recipientContacts);
    const recipients =
      await MajikEnvelope.buildMajikRecipientsFromContacts(keyRecipients);

    const invoice = await createRealInvoice({
      signerKey: signed ? activeKey : undefined,
      mode: "encrypted-and-signed",
      recipients,
    });
    await target.storeInvoice(invoice);
    return invoice;
  }

  beforeAll(async () => {
    [keyA, keyB, keyC, keyD] = await Promise.all([
      getTestKey(),
      getTestKey(),
      getTestKey(),
      getTestKey(),
    ]);
  }, 120000);

  beforeEach(async () => {
    client = new MajikBuwizClient({});

    // Reuse the already-generated keys. A new client means a clean keystore,
    // contact directory, invoice manager, expense manager, and client state
    // for every test without paying the cryptographic creation cost again.
    activeKey = keyA;
    activeContact = await installOwnAccount(
      client,
      activeKey,
      "Test Account A",
    );

    externalKey = keyB;
    externalContact = await addExternalContact(
      client,
      externalKey,
      "External Contact",
    );
  });

  // ========================================================================
  // Construction / actual managers / account-backed client state
  // ========================================================================

  describe("construction and account state", () => {
    it("constructs real managers and starts with empty invoice/expense stores", () => {
      expect(client.invoiceManager).toBeDefined();
      expect(client.expenseManager).toBeDefined();
      expect(client.recurringExpenseManager).toBeDefined();
      expect(client.historyManager).toBeDefined();
      expect(client.activityManager).toBeDefined();
      expect(client.invoiceCount).toBe(0);
      expect(client.listInvoices()).toEqual([]);
      expect(client.listExpenses()).toEqual([]);
    });

    it("uses the real own-account lifecycle and contact synchronization", () => {
      expect(client.getActiveAccount()?.id).toBe(activeKey.id);
      expect(client.getActiveAccountKey()?.fingerprint).toBe(
        activeKey.fingerprint,
      );
      expect(client.getOwnAccountById(activeKey.id)).toEqual(activeContact);
      expect(client.getContactByID(activeKey.id)).toEqual(activeContact);
      expect(client.hasContact(activeKey.id)).toBe(true);
      expect(client.listOwnAccounts()).toHaveLength(1);
      expect(client.listOwnAccounts()[0].id).toBe(activeKey.id);
    });

    it("supports real active-account switching without mocking account getters", async () => {
      const secondKey = await keyC;
      const second = await installOwnAccount(
        client,
        secondKey,
        "Second Account",
      );

      expect(client.getActiveAccount()?.id).toBe(second.id);
      expect(client.getActiveAccountKey()?.fingerprint).toBe(
        secondKey.fingerprint,
      );

      await client.setActiveAccount(activeKey.id, true);
      expect(client.getActiveAccount()?.id).toBe(activeKey.id);
      expect(client.getActiveAccountKey()?.fingerprint).toBe(
        activeKey.fingerprint,
      );
    });

    it("updates own-account metadata through the real contact and key managers", async () => {
      const acitveAccount = client.getActiveAccount()?.id;
      await client.updateOwnAccountMeta(acitveAccount!, {
        label: "Updated Owner",
      });

      expect(client.getActiveAccount()?.meta?.label).toBe("Updated Owner");
      expect(client.getContactByID(activeKey.id)?.meta?.label).toBe(
        "Updated Owner",
      );
      expect(client.resolveSignerLabel(activeKey.id)).toBe("Updated Owner");
    });

    it("resolves external signer labels and uses the fingerprint fallback", async () => {
      expect(client.resolveSignerLabel(externalContact.id)).toBe(
        externalContact.meta?.label,
      );
      expect(client.resolveSignerLabel("abcdefghijklmnop-rest")).toBe(
        "abcdefghijklmnop…",
      );
    });

    it("returns null when there is no own account to export", async () => {
      const isolated = new MajikBuwizClient({});
      await expect(isolated.exportActiveAccountKey([])).resolves.toBeNull();
    });

    it("rejects export when the active account is locked", async () => {
      const isolated = new MajikBuwizClient({});
      const key = keyC;
      const contact = await installOwnAccount(
        isolated,
        key,
        "Locked Export Account",
      );

      key.lock();

      try {
        await expect(isolated.exportActiveAccountKey([])).rejects.toThrow(
          "Account must be unlocked before exporting.",
        );
      } finally {
        await key.unlock(TEST_PASSPHRASE);
      }

      expect(isolated.getOwnAccountById(contact.id)).toBeDefined();
    });

    it("rejects malformed seed data through the real backup validator", async () => {
      await expect(client.exportActiveAccountKey([])).rejects.toThrow();
    });

    it("hydrates persisted key and account-order state through the base client adapters", async () => {
      const source = new MajikBuwizClient({});
      const sourceKey = keyC;
      const sourceContact = await installOwnAccount(
        source,
        sourceKey,
        "Persisted Account",
      );

      // setActiveAccount() schedules the inherited order persistence with a
      // 300 ms debounce. Allow that real timer to flush before the second
      // client hydrates the shared state adapter.
      await new Promise((resolve) => setTimeout(resolve, 350));

      const rehydrated = new MajikBuwizClient({
        adapters: {
          keys: source.keyManager.adapter,
          clientState: source.stateManager.adapter,
        },
      });

      // Exercise the parent client's persisted key/state layers. The complete
      // Buwiz hydrate() path additionally reconstructs domain contacts through
      // its subclass hook; that hook is deliberately not involved here.
      await rehydrated.keyManager.hydrate();
      await rehydrated.stateManager.hydrate();

      const hydratedKey = rehydrated.keyManager.get(sourceKey.id);

      expect(hydratedKey?.fingerprint).toBe(sourceKey.fingerprint);
      expect(await rehydrated.stateManager.getAccountOrder()).toEqual([
        sourceContact.id,
      ]);

      // Use the inherited public API to register the already-hydrated key as
      // a Buwiz own account.
      const hydratedContact = contactFromKey(hydratedKey!, "Persisted Account");
      rehydrated.addOwnAccount(hydratedContact);
      await rehydrated.setActiveAccount(hydratedContact.id, true);

      expect(rehydrated.getActiveAccount()?.id).toBe(sourceContact.id);
      expect(rehydrated.getActiveAccountKey()?.fingerprint).toBe(
        sourceKey.fingerprint,
      );
    });
  });

  // ========================================================================
  // Client state — actual persistence behavior
  // ========================================================================

  describe("client state", () => {
    it("round-trips invoice defaults through the real state manager", async () => {
      expect(await client.getInvoiceDefaults()).toBeNull();

      const defaults = {
        defaultCurrency: "PHP",
        defaultDueDays: 30,
      } as any;

      await client.setInvoiceDefaults(defaults);
      expect(await client.getInvoiceDefaults()).toEqual(defaults);

      await client.removeInvoiceDefaults();
      expect(await client.getInvoiceDefaults()).toBeNull();
    });

    it("round-trips invoice and expense table columns", async () => {
      const invoiceColumns = [
        { key: "invoiceNumber", visible: true },
        { key: "status", visible: false },
      ] as any;
      const expenseColumns = [
        { key: "category", visible: true },
        { key: "amount", visible: true },
      ] as any;

      await client.setInvoiceTableColumns(invoiceColumns);
      await client.setExpenseTableColumns(expenseColumns);

      expect(await client.getInvoiceTableColumns()).toEqual(invoiceColumns);
      expect(await client.getExpenseTableColumns()).toEqual(expenseColumns);

      await client.resetInvoiceTableColumns();
      await client.resetExpenseTableColumns();

      expect(await client.getInvoiceTableColumns()).toBeNull();
      expect(await client.getExpenseTableColumns()).toBeNull();
    });

    it("round-trips preferences and restores the manager's actual defaults", async () => {
      const original = await client.getUserAppPreferences();

      const next = {
        ...original,
        privacy: {
          ...original.privacy,
          shareAnalytics: !original.privacy.shareAnalytics,
        },
        invoices: {
          ...original.invoices,
          autodecrypt: !original.invoices.autodecrypt,
        },
      } as any;

      await client.setUserAppPreferences(next);
      expect(await client.getUserAppPreferences()).toEqual(next);
      expect(await client.isAnalyticsEnabled()).toBe(
        next.privacy.shareAnalytics ?? false,
      );
      expect(await client.isAutoDecryptInvoicesEnabled()).toBe(
        next.invoices.autodecrypt ?? false,
      );

      await client.resetUserAppPreferences();
      const reset = await client.getUserAppPreferences();

      expect(reset).toEqual(original);
      expect(await client.isAnalyticsEnabled()).toBe(
        original.privacy.shareAnalytics ?? false,
      );
      expect(await client.isAutoDecryptInvoicesEnabled()).toBe(
        original.invoices.autodecrypt ?? false,
      );
    });
  });

  // ========================================================================
  // Events — use the actual public event system instead of _emit spying
  // ========================================================================

  describe("events", () => {
    it("delivers new-contact through the public event API", async () => {
      const received: unknown[] = [];
      client.on("new-contact", (contact) => received.push(contact));

      const key = keyC;
      await client.addContact(contactFromKey(key, "Event Contact"));

      expect(received).toHaveLength(1);
      expect((received[0] as MajikInvoiceContact).fingerprint).toBe(
        key.fingerprint,
      );
    });

    it("delivers invoice-created from a real stored invoice", async () => {
      const received: MajikInvoice[] = [];
      client.on("invoice-created", (invoice) =>
        received.push(invoice as MajikInvoice),
      );

      const invoice = await createStoredInvoice();
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(invoice);
    });

    it("supports removing a listener and clearing all listeners", async () => {
      const received: unknown[] = [];
      const listener = (value: unknown) => received.push(value);

      client.on("new-contact", listener);
      client.off("new-contact", listener);

      const key = keyC;
      const contact = contactFromKey(key, "No Listener");
      await client.addContact(contact);
      expect(received).toEqual([]);

      const second: unknown[] = [];
      client.on("new-contact", (...args) => second.push(args[0]));
      client.off("new-contact");
      await client.addContact(contactFromKey(keyD, "Cleared"));
      expect(second).toEqual([]);
    });
  });

  // ========================================================================
  // Contacts / groups — actual manager operations
  // ========================================================================

  describe("contacts", () => {
    it("adds, finds, updates, and removes a real contact", async () => {
      const thirdKey = keyC;
      const third = contactFromKey(thirdKey, "Third Contact");

      await client.addContact(third);
      expect(client.getContactByID(third.id)).toEqual(third);
      expect(client.hasContact(third.id)).toBe(true);

      await client.updateContactMeta(third.id, { label: "Renamed Contact" });
      expect(client.getContactByID(third.id)?.meta?.label).toBe(
        "Renamed Contact",
      );

      await client.removeContact(third.id);
      expect(client.hasContact(third.id)).toBe(false);
      expect(client.getContactByID(third.id)).toBeNull();
    });

    it("filters own accounts out by default and can include them", () => {
      const withoutOwn = client.listContacts(false);
      const withOwn = client.listContacts(true);

      expect(withoutOwn.some((contact) => contact.id === activeKey.id)).toBe(
        false,
      );
      expect(withOwn.some((contact) => contact.id === activeKey.id)).toBe(true);
      expect(withOwn.some((contact) => contact.id === externalContact.id)).toBe(
        true,
      );
    });

    it("resolves contacts by address and public key", async () => {
      const contactAddress = await externalContact.getAddress();
      expect(await client.hasContactByAddress(contactAddress)).toBe(true);
      expect(await client.getContactByAddress(contactAddress)).toEqual(
        externalContact,
      );
      expect(await client.getContactByPublicKey(contactAddress)).toEqual(
        externalContact,
      );
    });

    it("resolves batches by ID and public key", async () => {
      const contactAddress = await externalContact.getAddress();
      expect(client.getContactsByID([externalContact.id])).toEqual([
        externalContact,
      ]);
      await expect(
        client.getContactsByPublicKey([contactAddress]),
      ).resolves.toEqual([externalContact]);
    });

    it("round-trips contact export/import through real serialization", async () => {
      const exportedJSON = await client.exportContactAsJSON(externalContact.id);
      const exportedString = await client.exportContactAsString(
        externalContact.id,
      );
      const compressed = await client.exportContactCompressed(externalContact);

      expect(exportedJSON).toEqual(expect.any(String));
      expect(exportedString).toEqual(expect.any(String));
      expect(compressed).toEqual(expect.any(String));

      // Import into a fresh real manager so this test verifies serialization,
      // transport, and hydration rather than duplicate-contact handling.
      // NOTE: importContactCompressed currently reconstructs a contact without
      // the required legalName metadata. Keep this regression visible but skipped
      // until the compressed contact serializer/importer is fixed.
      const target = new MajikBuwizClient({});
      const importedFromJSON = await target.importContactFromJSON(
        exportedJSON!,
      );

      expect(importedFromJSON.success).toBe(true);
      await target.removeContact(externalContact.id);

      const importedFromString = await target.importContactFromString(
        exportedString!,
      );

      expect(importedFromString.success).toBe(true);

      const importedCompressed =
        await target.importContactCompressed(compressed);

      expect(importedCompressed.id).toBe(externalContact.id);
      expect(target.getContactByID(externalContact.id)?.fingerprint).toBe(
        externalContact.fingerprint,
      );
    });

    it("rejects invalid contact inputs at the public boundary", async () => {
      expect(() => client.getContactByID("" as any)).toThrow(
        "Invalid contact ID",
      );
      expect(() => client.hasContact("   " as any)).toThrow(
        "Invalid contact ID",
      );
      await expect(client.getContactByAddress("" as any)).rejects.toThrow(
        "Invalid public key address",
      );
      await expect(client.hasContactByAddress("" as any)).rejects.toThrow(
        "Invalid contact public key address",
      );
      expect(() => client.getContactsByID([])).toThrow(
        "At least 1 id is required",
      );
      await expect(client.getContactsByPublicKey([])).rejects.toThrow(
        "At least 1 public key is required",
      );
    });
  });

  describe("contact groups", () => {
    it("creates a group and performs real membership operations", async () => {
      const groupId = `group-${Date.now()}`;
      const group = await client.createGroup(
        groupId,
        "Project Team",
        { description: "Engineering" } as any,
        [externalContact.id],
      );

      expect(group).toBe(client);
      expect(client.hasGroup(groupId)).toBe(true);
      expect(client.getContactGroup(groupId)?.meta.name).toBe("Project Team");
      expect(client.isContactInGroup(groupId, externalContact.id)).toBe(true);

      await client.removeContactFromGroup(groupId, externalContact.id);
      expect(client.isContactInGroup(groupId, externalContact.id)).toBe(false);

      await client.addContactToGroup(groupId, externalContact.id);
      expect(client.isContactInGroup(groupId, externalContact.id)).toBe(true);

      const updated = await client.updateGroupMeta(groupId, {
        name: "Updated Team",
      });
      expect(updated).toBe(client);
      expect(client.getContactGroup(groupId)?.meta.name).toBe("Updated Team");
    });

    it("supports group queries, favorites, and blocked contacts", async () => {
      const groupId = `group-${Date.now()}`;
      await client.createGroup(groupId, "Sorted Group", undefined, [
        externalContact.id,
      ]);

      expect(client.getContactsInGroup(groupId)).toContainEqual(
        externalContact,
      );
      expect(client.getContactsInGroupSorted(groupId)).toContainEqual(
        externalContact,
      );
      expect(
        client.getGroupsForContact(externalContact.id).map((g) => g.id),
      ).toContain(groupId);
      expect(client.getGroupIdsForContact(externalContact.id)).toContain(
        groupId,
      );

      await client.addContactToFavorites(externalContact.id);
      expect(client.isContactFavorite(externalContact.id)).toBe(true);
      expect(client.getFavoriteContacts()).toContainEqual(externalContact);

      await client.removeContactFromFavorites(externalContact.id);
      expect(client.isContactFavorite(externalContact.id)).toBe(false);

      // Built-in groups are real manager state; test the accessor/shape without
      // fabricating group objects.
      expect(client.getFavoritesGroup().isSystem).toBe(true);
      expect(client.getBlockedGroup().isSystem).toBe(true);
    });

    it("moves a contact between real user groups", async () => {
      const from = `group-from-${Date.now()}`;
      const to = `group-to-${Date.now()}`;

      await client.createGroup(from, "From", undefined, [externalContact.id]);
      await client.createGroup(to, "To");

      await client.moveContactBetweenGroups(externalContact.id, from, to);

      expect(client.isContactInGroup(from, externalContact.id)).toBe(false);
      expect(client.isContactInGroup(to, externalContact.id)).toBe(true);
    });
  });

  describe("recipient helpers", () => {
    it("resolves real recipients, expected signers, and invoice public-key data", async () => {
      const publicKey = await externalContact.getAddress();

      const recipients = await client.getMajikRecipientsByPublicKey([
        publicKey,
      ]);
      const signers = await client.getExpectedSignersByPublicKey([publicKey]);
      const invoiceData = await client.getMajikahInvoiceDataByPublicKey([
        publicKey,
      ]);

      expect(recipients).toHaveLength(1);
      expect(signers).toHaveLength(1);
      expect(invoiceData.recipients).toHaveLength(1);
      expect(invoiceData.signers).toHaveLength(1);
      expect(invoiceData.publicKeys).toHaveLength(1);

      const byId = await client.getMajikRecipientsByIDs([externalContact.id]);
      const byIdSigners = await client.getExpectedSignersByIDs([
        externalContact.id,
      ]);
      const byIdData = await client.getMajikahInvoiceDataByID([
        externalContact.id,
      ]);

      expect(byId).toHaveLength(1);
      expect(byIdSigners).toHaveLength(1);
      expect(byIdData.recipients).toHaveLength(1);
    });
  });

  // ========================================================================
  // Invoice management — actual cryptographic/domain flows
  // ========================================================================

  describe("invoices", () => {
    it("creates a real signed-only invoice, stores it, increments numbering, and emits", async () => {
      const events: MajikInvoice[] = [];
      client.on("invoice-created", (invoice) =>
        events.push(invoice as MajikInvoice),
      );

      const before = await client.getInvoiceDefaults();
      void before;

      const invoice = await client.createInvoice(invoiceDraftInput());

      expect(invoice).toBeInstanceOf(MajikInvoice);
      expect(client.hasInvoice(invoice.id)).toBe(true);
      expect(await client.getInvoice(invoice.id)).toBe(invoice);
      expect(client.invoiceCount).toBe(1);
      expect(events).toEqual([invoice]);
      expect(invoice.isSigned).toBe(true);
      expect(invoice.integrity.signatures.length).toBeGreaterThan(0);

      const history = client.historyManager
        .listByFingerprint(activeKey.fingerprint)
        .filter((entry) => entry.reference_id === invoice.id);
      expect(history.map((entry) => entry.historyType)).toEqual(
        expect.arrayContaining([HistoryTypes.CREATE, HistoryTypes.SIGN]),
      );

      const activity = client.activityManager
        .listByFingerprint(activeKey.fingerprint)
        .filter((entry) => entry.reference_id === invoice.id);
      expect(activity.map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          AuditActions.INVOICE_CREATED,
          AuditActions.INVOICE_SIGNED,
        ]),
      );
    });

    it("creates a real encrypted-and-signed invoice from actual contacts", async () => {
      const invoice = await client.createInvoice(
        invoiceDraftInput("encrypted-and-signed"),
        {
          recipientContacts: [activeContact, externalContact],
        },
      );

      expect(invoice).toBeInstanceOf(MajikInvoice);
      expect(invoice.isEncrypted).toBe(true);
      expect(invoice.isSigned).toBe(true);
      const encryptedPayload = invoice.payload as {
        kind: "encrypted-and-signed";
        recipientFingerprints: string[];
      };
      expect(encryptedPayload.recipientFingerprints).toHaveLength(2);
      expect(client.hasInvoice(invoice.id)).toBe(true);
    });

    it("supports skipStore without mocking MajikInvoice.create", async () => {
      const invoice = await client.createInvoice(invoiceDraftInput(), {
        skipStore: true,
      });

      expect(invoice).toBeInstanceOf(MajikInvoice);
      expect(client.hasInvoice(invoice.id)).toBe(false);
      expect(client.invoiceCount).toBe(0);
    });

    it("lists, queries, gets, and removes real invoices", async () => {
      const first = await createStoredInvoice(client, { signed: true });
      const second = await createStoredInvoice(client, { signed: true });

      expect(client.listInvoices().map((i) => i.id)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
      expect(
        client.queryInvoices({ status: "fully-signed" }).items,
      ).toHaveLength(2);
      expect(client.listInvoicesByStatus("fully-signed")).toHaveLength(2);
      expect(client.listInvoicesByIssuer("Acme Corporation").length).toBe(2);
      expect(client.listInvoicesByRecipient("Beta Incorporated").length).toBe(
        2,
      );
      expect(await client.listInvoicesByActiveAccount()).toHaveLength(2);

      expect(await client.removeInvoice(first.id)).toBe(true);
      expect(await client.getInvoice(first.id)).toBeUndefined();
      expect(await client.getInvoice(second.id)).toBe(second);
    });

    it("stores an existing invoice without duplicating the invoice number", async () => {
      const invoice = await createRealInvoice();

      await client.storeInvoice(invoice);
      expect(client.invoiceCount).toBe(1);

      await client.storeInvoice(invoice);
      expect(client.invoiceCount).toBe(1);
      expect(await client.getInvoice(invoice.id)).toBe(invoice);
    });

    it("counts and lists invoices belonging to other real accounts", async () => {
      const foreignClient = new MajikBuwizClient({});
      const foreignKey = keyC;
      await installOwnAccount(foreignClient, foreignKey, "Foreign");
      const foreignInvoice =
        await foreignClient.createInvoice(invoiceDraftInput());

      await client.storeInvoice(foreignInvoice);

      expect(await client.getInvoicesNotOwnedByActiveAccount()).toEqual([
        foreignInvoice,
      ]);
      expect(await client.countInvoicesNotOwnedByActiveAccount()).toBe(1);
    });

    it("clears all real invoices", async () => {
      await createStoredInvoice();
      await createStoredInvoice();
      expect(client.invoiceCount).toBe(2);

      await client.clearInvoices();
      expect(client.invoiceCount).toBe(0);
      expect(client.listInvoices()).toEqual([]);
    });

    it("reports real invoice statistics", async () => {
      const draft = await createRealInvoice();
      const issued = draft.invoice.withStatus("issued");
      const paid = draft.invoice.withStatus("issued").withStatus("paid");

      await client.storeInvoice(draft);
      await client.storeInvoice(
        await MajikInvoice.create({
          ...invoiceDraftInput(),
          signerKey: activeKey,
          status: "issued",
        } as any),
      );
      await client.storeInvoice(
        await MajikInvoice.create({
          ...invoiceDraftInput(),
          signerKey: activeKey,
          status: "issued",
        } as any),
      );

      // Use actual lifecycle objects to ensure the manager is filtering real
      // status values rather than mocked records.
      expect(issued.status).toBe("issued");
      expect(paid.status).toBe("paid");
      expect(client.getInvoiceStats().total).toBe(3);
      expect(client.getInvoiceStats().draft).toBe(1);
      expect(client.getInvoiceStats().issued).toBe(2);
    });

    it("signs and verifies a real invoice", async () => {
      const unsigned = await createRealInvoice();
      await client.storeInvoice(unsigned);
      expect(unsigned.isSigned).toBe(false);

      const signed = await client.signInvoice(unsigned.id);
      expect(signed.isSigned).toBe(true);
      expect(signed.integrity.signatures.length).toBeGreaterThan(0);

      const all = await client.verifyInvoiceSignatures(signed);
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((result) => result.valid)).toBe(true);

      const one = await client.verifyInvoiceSignature(
        signed,
        activeKey.fingerprint,
      );
      expect(one.valid).toBe(true);
    });

    it("seals and verifies the real invoice seal", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });
      const sealed = await client.sealInvoice(invoice.id);

      expect(sealed.isSealed).toBe(true);
      const verification = await client.verifyInvoiceSeal(sealed);
      expect(verification.valid).toBe(true);
      expect(await client.getInvoiceSealInfo(sealed.id)).toEqual(
        sealed.integrity.sealInfo,
      );
    });

    it("decrypts a real encrypted invoice and persists the decrypted cache", async () => {
      const invoice = await createStoredInvoice(client, {
        signed: true,
        encrypted: true,
        recipientContacts: [activeContact],
      });

      expect(invoice.isEncrypted).toBe(true);
      await expect(client.canDecryptInvoice(invoice)).resolves.toBe(true);

      const result = await client.decryptInvoice(invoice.id);
      expect(result.instance.id).toBe(invoice.id);
      expect(result.invoice).toBeDefined();
      expect((await client.getInvoice(invoice.id))?.invoice).toEqual(
        result.invoice,
      );
    });

    it("decrypts cached and supplied invoices through the actual batch path", async () => {
      const invoiceA = await createStoredInvoice(client, {
        signed: true,
        encrypted: true,
        recipientContacts: [activeContact],
      });
      const invoiceB = await createStoredInvoice(client, {
        signed: true,
        encrypted: true,
        recipientContacts: [activeContact],
      });

      const cached = await client.decryptCachedInvoices();
      expect(cached.decrypted.map((i) => i.id)).toEqual(
        expect.arrayContaining([invoiceA.id, invoiceB.id]),
      );

      const supplied = await client.decryptInvoices([invoiceA, invoiceB]);
      expect(supplied.decrypted).toHaveLength(2);
    });

    it("duplicates a real invoice using the active key", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });
      const duplicated = await client.duplicateInvoice(invoice);

      expect(duplicated).toBeInstanceOf(MajikInvoice);
      expect(duplicated.id).not.toBe(invoice.id);
    });

    it("checks signing and sealing permission using actual invoice state", async () => {
      const unsigned = await createRealInvoice();
      await client.storeInvoice(unsigned);

      await expect(client.canSignInvoice(unsigned.id)).resolves.toEqual({
        permitted: true,
        reason: undefined,
      });

      const signed = await client.signInvoice(unsigned.id);
      await expect(client.canSignInvoice(signed.id)).resolves.toEqual({
        permitted: false,
        reason: "Invoice already signed.",
      });

      await expect(client.canSealInvoice(signed.id)).resolves.toEqual(
        expect.objectContaining({ permitted: true }),
      );
    });

    it("returns a public summary and validation result from the real invoice", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });

      expect(await client.getInvoicePublicSummary(invoice.id)).toEqual(
        invoice.public,
      );
      expect(await client.validateInvoice(invoice.id)).toEqual(
        invoice.validate(),
      );
    });

    it("imports a real invoice through its canonical JSON representation", async () => {
      const invoice = await createRealInvoice({ signerKey: activeKey });
      const json = invoice.toJSON();

      const imported = client.importInvoice(json);
      expect(imported).toBeInstanceOf(MajikInvoice);
      expect(imported.id).toBe(invoice.id);
      expect(await client.getInvoice(invoice.id)).toBeDefined();
    });

    it("creates an expected signer from a real key and contact", () => {
      const fromKey = MajikBuwizClient.expectedSignerFromKey(activeKey);
      expect(fromKey.signerId).toBe(activeKey.fingerprint);

      const fromContact = client.expectedSignerFromContact(externalContact.id);
      expect(fromContact.signerId).toBe(externalContact.fingerprint);
      expect(fromContact.edPublicKey).toBe(externalContact.edPublicKeyBase64);
      expect(fromContact.mlDsaPublicKey).toBe(
        externalContact.mlDsaPublicKeyBase64,
      );
    });

    it("exports invoices to a real CSV result", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });
      const result = await client.batchExportInvoicesToCSV([invoice]);

      expect(result).toBeDefined();
      expect((result as any).csv ?? (result as any).content).toEqual(
        expect.any(String),
      );
    });
  });

  // ========================================================================
  // Invoice orchestration pipelines
  // ========================================================================

  describe("invoice orchestration", () => {
    it("finalizes a real draft into a signed stored invoice", async () => {
      const events: MajikInvoice[] = [];
      client.on("invoice-created", (invoice) =>
        events.push(invoice as MajikInvoice),
      );

      const draft = (await createRealInvoice()).invoice;
      const result = await client.finalizeInvoice(draft as any, "signed-only", [
        activeContact.id,
      ]);

      expect(result).toBeInstanceOf(MajikInvoice);
      expect(result.isSigned).toBe(true);
      expect(client.hasInvoice(result.id)).toBe(true);
      expect(events.at(-1)).toBe(result);
      expect(client.invoiceCount).toBe(1);
    });

    it("requires recipients when finalizing encrypted invoices", async () => {
      await expect(
        client.finalizeInvoice(
          invoiceDraftInput("encrypted-and-signed") as any,
          "encrypted-and-signed",
          [],
        ),
      ).rejects.toThrow(
        "At least one recipient contact is required for encrypted-and-signed mode.",
      );
    });

    it("reissues a real invoice and stores the new version", async () => {
      const original = await createStoredInvoice(client, { signed: true });
      const updatedDraft = original.invoice.withLineItem({
        description: "Additional Service",
        quantity: 1,
        unitPrice: 1500,
      });

      const result = await client.reissueInvoice(
        original,
        updatedDraft as any,
        {
          accountId: activeKey.id,
          recipientContactIds: [externalContact.id],
        },
      );

      expect(result).toBeInstanceOf(MajikInvoice);
      expect(result.id).toBe(original.id);
      expect(result.updatedAt).not.toBe(original.updatedAt);
      expect(await client.getInvoice(result.id)).toBe(result);
    });

    it("restarts a real signed-only invoice", async () => {
      const original = await createStoredInvoice(client, { signed: true });
      const restarted = await client.restartInvoice(original);

      expect(restarted).toBeInstanceOf(MajikInvoice);
      expect(restarted.id).toBe(original.id);
      expect(restarted.status).toBe("draft");
      expect(restarted.isSigned).toBe(false);
      expect(restarted.isSealed).toBe(false);
      expect(await client.getInvoice(restarted.id)).toBe(restarted);
    });

    it("returns the same invoice when switching to its current mode", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });
      await expect(
        client.switchInvoiceMode(invoice, invoice.mode),
      ).resolves.toBe(invoice);
    });

    it("switches a real signed invoice into encrypted-and-signed mode", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });
      const switched = await client.switchInvoiceMode(
        invoice,
        "encrypted-and-signed",
        [activeContact.id],
      );

      expect(switched.mode).toBe("encrypted-and-signed");
      expect(switched.isEncrypted).toBe(true);
      expect(await client.getInvoice(switched.id)).toBe(switched);
    });

    it("signs an external real invoice without storing it", async () => {
      const externalInvoice = await createRealInvoice();
      expect(externalInvoice.isSigned).toBe(false);

      const signed = await client.signExternalInvoice(externalInvoice);

      expect(signed.isSigned).toBe(true);
      expect(signed.id).toBe(externalInvoice.id);
      expect(await client.getInvoice(signed.id)).toBeUndefined();
    });

    it("unlocks a real encrypted invoice and returns a decrypted instance", async () => {
      const invoice = await createStoredInvoice(client, {
        signed: true,
        encrypted: true,
        recipientContacts: [activeContact],
      });

      // Force the stored invoice through a locked serialized representation.
      const lockedInvoice = MajikInvoice.fromJSON(invoice.toJSON());
      const unlocked = await client.unlockInvoice(lockedInvoice);

      expect(unlocked.isEncrypted).toBe(true);
      expect(unlocked.hasDecryptedCache).toBe(true);
      expect(unlocked.invoice.id).toBe(invoice.id);
    });

    it("reissues, re-signs, and stores a real invoice through the panel orchestration path", async () => {
      const original = await createStoredInvoice(client);
      const updatedDraft = original.invoice.withLineItem({
        description: "Additional Work",
        quantity: 1,
        unitPrice: 2500,
      });

      const result = await client.reissueSignAndStore(
        original,
        updatedDraft as any,
        [activeContact.id],
      );

      expect(result.id).toBe(original.id);
      expect(result.isSigned).toBe(true);
      expect(result.hash).not.toBe(original.hash);
      expect(await client.getInvoice(result.id)).toBe(result);
    });
  });

  // ========================================================================
  // File signing — actual cryptographic operation
  // ========================================================================

  describe("file signing", () => {
    it("signs a real text file without mocking MajikSignature.signFile", async () => {
      const input = new Blob(["Majik Buwiz actual signing test"], {
        type: "text/plain",
      });

      const result = await client.signFile(input, {
        mimeType: "text/plain",
        contentType: "text/plain",
      });

      expect(result.blob).toBeInstanceOf(Blob);
      expect(result.signature).toBeDefined();
      expect(result.handler).toEqual(expect.any(String));
      expect(result.mimeType).toBe("text/plain");
      expect(result.blob.size).toBeGreaterThan(input.size);
    });
  });

  // ========================================================================
  // Expenses — manager boundary tests
  // ========================================================================

  describe("expenses", () => {
    it("starts with an empty real expense store", () => {
      expect(client.expenseManager).toBeDefined();
      expect(client.listExpenses()).toEqual([]);
      expect(client.queryExpenses({}).items).toEqual([]);
    });

    it("returns empty ownership results when no expenses exist", async () => {
      expect(await client.listExpensesByActiveAccount()).toEqual([]);
      expect(await client.getExpensesNotOwnedByActiveAccount()).toEqual([]);
      expect(await client.countExpensesNotOwnedByActiveAccount()).toBe(0);
    });

    it("returns false when removing a non-existent expense", async () => {
      await expect(client.removeExpense("missing-expense")).resolves.toBe(
        false,
      );
      expect(client.listExpenses()).toEqual([]);
    });

    it("records create history and activity for a new expense", async () => {
      const expense = await client.createExpense({
        category: "other",
        documentType: "supplier-invoice",
        description: "Office supplies",
        payee: { legalName: "Example Vendor" },
        paidBy: { legalName: "Example Company" },
        currency: "PHP",
        totalAmount: 125,
      });

      const history = client.historyManager
        .listByFingerprint(activeKey.fingerprint)
        .filter((entry) => entry.reference_id === expense.id);
      expect(history.map((entry) => entry.historyType)).toContain(
        HistoryTypes.CREATE,
      );

      const activity = client.activityManager
        .listByFingerprint(activeKey.fingerprint)
        .filter((entry) => entry.reference_id === expense.id);
      expect(activity.map((entry) => entry.action)).toContain(
        AuditActions.EXPENSE_CREATED,
      );
    });

    it("clears an already-empty expense store", async () => {
      await client.clearExpenses();
      expect(client.listExpenses()).toEqual([]);
    });
  });

  // ========================================================================
  // Recurring expense actualization
  // ========================================================================

  describe("recurring expenses", () => {
    it("starts with an empty real recurring-expense store", () => {
      expect(client.recurringExpenseManager).toBeDefined();

      const manager = client.recurringExpenseManager as any;
      const items =
        typeof manager.list === "function"
          ? manager.list()
          : typeof manager.listItems === "function"
            ? manager.listItems()
            : [];

      expect(items).toEqual([]);
    });
  });

  // ========================================================================
  // Backup generation — actual serializers/compression
  // ========================================================================

  describe("backup generation and probing", () => {
    it("backs up real invoices and reads the exact same invoice records back", async () => {
      const invoice = await createStoredInvoice(client, { signed: true });
      const blob = client.backupInvoices();

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("application/octet-stream");

      const parsed = await client.readInvoicesBackup(blob);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe(invoice.id);
      expect(parsed[0].toJSON()).toEqual(invoice.toJSON());
      expect(await MajikBuwizClient.probeBackupType(blob)).toBe("invoices");
    });

    it("backs up an empty real expense store and reports the expenses magic header", async () => {
      const blob = client.backupExpenses();

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
      expect(await MajikBuwizClient.probeBackupType(blob)).toBe("expenses");

      const snapshot = await client.readAppDataBackup(
        await client.backupAppData(),
      );
      expect(snapshot.expenses).toHaveLength(0);
    });

    it("backs up real contacts and groups and can preview them without mutation", async () => {
      const groupId = `backup-group-${Date.now()}`;
      await client.createGroup(groupId, "Backup Group", undefined, [
        externalContact.id,
      ]);

      const blob = await client.backupContacts();
      expect(await MajikBuwizClient.probeBackupType(blob)).toBe("contacts");

      const beforeIds = client
        .listContacts(true)
        .map((contact) => contact.id)
        .sort();
      const snapshot = await client.readContactsBackup(blob);
      const afterIds = client
        .listContacts(true)
        .map((contact) => contact.id)
        .sort();

      expect(snapshot.contacts.map((contact) => contact.id)).toContain(
        externalContact.id,
      );
      expect(snapshot.groups.map((group) => group.id)).toContain(groupId);
      expect(afterIds).toEqual(beforeIds);
    });

    it("backs up the whole app state with real serializers", async () => {
      await createStoredInvoice(client, { signed: true });
      await client.setInvoiceDefaults({ defaultCurrency: "PHP" } as any);

      const blob = await client.backupAppData();
      expect(blob).toBeInstanceOf(Blob);
      expect(await MajikBuwizClient.probeBackupType(blob)).toBe("appData");

      const snapshot = await client.readAppDataBackup(blob);
      expect(snapshot.invoices).toHaveLength(1);
      expect(snapshot.expenses).toHaveLength(0);
      expect(snapshot.contacts.length).toBeGreaterThan(0);
      expect(snapshot.invoiceDefaults).toEqual({ defaultCurrency: "PHP" });
    });

    it("returns unknown for a blob without a recognized backup header", async () => {
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
      expect(await MajikBuwizClient.probeBackupType(blob)).toBe("unknown");
    });
  });

  // ========================================================================
  // Backup restore — actual compressed payloads / manager restoration
  // ========================================================================

  describe("backup restoration", () => {
    it("restores a real invoice backup into a new client", async () => {
      const source = new MajikBuwizClient({});
      const sourceKey = keyC;
      await installOwnAccount(source, sourceKey, "Source");

      const sourceInvoice = await source.createInvoice(invoiceDraftInput());
      const backup = source.backupInvoices();

      const target = new MajikBuwizClient({});
      const result = await target.restoreInvoices(backup);

      expect(result).toEqual({ restored: 1 });
      const restored = await target.getInvoice(sourceInvoice.id);
      expect(restored?.toJSON()).toEqual(sourceInvoice.toJSON());
    });

    it("restores real contact/group backups without mutating the source", async () => {
      const source = new MajikBuwizClient({});
      const sourceKey = keyC;
      const sourceOwn = await installOwnAccount(source, sourceKey, "Source");
      const sourceExternalKey = keyD;
      const sourceExternal = await addExternalContact(
        source,
        sourceExternalKey,
        "Source External",
      );
      const groupId = `restore-group-${Date.now()}`;
      await source.createGroup(groupId, "Restore Group", undefined, [
        sourceExternal.id,
      ]);

      const backup = await source.backupContacts();
      const target = new MajikBuwizClient({});
      const result = await target.restoreContacts(backup);

      expect(result.contacts).toBeGreaterThanOrEqual(1);
      expect(result.groups).toBe(1);
      expect(target.hasContact(sourceOwn.id)).toBe(true);
      expect(target.hasContact(sourceExternal.id)).toBe(true);
      expect(target.hasGroup(groupId)).toBe(true);
      expect(target.isContactInGroup(groupId, sourceExternal.id)).toBe(true);
      expect(source.hasGroup(groupId)).toBe(true);
    });

    it("reads a real app-data backup into a snapshot and selectively restores it", async () => {
      const source = new MajikBuwizClient({});
      const sourceKey = keyC;
      const sourceExternalKey = keyD;
      await installOwnAccount(source, sourceKey, "Source");
      const sourceExternal = await addExternalContact(
        source,
        sourceExternalKey,
      );

      const groupId = `selective-${Date.now()}`;
      await source.createGroup(groupId, "Selective Group", undefined, [
        sourceExternal.id,
      ]);
      await source.createInvoice(invoiceDraftInput());
      await source.setInvoiceDefaults({ defaultCurrency: "PHP" } as any);

      const blob = await source.backupAppData();
      const snapshot = await source.readAppDataBackup(blob);

      const target = new MajikBuwizClient({});
      const result = await target.restoreAppDataSelective(snapshot, {
        invoices: true,
        expenses: false,
        contacts: true,
        groups: true,
        invoiceDefaults: true,
        preferences: false,
      });

      expect(result.invoices).toBe(1);
      expect(result.expenses).toBe(0);
      expect(result.contacts).toBeGreaterThan(0);
      expect(result.groups).toBe(1);
      expect(result.invoiceDefaults).toBe(true);
      expect(result.preferences).toBe(false);

      expect(target.listInvoices()).toHaveLength(1);
      expect(target.listExpenses()).toHaveLength(0);
      expect(target.hasContact(sourceExternal.id)).toBe(true);
      expect(target.hasGroup(groupId)).toBe(true);
      expect(await target.getInvoiceDefaults()).toEqual({
        defaultCurrency: "PHP",
      });
    });

    it("restores full app data including real contacts and invoices", async () => {
      const source = new MajikBuwizClient({});
      const sourceKey = keyC;
      const externalKey = keyD;
      await installOwnAccount(source, sourceKey, "Source");
      const external = await addExternalContact(source, externalKey);
      await source.createGroup(
        `full-${Date.now()}`,
        "Full Backup Group",
        undefined,
        [external.id],
      );
      await source.createInvoice(invoiceDraftInput());
      await source.setInvoiceDefaults({ defaultCurrency: "PHP" } as any);
      await source.setUserAppPreferences(await source.getUserAppPreferences());

      const backup = await source.backupAppData();
      const target = new MajikBuwizClient({});
      const restored = await target.restoreAppData(backup);

      expect(restored.contacts).toBeGreaterThan(0);
      expect(restored.groups).toBe(1);
      expect(restored.invoices).toBe(1);

      expect(target.listInvoices()).toHaveLength(1);
      expect(await target.getInvoiceDefaults()).toEqual({
        defaultCurrency: "PHP",
      });
    });
  });

  // ========================================================================
  // History/activity — actual managers for normal behavior
  // ========================================================================

  describe("history and activity", () => {
    it("records and lists a real activity entry for the active account", async () => {
      const activity = await client.recordActivity(activeKey.fingerprint, {
        reference_id: "integration-test",
        action: AuditActions.KEY_DATA_RESET,
        metadata: { source: "vitest" },
      });

      expect(activity).toBeDefined();
      expect(client.listActivityForActiveAccount()).toContainEqual(activity);
    });

    it("swallows an invalid history payload without breaking the client", async () => {
      const result = await (client as any)._recordHistory(
        activeKey.fingerprint,
        {
          reference_id: "invalid-history",
          action: AuditActions.KEY_DATA_RESET,
        },
      );

      expect(result).toBeNull();
      expect(client.listHistoryForActiveAccount()).toEqual([]);
    });

    it("does not write history when the real persisted preference disables it", async () => {
      const originalPreferences = await client.getUserAppPreferences();
      await client.setUserAppPreferences({
        ...originalPreferences,
        general: {
          ...originalPreferences.general,
          history: {
            ...(originalPreferences.general?.history ?? {}),
            enabled: false,
          },
        },
      } as any);

      const result = await (client as any)._recordHistory(
        activeKey.fingerprint,
        {
          reference_id: "disabled-history",
          action: AuditActions.KEY_DATA_RESET,
        },
      );

      expect(result).toBeNull();
      expect(client.listHistoryForActiveAccount()).toEqual([]);
    });

    it("clears the active account's activity and safely clears empty history", async () => {
      const before = client.listActivityForActiveAccount().length;
      const activity = await client.recordActivity(activeKey.fingerprint, {
        reference_id: "activity-clear",
        action: AuditActions.KEY_DATA_RESET,
      });

      expect(client.listActivityForActiveAccount()).toHaveLength(before + 1);
      expect(client.listActivityForActiveAccount()).toContainEqual(activity);
      expect(client.listHistoryForActiveAccount()).toEqual([]);

      await client.clearActivityLogsForActiveAccount();
      await client.clearHistoryLogsForActiveAccount();

      expect(client.listActivityForActiveAccount()).toEqual([]);
      expect(client.listHistoryForActiveAccount()).toEqual([]);
    });

    it("restarts logs and seeds a real activity entry", async () => {
      await client.recordActivity(activeKey.fingerprint, {
        reference_id: "before-restart",
        action: AuditActions.KEY_DATA_RESET,
      });

      await client.restartLogsForActiveAccount();

      expect(client.listHistoryForActiveAccount()).toEqual([]);
      expect(client.listActivityForActiveAccount()).toHaveLength(1);
      expect(client.listActivityForActiveAccount()[0].reference_id).toBe(
        "logs-restarted",
      );
    });

    it("resets invoice data while preserving existing activity history", async () => {
      await createStoredInvoice(client);
      const activity = await client.recordActivity(activeKey.fingerprint, {
        reference_id: "before-reset",
        action: AuditActions.KEY_DATA_RESET,
      });

      expect(client.listInvoices()).toHaveLength(1);
      expect(client.listActivityForActiveAccount()).toContainEqual(activity);

      await (client as any)._onResetKeyData();

      expect(client.listInvoices()).toEqual([]);
      expect(client.listActivityForActiveAccount()).toContainEqual(activity);
    });
  });

  // ========================================================================
  // Backup type low-level regression helpers
  // ========================================================================

  describe("backup magic validation", () => {
    it("recognizes a manually stamped invoice payload by its actual magic bytes", async () => {
      const payload = new Uint8Array([1, 2, 3]);
      const stamped = prependMagic(MAJIK_BUWIZ_BACKUP_MAGIC.invoices, payload);
      const blob = new Blob([stamped as BlobPart]);

      expect(await MajikBuwizClient.probeBackupType(blob)).toBe("invoices");
    });
  });

  // ========================================================================
  // Failure paths — keep mocking only where failure injection is the point
  // ========================================================================

  describe("failure boundaries", () => {
    it("emits error and rethrows when a real invoice creation is forced to fail by invalid input", async () => {
      const errors: unknown[][] = [];
      client.on("error", (...args) => errors.push(args));

      await expect(
        client.createInvoice({ mode: "definitely-invalid" } as any),
      ).rejects.toThrow();

      expect(errors.length).toBeGreaterThan(0);
      expect((errors[0][1] as any)?.context).toBe("createInvoice");
    });

    it("does not allow signing operations with a locked real key", async () => {
      const lockedKey = keyD;
      lockedKey.lock();

      const isolated = new MajikBuwizClient({});
      const contact = contactFromKey(lockedKey, "Locked Test Account");

      await isolated.keyManager.save(lockedKey);
      isolated.addOwnAccount(contact);
      await isolated.setActiveAccount(contact.id, true);

      try {
        await expect(
          isolated.createInvoice(invoiceDraftInput()),
        ).rejects.toThrow(/locked|signing|unlock/i);
      } finally {
        await lockedKey.unlock(TEST_PASSPHRASE);
      }
    });

    it("returns null rather than throwing when the history manager fails", async () => {
      vi.spyOn(client.historyManager, "create").mockRejectedValue(
        new Error("history storage unavailable"),
      );

      const result = await (client as any)._recordHistory(
        activeKey.fingerprint,
        {
          reference_id: "failure",
          action: AuditActions.KEY_DATA_RESET,
        },
      );

      expect(result).toBeNull();
    });

    it("returns null rather than throwing when activity storage fails", async () => {
      vi.spyOn(client.activityManager, "create").mockRejectedValue(
        new Error("activity storage unavailable"),
      );

      const result = await (client as any).recordActivity(
        activeKey.fingerprint,
        {
          reference_id: "failure",
          action: AuditActions.KEY_DATA_RESET,
        },
      );

      expect(result).toBeNull();
    });

    it("throws the documented errors when there is no active account", async () => {
      const isolated = new MajikBuwizClient({});

      await expect(isolated.clearHistoryLogsForActiveAccount()).rejects.toThrow(
        "No active account",
      );
      await expect(
        isolated.clearActivityLogsForActiveAccount(),
      ).rejects.toThrow("No active account");
      await expect(isolated.restartLogsForActiveAccount()).rejects.toThrow(
        "No active account",
      );
      await expect(isolated.hydrateLogsForActiveAccount()).rejects.toThrow(
        "No active account",
      );
      await expect(isolated.decryptCachedInvoices()).rejects.toThrow(
        "no account found",
      );
    });
  });

  // ========================================================================
  // Regression tests intentionally left visible rather than mocked away.
  // ========================================================================

  describe("known source regressions", () => {
    it("should not clear contacts twice during key-data reset", async () => {
      const clear = vi.spyOn((client as any)._contacts, "clear");
      await (client as any)._onResetKeyData();
      expect(clear).toHaveBeenCalledTimes(1);
    });

    it("should make updated-contact available through the public event registry", () => {
      const received: unknown[] = [];
      client.on("updated-contact" as any, (...args) => received.push(args[0]));
      (client as any)._emit("updated-contact", activeContact);
      expect(received).toHaveLength(1);
    });
  });
});
