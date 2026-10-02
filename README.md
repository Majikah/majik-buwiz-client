# Majik Buwiz Client

**Majik Buwiz Client** is a high-level TypeScript client for the **MajikBuwiz** business and invoicing ecosystem.

Built on top of [`MajikKeyClient`](https://www.npmjs.com/package/@majikah/majik-key-client), it combines cryptographic account management with business-domain functionality for **invoices, expenses, contacts, contact groups, recurring expenses, backups, application preferences, and audit/activity logs**.

Instead of requiring application code to coordinate `MajikKey`, `MajikInvoice`, `MajikInvoiceContactManager`, storage adapters, signing keys, recipients, expected signers, and persistence independently, `MajikBuwizClient` provides a single orchestration layer for the complete workflow.

> **Build invoices. Track expenses. Manage identities. Keep the data under your control.**

---

- [Majik Buwiz Client](#majik-buwiz-client)
  - [Overview](#overview)
  - [Architecture](#architecture)
- [Installation](#installation)
- [Initialization](#initialization)
- [Persistence Model](#persistence-model)
- [Hydration](#hydration)
- [Account Management](#account-management)
    - [Active account](#active-account)
- [Explicit Account Selection](#explicit-account-selection)
- [Invoice Management](#invoice-management)
- [Creating an Invoice](#creating-an-invoice)
- [Finalizing an Invoice](#finalizing-an-invoice)
- [Invoice Modes](#invoice-modes)
    - [Signed-only](#signed-only)
    - [Encrypted and signed](#encrypted-and-signed)
- [Signing an Invoice](#signing-an-invoice)
- [File Signing](#file-signing)
- [Sealing an Invoice](#sealing-an-invoice)
- [Verifying Invoice Signatures](#verifying-invoice-signatures)
- [Verifying an Invoice Seal](#verifying-an-invoice-seal)
- [Invoice Validation](#invoice-validation)
- [Decrypting an Invoice](#decrypting-an-invoice)
- [Batch Decryption](#batch-decryption)
- [Checking Decryption Capability](#checking-decryption-capability)
- [Checking Signing Capability](#checking-signing-capability)
- [Checking Sealing Capability](#checking-sealing-capability)
- [Reissuing an Invoice](#reissuing-an-invoice)
- [Restarting an Invoice](#restarting-an-invoice)
- [Switching Invoice Modes](#switching-invoice-modes)
- [Reissue + Sign + Store](#reissue--sign--store)
- [Invoice Queries](#invoice-queries)
- [Invoice Filters](#invoice-filters)
    - [By active account](#by-active-account)
    - [By issue date](#by-issue-date)
    - [By creation date](#by-creation-date)
    - [By mode](#by-mode)
    - [By issuer](#by-issuer)
    - [By recipient](#by-recipient)
    - [By status](#by-status)
- [Invoice Ownership Queries](#invoice-ownership-queries)
- [Invoice Statistics](#invoice-statistics)
- [Invoice Public Information](#invoice-public-information)
- [Importing an Invoice](#importing-an-invoice)
- [Duplicate an Invoice](#duplicate-an-invoice)
- [CSV Export](#csv-export)
- [Contact Directory](#contact-directory)
- [Adding Contacts](#adding-contacts)
- [Getting Contacts](#getting-contacts)
- [Checking Contacts](#checking-contacts)
- [Listing Contacts](#listing-contacts)
- [Updating Contacts](#updating-contacts)
- [Contact Import and Export](#contact-import-and-export)
- [Compressed Contact Exchange](#compressed-contact-exchange)
- [Contact Groups](#contact-groups)
- [Listing Groups](#listing-groups)
- [Managing Group Membership](#managing-group-membership)
- [Querying Group Membership](#querying-group-membership)
- [Favorites and Blocked Contacts](#favorites-and-blocked-contacts)
- [Resolving Invoice Recipients and Signers](#resolving-invoice-recipients-and-signers)
- [Expected Signers](#expected-signers)
- [Signer Labels](#signer-labels)
- [Expense Management](#expense-management)
- [Creating an Expense](#creating-an-expense)
- [Retrieving Expenses](#retrieving-expenses)
- [Expense Queries](#expense-queries)
- [Expense Filters](#expense-filters)
- [Expense Ownership Queries](#expense-ownership-queries)
- [Duplicating Expenses](#duplicating-expenses)
- [Recurring Expenses](#recurring-expenses)
- [Application Defaults](#application-defaults)
- [Invoice Table Columns](#invoice-table-columns)
- [Expense Table Columns](#expense-table-columns)
- [User Application Preferences](#user-application-preferences)
- [Preference Helpers](#preference-helpers)
- [Audit and Activity Logs](#audit-and-activity-logs)
- [History Logs](#history-logs)
- [Activity Logs](#activity-logs)
- [Recording Activity Manually](#recording-activity-manually)
- [Clearing Logs](#clearing-logs)
- [Key Data Reset](#key-data-reset)
- [Backup and Restore](#backup-and-restore)
- [Backup Invoices](#backup-invoices)
- [Backup Expenses](#backup-expenses)
- [Backup Contacts](#backup-contacts)
- [Full Application Backup](#full-application-backup)
- [Reading a Backup Without Restoring](#reading-a-backup-without-restoring)
- [Probing Backup Type](#probing-backup-type)
- [Reading Invoice Backups](#reading-invoice-backups)
- [Restoring Invoice Backups](#restoring-invoice-backups)
- [Reading Contact Backups](#reading-contact-backups)
- [Restoring Contacts](#restoring-contacts)
- [Restoring Full Application Data](#restoring-full-application-data)
- [Selective Restore](#selective-restore)
- [Event System](#event-system)
- [Available Events](#available-events)
    - [Contact events](#contact-events)
    - [Invoice events](#invoice-events)
    - [Expense events](#expense-events)
    - [Logging events](#logging-events)
    - [Error events](#error-events)
- [Error Handling](#error-handling)
    - [Validation and account errors](#validation-and-account-errors)
    - [Domain-operation errors](#domain-operation-errors)
- [Signing-Key Requirements](#signing-key-requirements)
- [Account Identity Resolution](#account-identity-resolution)
- [In-Memory Development Mode](#in-memory-development-mode)
- [Custom Managers](#custom-managers)
- [Custom Storage Adapters](#custom-storage-adapters)
- [Typical Desktop Application Flow](#typical-desktop-application-flow)
- [Typical Invoice Workflow](#typical-invoice-workflow)
- [Typical Expense Workflow](#typical-expense-workflow)
- [Typical Backup Workflow](#typical-backup-workflow)
    - [Export](#export)
    - [Restore](#restore)
- [Security-Oriented Design](#security-oriented-design)
    - [Local key ownership](#local-key-ownership)
    - [Explicit unlocking](#explicit-unlocking)
    - [Cryptographic signing](#cryptographic-signing)
    - [Recipient-aware encryption](#recipient-aware-encryption)
    - [Integrity sealing](#integrity-sealing)
    - [Scoped logging](#scoped-logging)
    - [Backup type validation](#backup-type-validation)
- [Important Design Principles](#important-design-principles)
  - [One high-level client](#one-high-level-client)
  - [Account-aware by default](#account-aware-by-default)
  - [Explicit persistence boundaries](#explicit-persistence-boundaries)
  - [Read-before-write backups](#read-before-write-backups)
  - [Non-blocking logging](#non-blocking-logging)
  - [Domain orchestration](#domain-orchestration)
- [API Surface](#api-surface)
  - [Accounts](#accounts)
  - [Contacts](#contacts)
  - [Groups](#groups)
  - [Favorites / Blocked](#favorites--blocked)
  - [Invoice lifecycle](#invoice-lifecycle)
  - [Invoice queries](#invoice-queries-1)
  - [Invoice utilities](#invoice-utilities)
  - [Expenses](#expenses)
  - [Recurring expenses](#recurring-expenses-1)
  - [Application state](#application-state)
  - [Logging](#logging)
  - [Backups](#backups)
  - [Lifecycle](#lifecycle)
  - [Events](#events)
- [TypeScript](#typescript)
- [Related Majikah Packages](#related-majikah-packages)
- [License](#license)
- [Author](#author)
  - [About the Developer](#about-the-developer)
- [Majikah Solutions](#majikah-solutions)
- [Contact](#contact)
  - [Contributing](#contributing)
  - [Summary](#summary)


---

## Overview

`MajikBuwizClient` is designed for applications that need to manage business records while preserving the cryptographic identity model of the Majikah ecosystem.

It provides:

* **MajikKey account management** through `MajikKeyClient`
* **Multi-account support** with active-account tracking
* **Invoice creation, signing, sealing, verification, encryption, and decryption**
* **Invoice querying and filtering**
* **Invoice reissuing and mode switching**
* **Invoice ownership-aware queries**
* **Expense creation, duplication, querying, and removal**
* **Recurring expense actualization**
* **Contact directory management**
* **Contact groups, favorites, and blocked contacts**
* **Public-key/contact resolution for invoice recipients and expected signers**
* **Encrypted invoice workflows**
* **Application defaults and user preferences**
* **History/audit logs**
* **User activity logs**
* **Portable compressed application backups**
* **Selective backup inspection and restoration**
* **Pluggable persistence adapters**
* **Application event notifications**

The client is intentionally storage-agnostic. Persistent domains can be backed by IndexedDB, SQLite, filesystem-backed storage, or other implementations of the provided adapter interfaces.

---

## Architecture

At a high level, the client coordinates several domains:

```text
                         ┌─────────────────────┐
                         │  MajikBuwizClient   │
                         └──────────┬──────────┘
                                    │
            ┌───────────────────────┼────────────────────────┐
            │                       │                        │
            ▼                       ▼                        ▼
     MajikKeyClient          MajikInvoiceManager      ExpenseManager
            │                       │                        │
            │                       │                        └── RecurringExpenseManager
            │                       │
            ▼                       ▼
       MajikKey                 MajikInvoice
            │                       │
            └───────────┬───────────┘
                        │
                        ▼
             MajikInvoiceContactManager
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
          Contacts              Groups
```

Additional managers provide application state and operational history:

```text
ClientStateManager
HistoryLogManager
UserActivityLogManager
```

Each domain can have its own storage adapter.

There is no requirement for a single monolithic application-state blob.

---

# Installation

```bash
npm install @majikah/majik-buwiz-client
```

The client is designed to work with the Majikah package ecosystem, including:

```text
@majikah/majik-key
@majikah/majik-key-client
@majikah/majik-envelope
@majikah/majik-invoice
@majikah/majik-signature
@majikah/majik-cjson
@majikah/majik-file
```

---

# Initialization

The recommended initialization path is `MajikBuwizClient.create()`.

`create()` constructs the client and immediately hydrates all configured domains.

```typescript
import { MajikBuwizClient } from "@majikah/majik-buwiz-client";

const client = await MajikBuwizClient.create({
  adapters: {
    // Provide your persistent adapters here.
    // clientState, keys, contacts, invoices, expenses, etc.
  },
});
```

You can also instantiate the client directly and hydrate it manually:

```typescript
const client = new MajikBuwizClient({
  adapters: {
    // persistent adapters
  },
});

await client.hydrate();
```

The two patterns are equivalent:

```typescript
const client = await MajikBuwizClient.create(config);
```

is effectively:

```typescript
const client = new MajikBuwizClient(config);
await client.hydrate();
```

---

# Persistence Model

`MajikBuwizClient` uses a **domain-oriented persistence model**.

Instead of saving the entire client into one large application object, each domain owns its own storage adapter.

Typical domains include:

```text
Keys
Client state
Contacts
Invoices
Expenses
Recurring expenses
History logs
User activity logs
```

This makes it possible to use different persistence mechanisms for different data sets.

For example:

```typescript
const client = await MajikBuwizClient.create({
  adapters: {
    keys: myKeyAdapter,
    clientState: myClientStateAdapter,
    contacts: myContactsAdapter,
    invoices: myInvoiceAdapter,
    expenses: myExpenseAdapter,
    recurringExpenses: myRecurringExpenseAdapter,
    historyLogs: myHistoryAdapter,
    userActivityLogs: myActivityAdapter,
  },
});
```

When a domain-specific manager is not supplied, the client creates a manager using the corresponding configured adapter.

For development and testing, the client can therefore operate with in-memory storage.

---

# Hydration

Call `hydrate()` once when restoring application state from persistent storage.

Hydration occurs in an intentional order:

```text
Keys
  ↓
Contacts
  ↓
Invoices
  ↓
Expenses
  ↓
Recurring Expenses
  ↓
History Logs
  ↓
Activity Logs
  ↓
Client State
  ↓
Owned Accounts
  ↓
Account Order
```

This is important because account registration synchronizes owned identities into the contact directory.

```typescript
await client.hydrate();
```

For most applications, prefer:

```typescript
const client = await MajikBuwizClient.create(config);
```

---

# Account Management

Because `MajikBuwizClient` extends `MajikKeyClient`, it inherits the underlying MajikKey account lifecycle and active-account functionality.

This includes concepts such as:

* Multiple owned accounts
* Account creation/import
* Lock and unlock states
* Active account selection
* Account key management
* Account ordering
* Identity lookup

MajikBuwiz adds business-specific synchronization between owned accounts and its contact directory.

For example, when an owned account is registered, a corresponding contact representation is automatically added to the shared directory.

### Active account

Many operations default to the active account:

```typescript
client.setActiveAccount(accountId);
```

Operations that require a signing identity will fail when no suitable account is available.

For example:

```typescript
await client.finalizeInvoice(
  draft,
  "signed-only",
  [],
);
```

uses the active account unless an explicit `accountId` is provided.

---

# Explicit Account Selection

Operations can generally target a specific account using `accountId`.

```typescript
await client.signInvoice(invoice, {
  accountId: "account-id",
});
```

This is particularly useful for applications that operate several businesses, brands, legal entities, or signing identities from the same installation.

---

# Invoice Management

`MajikBuwizClient` provides the complete high-level invoice lifecycle.

Core operations include:

```text
Create
Store
Sign
Seal
Decrypt
Verify
Validate
Duplicate
Reissue
Restart
Switch mode
Query
Export
Backup
Restore
```

---

# Creating an Invoice

For low-level invoice creation:

```typescript
const invoice = await client.createInvoice(
  {
    // MajikInvoiceInput fields
    // except signerKey and recipients
    ...
  },
  {
    recipientContacts: contacts,
    expectedSigners,
  },
);
```

The client resolves the signing account automatically.

For application-level invoice finalization, `finalizeInvoice()` is usually more convenient.

---

# Finalizing an Invoice

`finalizeInvoice()` provides the full application workflow:

```text
GeneralInvoice
      ↓
Resolve signer
      ↓
Resolve contacts
      ↓
Build recipients
      ↓
Build expected signers
      ↓
Create MajikInvoice
      ↓
Sign
      ↓
Persist
      ↓
Increment invoice number
```

Example:

```typescript
const invoice = await client.finalizeInvoice(
  draft,
  "signed-only",
  [],
);
```

For encrypted invoices:

```typescript
const invoice = await client.finalizeInvoice(
  draft,
  "encrypted-and-signed",
  [
    customerContact.id,
  ],
);
```

Encrypted-and-signed invoices require at least one recipient contact.

You can also explicitly select the signing account and invoice status:

```typescript
const invoice = await client.finalizeInvoice(
  draft,
  "encrypted-and-signed",
  [customerContact.id],
  {
    accountId: accountId,
    status: "issued",
  },
);
```

---

# Invoice Modes

MajikBuwiz supports the invoice modes provided by `MajikInvoice`.

The client explicitly handles:

```text
signed-only
encrypted-and-signed
```

### Signed-only

The invoice is cryptographically signed without encrypting the invoice payload for recipients.

```typescript
await client.finalizeInvoice(
  draft,
  "signed-only",
  [],
);
```

### Encrypted and signed

The invoice is encrypted for resolved recipients and signed by the issuing account.

```typescript
await client.finalizeInvoice(
  draft,
  "encrypted-and-signed",
  [recipientContactId],
);
```

---

# Signing an Invoice

Sign an existing invoice by ID:

```typescript
const signed = await client.signInvoice(invoiceId);
```

Or pass an invoice instance:

```typescript
const signed = await client.signInvoice(invoice);
```

An explicit account can be selected:

```typescript
const signed = await client.signInvoice(invoice, {
  accountId,
});
```

You can also provide an explicit signing timestamp:

```typescript
const signed = await client.signInvoice(invoice, {
  timestamp: new Date().toISOString(),
});
```

Expected signers can also be supplied:

```typescript
const signed = await client.signInvoice(invoice, {
  expectedSigners,
});
```

---

# File Signing

The client also exposes file signing through `MajikSignature`.

```typescript
const result = await client.signFile(fileBlob, {
  contentType: "application/pdf",
});

console.log(result.blob);
console.log(result.signature);
console.log(result.handler);
console.log(result.mimeType);
```

The implementation delegates file signing to `MajikSignature.signFile()`.

The active account is automatically unlocked when needed.

A specific account can also be selected:

```typescript
const result = await client.signFile(fileBlob, {
  accountId,
  contentType: "application/pdf",
});
```

Expected signers can be attached to the operation:

```typescript
const result = await client.signFile(fileBlob, {
  expectedSigners,
});
```

---

# Sealing an Invoice

A signed invoice can be sealed to establish a final integrity state.

```typescript
const sealed = await client.sealInvoice(invoice);
```

The operation can also target an explicit account:

```typescript
const sealed = await client.sealInvoice(invoice, {
  accountId,
});
```

Seal information can later be retrieved:

```typescript
const sealInfo = await client.getInvoiceSealInfo(invoice.id);
```

---

# Verifying Invoice Signatures

Verify all invoice signatures:

```typescript
const results = await client.verifyInvoiceSignatures(invoice);
```

Verify the signature of one signer:

```typescript
const result = await client.verifyInvoiceSignature(
  invoice,
  signerId,
);
```

Verification results are returned from the underlying `MajikInvoice` instance.

---

# Verifying an Invoice Seal

```typescript
const result = await client.verifyInvoiceSeal(invoice);
```

This verifies the invoice's seal state independently from signature verification.

---

# Invoice Validation

Run invoice validation using the stored invoice:

```typescript
const result = await client.validateInvoice(invoice.id);

console.log(result);
```

The method resolves the invoice and delegates validation to `MajikInvoice`.

---

# Decrypting an Invoice

Decrypt a single invoice:

```typescript
const result = await client.decryptInvoice(invoice);
```

The returned result contains both the decrypted invoice and the updated invoice instance.

```typescript
console.log(result.invoice);
console.log(result.instance);
```

The updated instance is saved back into the invoice manager.

---

# Batch Decryption

Decrypt every cached invoice accessible by an account:

```typescript
const result = await client.decryptCachedInvoices();

console.log(result);
```

Or target a specific account:

```typescript
const result = await client.decryptCachedInvoices(accountId);
```

You can also decrypt an explicitly supplied list:

```typescript
const result = await client.decryptInvoices(
  invoices,
  accountId,
);
```

Successful decrypted instances are written back to the invoice store.

---

# Checking Decryption Capability

Before attempting decryption:

```typescript
const canDecrypt = await client.canDecryptInvoice(
  invoice,
  accountId,
);

if (canDecrypt) {
  // safe to offer decrypt action
}
```

Returns `false` when the invoice, account, or key is unavailable.

---

# Checking Signing Capability

Use `canSignInvoice()` to determine whether an account can sign an invoice.

```typescript
const result = await client.canSignInvoice(
  invoice,
  accountId,
);

if (!result.permitted) {
  console.log(result.reason);
}
```

The method also prevents signing an invoice that the same account has already signed.

---

# Checking Sealing Capability

```typescript
const result = await client.canSealInvoice(
  invoice,
  accountId,
);

if (!result.permitted) {
  console.log(result.reason);
}
```

---

# Reissuing an Invoice

Reissue an invoice with an updated `GeneralInvoice` representation.

```typescript
const reissued = await client.reissueInvoice(
  invoice,
  updatedInvoice,
  {
    recipientContactIds: [
      customerContact.id,
    ],
  },
);
```

The client automatically resolves:

* Recipients
* Public keys
* Expected signers
* Signing identity

For encrypted invoices, the updated invoice cache is refreshed so consumers do not immediately need to perform another decryption pass.

---

# Restarting an Invoice

`restartInvoice()` creates a new invoice lineage from an existing invoice.

```typescript
const restarted = await client.restartInvoice(invoice);
```

The implementation handles encrypted invoices specially so the restarted invoice can continue through the appropriate signed/encrypted workflow.

---

# Switching Invoice Modes

Switch a finalized invoice between:

```text
signed-only
encrypted-and-signed
```

Example:

```typescript
const updated = await client.switchInvoiceMode(
  invoice,
  "encrypted-and-signed",
  [customerContact.id],
);
```

Switching back:

```typescript
const updated = await client.switchInvoiceMode(
  invoice,
  "signed-only",
);
```

Signatures can optionally be dropped and replaced during the operation:

```typescript
const updated = await client.switchInvoiceMode(
  invoice,
  "signed-only",
  [],
  {
    dropSignatures: true,
  },
);
```

When switching into encrypted-and-signed mode, at least one recipient is required.

---

# Reissue + Sign + Store

For application interfaces such as invoice editors, `reissueSignAndStore()` provides the complete update pipeline.

```typescript
const updated = await client.reissueSignAndStore(
  invoice,
  updatedDraft,
  recipientContactIds,
);
```

This method:

1. Resolves the signing account.
2. Resolves recipient contacts.
3. Resolves expected signers.
4. Reissues the invoice.
5. Signs the reissued invoice.
6. Refreshes decrypted cache data when needed.
7. Stores the result.
8. Emits `invoice-updated`.

This is useful when an application wants one high-level method for "save changes".

---

# Invoice Queries

Retrieve one invoice:

```typescript
const invoice = await client.getInvoice(invoiceId);
```

Throw when missing:

```typescript
const invoice = await client.getInvoiceOrThrow(invoiceId);
```

List invoices:

```typescript
const invoices = client.listInvoices();
```

Query with options:

```typescript
const result = client.queryInvoices({
  sortBy: "createdAt",
  sortDir: "desc",
});
```

Advanced querying:

```typescript
const result = await client.queryInvoicesAdvanced({
  ...
});
```

---

# Invoice Filters

Convenience methods are provided for frequently used queries.

### By active account

```typescript
const invoices =
  await client.listInvoicesByActiveAccount();
```

### By issue date

```typescript
const invoices =
  await client.listInvoicesByIssuedAtRange({
    from: startDate,
    to: endDate,
  });
```

### By creation date

```typescript
const invoices =
  await client.listInvoicesByCreatedAtRange({
    from: startDate,
    to: endDate,
  });
```

### By mode

```typescript
const invoices =
  await client.listInvoicesByMode("signed-only");
```

### By issuer

```typescript
const invoices =
  client.listInvoicesByIssuer("Acme Corporation");
```

### By recipient

```typescript
const invoices =
  client.listInvoicesByRecipient("Customer Name");
```

### By status

```typescript
const invoices =
  client.listInvoicesByStatus("paid");
```

Multiple statuses can be supplied:

```typescript
const invoices =
  client.listInvoicesByStatus([
    "issued",
    "sent",
  ]);
```

---

# Invoice Ownership Queries

A local store can contain invoices belonging to more than one account.

Use:

```typescript
const foreignInvoices =
  await client.getInvoicesNotOwnedByActiveAccount();
```

For a lightweight count:

```typescript
const count =
  await client.countInvoicesNotOwnedByActiveAccount();
```

When backed by a SQL-based storage adapter, the count operation can be performed at the database level without loading every invoice.

---

# Invoice Statistics

```typescript
const stats = client.getInvoiceStats();
```

Returns:

```typescript
{
  total: number;
  draft: number;
  issued: number;
  paid: number;
  overdue: number;
  void: number;
}
```

The `issued` count includes invoices with status:

```text
issued
sent
```

---

# Invoice Public Information

Retrieve the public invoice summary:

```typescript
const summary =
  await client.getInvoicePublicSummary(invoice.id);
```

Retrieve seal information:

```typescript
const sealInfo =
  await client.getInvoiceSealInfo(invoice.id);
```

---

# Importing an Invoice

Import from JSON:

```typescript
const invoice = client.importInvoice(json);
```

The JSON may be either a serialized JSON string or a `MajikInvoiceJSON` object.

---

# Duplicate an Invoice

```typescript
const duplicated =
  await client.duplicateInvoice(invoice);
```

A specific account/key may be supplied:

```typescript
const duplicated =
  await client.duplicateInvoice(invoice, {
    account: accountId,
  });
```

---

# CSV Export

Export multiple invoices to CSV:

```typescript
const result =
  await client.batchExportInvoicesToCSV(invoices);
```

Custom columns:

```typescript
const result =
  await client.batchExportInvoicesToCSV(
    invoices,
    {
      columns,
    },
  );
```

A decryption key is resolved automatically from the selected account.

---

# Contact Directory

`MajikBuwizClient` exposes the shared contact directory through high-level convenience methods.

Contacts can be:

```text
Added
Removed
Updated
Imported
Exported
Compressed
Resolved by ID
Resolved by public key
Grouped
Favorited
Blocked
```

---

# Adding Contacts

```typescript
await client.addContact(contact);
```

Adding a contact also records a user activity entry and emits:

```text
new-contact
```

---

# Getting Contacts

By ID:

```typescript
const contact =
  client.getContactByID(contactId);
```

By address:

```typescript
const contact =
  await client.getContactByAddress(publicKeyAddress);
```

By public key:

```typescript
const contact =
  await client.getContactByPublicKey(publicKeyBase64);
```

Multiple IDs:

```typescript
const contacts =
  client.getContactsByID(ids);
```

Multiple public keys:

```typescript
const contacts =
  await client.getContactsByPublicKey(publicKeys);
```

---

# Checking Contacts

```typescript
const exists =
  client.hasContact(contactId);
```

Or by public-key address:

```typescript
const exists =
  await client.hasContactByAddress(address);
```

---

# Listing Contacts

By default, owned accounts are excluded from `listContacts()`.

```typescript
const contacts = client.listContacts();
```

Include owned accounts:

```typescript
const contacts =
  client.listContacts(true);
```

Restrict to Majikah contacts:

```typescript
const contacts =
  client.listContacts(false, true);
```

---

# Updating Contacts

```typescript
await client.updateContactMeta(
  contactId,
  {
    label: "Main Customer",
  },
);
```

Owned account metadata can also be updated:

```typescript
await client.updateOwnAccountMeta(
  accountId,
  {
    label: "Business Account",
  },
);
```

The active account has a dedicated helper:

```typescript
await client.updateActiveAccountMeta({
  label: "My Business",
});
```

---

# Contact Import and Export

Export JSON:

```typescript
const json =
  await client.exportContactAsJSON(contactId);
```

Export the manager's string representation:

```typescript
const encoded =
  await client.exportContactAsString(contactId);
```

Import JSON:

```typescript
await client.importContactFromJSON(json);
```

Import encoded contact data:

```typescript
await client.importContactFromString(encoded);
```

---

# Compressed Contact Exchange

Contacts can also be exchanged using a compressed base64 representation.

Export:

```typescript
const compressed =
  await client.exportContactCompressed(contact);
```

Import:

```typescript
const imported =
  await client.importContactCompressed(compressed);
```

This is useful for compact contact-card sharing.

---

# Contact Groups

Create a group:

```typescript
const group = await client.createGroup(
  "customers",
  "Customers",
);
```

Add an existing group:

```typescript
await client.addGroup(group);
```

Get a group:

```typescript
const group =
  client.getContactGroup("customers");
```

Get-or-throw:

```typescript
const group =
  client.getGroupOrThrow("customers");
```

Check existence:

```typescript
const exists =
  client.hasGroup("customers");
```

---

# Listing Groups

List all groups:

```typescript
const groups =
  client.listContactGroups();
```

List only user-created groups:

```typescript
const groups =
  client.listUserGroups();
```

List system-managed groups:

```typescript
const groups =
  client.listSystemGroups();
```

Groups can optionally be sorted by name:

```typescript
const groups =
  client.listContactGroups(true, true);
```

---

# Managing Group Membership

Add one contact:

```typescript
await client.addContactToGroup(
  groupId,
  contactId,
);
```

Add multiple contacts:

```typescript
await client.addContactsToGroup(
  groupId,
  contactIds,
);
```

Remove a contact:

```typescript
await client.removeContactFromGroup(
  groupId,
  contactId,
);
```

Move a contact between groups:

```typescript
await client.moveContactBetweenGroups(
  contactId,
  fromGroupId,
  toGroupId,
);
```

---

# Querying Group Membership

Get contacts:

```typescript
const contacts =
  client.getContactsInGroup(groupId);
```

Sorted:

```typescript
const contacts =
  client.getContactsInGroupSorted(groupId);
```

Check membership:

```typescript
const included =
  client.isContactInGroup(
    groupId,
    contactId,
  );
```

Get groups for a contact:

```typescript
const groups =
  client.getGroupsForContact(contactId);
```

Or only their IDs:

```typescript
const groupIds =
  client.getGroupIdsForContact(contactId);
```

---

# Favorites and Blocked Contacts

The contact directory includes built-in system groups for:

```text
Favorites
Blocked
```

Add to favorites:

```typescript
await client.addContactToFavorites(contactId);
```

Remove from favorites:

```typescript
await client.removeContactFromFavorites(contactId);
```

Check favorite state:

```typescript
const favorite =
  client.isContactFavorite(contactId);
```

Check blocked state:

```typescript
const blocked =
  client.isContactBlocked(contactId);
```

Retrieve the built-in groups:

```typescript
const favorites =
  client.getFavoritesGroup();

const blocked =
  client.getBlockedGroup();
```

Retrieve contacts:

```typescript
const favoriteContacts =
  client.getFavoriteContacts();

const blockedContacts =
  client.getBlockedContacts();
```

System groups are protected from being overwritten by backup restoration.

---

# Resolving Invoice Recipients and Signers

The client can convert contacts into structures required by `MajikInvoice` and `MajikSignature`.

By public key:

```typescript
const recipients =
  await client.getMajikRecipientsByPublicKey(
    publicKeys,
  );

const signers =
  await client.getExpectedSignersByPublicKey(
    publicKeys,
  );
```

By contact ID:

```typescript
const recipients =
  await client.getMajikRecipientsByIDs(
    contactIds,
  );

const signers =
  await client.getExpectedSignersByIDs(
    contactIds,
  );
```

For workflows requiring all resolved data:

```typescript
const data =
  await client.getMajikahInvoiceDataByID(
    contactIds,
  );
```

The returned structure contains:

```typescript
{
  recipients: MajikRecipient[];
  signers: ExpectedSigner[];
  publicKeys: MajikMessagePublicKey[];
}
```

A public-key version is also available:

```typescript
const data =
  await client.getMajikahInvoiceDataByPublicKey(
    publicKeys,
  );
```

---

# Expected Signers

Create an expected signer directly from a `MajikKey`:

```typescript
const signer =
  MajikBuwizClient.expectedSignerFromKey(key);
```

Or resolve an expected signer from a contact:

```typescript
const signer =
  client.expectedSignerFromContact(contactId);
```

The contact must contain the signing public-key material required by the signature system.

---

# Signer Labels

Resolve a human-readable signer label:

```typescript
const label =
  client.resolveSignerLabel(signerId);
```

The client checks:

1. Owned accounts
2. Shared contact directory
3. Fallback truncated identifier

This is useful for UI rendering of signer histories and verification results.

---

# Expense Management

Majik Buwiz also provides a complete expense domain alongside invoices.

Core operations include:

```text
Create
Store
Retrieve
Duplicate
Query
Filter
Remove
Actualize recurring expenses
Backup
Restore
```

---

# Creating an Expense

```typescript
const expense = await client.createExpense({
  // ExpenseRecordInput
  ...
});
```

The expense is associated with the selected account's fingerprint.

An explicit account can be used:

```typescript
const expense = await client.createExpense(
  input,
  {
    accountId,
  },
);
```

To create without immediately storing it:

```typescript
const expense = await client.createExpense(
  input,
  {
    skipStore: true,
  },
);
```

---

# Retrieving Expenses

```typescript
const expense =
  await client.getExpense(expenseId);
```

Or throw when missing:

```typescript
const expense =
  await client.getExpenseOrThrow(expenseId);
```

List expenses:

```typescript
const expenses =
  client.listExpenses();
```

---

# Expense Queries

Basic queries:

```typescript
const result =
  client.queryExpenses({
    ...
  });
```

Advanced queries:

```typescript
const result =
  await client.queryExpensesAdvanced({
    ...
  });
```

---

# Expense Filters

By active account:

```typescript
const expenses =
  await client.listExpensesByActiveAccount();
```

By creation date:

```typescript
const expenses =
  await client.listExpensesByCreatedAtRange({
    from: startDate,
    to: endDate,
  });
```

By category:

```typescript
const expenses =
  await client.listExpensesByCategory(category);
```

By status:

```typescript
const expenses =
  client.listExpensesByStatus("...");
```

---

# Expense Ownership Queries

List expenses belonging to other accounts:

```typescript
const expenses =
  await client.getExpensesNotOwnedByActiveAccount();
```

Get only the count:

```typescript
const count =
  await client.countExpensesNotOwnedByActiveAccount();
```

This is useful for multi-account dashboards where the current account should only display its own business records.

---

# Duplicating Expenses

```typescript
const duplicate =
  await client.duplicateExpense(expense);
```

A different account/key can be selected:

```typescript
const duplicate =
  await client.duplicateExpense(
    expense,
    {
      account: accountId,
    },
  );
```

---

# Recurring Expenses

Recurring expense definitions can be actualized into normal expense records.

Actualize one item:

```typescript
const result =
  await client.actualizeRecurringExpense(
    recurringExpenseId,
  );
```

With options:

```typescript
const result =
  await client.actualizeRecurringExpense(
    recurringExpenseId,
    {
      ...
    },
  );
```

Actualize all recurring expenses:

```typescript
const results =
  await client.actualizeAllRecurringExpenses();
```

The client automatically coordinates the recurring expense manager and expense manager so duplicate actualizations can be prevented.

---

# Application Defaults

Invoice defaults are persisted through `ClientStateManager`.

Retrieve:

```typescript
const defaults =
  await client.getInvoiceDefaults();
```

Save:

```typescript
await client.setInvoiceDefaults({
  ...
});
```

Remove:

```typescript
await client.removeInvoiceDefaults();
```

These defaults are intended to help application interfaces pre-fill invoice creation forms. The client does not automatically inject them into every newly created invoice.

---

# Invoice Table Columns

Persist invoice table configuration:

```typescript
const columns =
  await client.getInvoiceTableColumns();
```

Save:

```typescript
await client.setInvoiceTableColumns(
  columns,
);
```

Reset:

```typescript
await client.resetInvoiceTableColumns();
```

---

# Expense Table Columns

Retrieve:

```typescript
const columns =
  await client.getExpenseTableColumns();
```

Save:

```typescript
await client.setExpenseTableColumns(
  columns,
);
```

Reset:

```typescript
await client.resetExpenseTableColumns();
```

---

# User Application Preferences

Retrieve preferences:

```typescript
const preferences =
  await client.getUserAppPreferences();
```

Persist preferences:

```typescript
await client.setUserAppPreferences(
  preferences,
);
```

Remove preferences:

```typescript
await client.removeUserAppPreferences();
```

Reset to defaults:

```typescript
await client.resetUserAppPreferences();
```

---

# Preference Helpers

Analytics preference:

```typescript
const enabled =
  await client.isAnalyticsEnabled();
```

Auto-decryption preference:

```typescript
const enabled =
  await client.isAutoDecryptInvoicesEnabled();
```

---

# Audit and Activity Logs

Majik Buwiz separates operational logging into two concepts:

```text
History logs
User activity logs
```

The managers are exposed directly:

```typescript
const history =
  client.historyManager;

const activity =
  client.activityManager;
```

---

# History Logs

History records are designed for persisted operational history.

Retrieve history for the active account:

```typescript
const logs =
  client.listHistoryForActiveAccount();
```

History recording is deliberately non-blocking from the perspective of the primary business operation.

A failure to record a history entry does not fail the invoice or account operation it accompanies.

History retention respects the user's configured history limit.

---

# Activity Logs

Retrieve activity for the active account:

```typescript
const logs =
  client.listActivityForActiveAccount();
```

Activity recording is also non-blocking.

The client maintains a hard limit of **5,000 activity records per fingerprint** and removes the oldest records when the limit is exceeded.

---

# Recording Activity Manually

Applications can record their own activity:

```typescript
await client.recordActivity(
  accountFingerprint,
  {
    reference_id: "invoice-123",
    action: "...",
    metadata: {
      ...
    },
  },
);
```

The method returns either the created log entry or `null`.

---

# Clearing Logs

Clear the active account's history:

```typescript
await client.clearHistoryLogsForActiveAccount();
```

Clear activity:

```typescript
await client.clearActivityLogsForActiveAccount();
```

Clear both and start a new activity trail:

```typescript
await client.restartLogsForActiveAccount();
```

Log hydration for an unlocked active account is also available:

```typescript
await client.hydrateLogsForActiveAccount();
```

---

# Key Data Reset

When key-derived application data is reset, the client clears:

```text
Contacts
Invoices
Expenses
Recurring expenses
```

History and activity logs are intentionally preserved.

This makes it possible to retain an audit trail across a cryptographic/account data reset.

---

# Backup and Restore

MajikBuwiz supports portable backups for individual domains as well as application-wide state.

Backup payloads are:

1. Serialized
2. Compressed using `MajikCompressedJSON`
3. Prefixed with a domain-specific magic-byte header

The magic header allows the client to identify the backup type before attempting full parsing.

Supported backup domains include:

```text
Invoices
Expenses
Contacts
Application data
```

---

# Backup Invoices

```typescript
const blob =
  client.backupInvoices();
```

---

# Backup Expenses

```typescript
const blob =
  client.backupExpenses();
```

---

# Backup Contacts

```typescript
const blob =
  await client.backupContacts();
```

Contact backups include the contact directory and user-defined groups.

Built-in system groups such as Favorites and Blocked are handled as system-managed data and are not treated as ordinary user groups during restore.

---

# Full Application Backup

```typescript
const blob =
  await client.backupAppData();
```

The application backup can contain:

```text
Contacts
Contact groups
Invoices
Expenses
Invoice defaults
User application preferences
```

---

# Reading a Backup Without Restoring

A major design goal of the backup system is to separate **inspection** from **mutation**.

For example:

```typescript
const snapshot =
  await client.readAppDataBackup(blob);
```

Nothing is written to the live store.

This allows a UI to:

* Inspect a backup
* Show record counts
* Preview data
* Ask the user what should be restored
* Perform a selective restore

---

# Probing Backup Type

Before fully parsing a backup:

```typescript
const type =
  await MajikBuwizClient.probeBackupType(blob);
```

Possible results are:

```text
"invoices"
"contacts"
"expenses"
"appData"
"unknown"
```

This is useful for validating files selected through a file picker.

---

# Reading Invoice Backups

```typescript
const invoices =
  await client.readInvoicesBackup(blob);
```

This parses the backup but does not write invoices to the store.

---

# Restoring Invoice Backups

```typescript
const result =
  await client.restoreInvoices(blob);

console.log(result.restored);
```

---

# Reading Contact Backups

```typescript
const snapshot =
  await client.readContactsBackup(blob);
```

The returned snapshot contains hydrated contact and group instances as well as the underlying manager representation used by the restore pipeline.

---

# Restoring Contacts

```typescript
const result =
  await client.restoreContacts(blob);
```

Options are available:

```typescript
const result =
  await client.restoreContacts(
    blob,
    {
      overwriteContacts: false,
      includeGroups: true,
    },
  );
```

When `overwriteContacts` is `false`, existing matching contacts are left untouched.

System-managed groups are never overwritten.

---

# Restoring Full Application Data

For a complete restore:

```typescript
const result =
  await client.restoreAppData(blob);

console.log(result);
/*
{
  contacts: number;
  groups: number;
  invoices: number;
}
*/
```

Contacts and groups are restored before invoices so contact references can be resolved correctly.

---

# Selective Restore

Applications can inspect the backup first:

```typescript
const snapshot =
  await client.readAppDataBackup(blob);
```

Then restore only selected domains:

```typescript
const result =
  await client.restoreAppDataSelective(
    snapshot,
    {
      invoices: true,
      expenses: true,
      contacts: false,
      groups: false,
      invoiceDefaults: true,
      preferences: false,
    },
  );
```

This is useful for restore/merge interfaces where the user should be able to choose exactly which parts of a backup are imported.

---

# Event System

`MajikBuwizClient` exposes an event system for application integration.

Register a listener:

```typescript
client.on(
  "invoice-created",
  (invoice) => {
    console.log("Invoice created", invoice);
  },
);
```

Remove a listener:

```typescript
client.off(
  "invoice-created",
  callback,
);
```

Remove all listeners for an event:

```typescript
client.off("invoice-created");
```

---

# Available Events

The client exposes the following domain events in addition to events inherited from `MajikKeyClient`:

### Contact events

```text
new-contact
updated-contact
removed-contact

new-contact-group
removed-contact-group
contact-group-change
```

### Invoice events

```text
invoice-created
invoice-updated
invoice-removed
invoice-signed
invoice-sealed
invoice-verified
invoice-decrypted
invoice-reissued
invoice-decrypted-batch
invoice-export-csv
invoice-export-pdf
invoice-export-mjki
invoice-clear
```

### Expense events

```text
expense-created
expense-updated
expense-removed
expense-actualized
expense-clear
```

### Logging events

```text
history-log
activity-log
```

### Error events

The client also uses the inherited error event mechanism when an operation fails.

Example:

```typescript
client.on(
  "error",
  (error, context) => {
    console.error(
      "Majik Buwiz error",
      error,
      context,
    );
  },
);
```

---

# Error Handling

High-level client methods generally follow one of two patterns.

### Validation and account errors

Operations requiring an account, key, or valid identifier may throw immediately.

For example:

```typescript
await client.signInvoice(invoice);
```

can fail when no active account exists or when the resolved account cannot sign.

### Domain-operation errors

Invoice operations catch failures, emit an error event, and rethrow the original error.

Example:

```typescript
try {
  await client.signInvoice(invoice);
} catch (error) {
  console.error(error);
}
```

This means applications can handle errors normally while also subscribing to the central client event stream.

---

# Signing-Key Requirements

Signing operations require an account with the necessary signing key material.

When a selected account has no signing keys, the client reports that the account needs to be re-imported using the appropriate MajikKey backup/import workflow.

Locked accounts must also be unlocked before signing.

For example:

```typescript
await client.setActiveAccount(accountId);

await client.unlockAccount(accountId);

await client.signInvoice(invoice);
```

---

# Account Identity Resolution

The client differentiates between:

```text
Account ID
Fingerprint
Public-key address
Public key
MajikKey instance
```

High-level methods resolve these internally wherever possible.

For example:

```typescript
await client.getContactByAddress(address);
```

or:

```typescript
await client.getInvoice(
  invoiceId,
);
```

The caller does not need to manually locate the corresponding manager.

---

# In-Memory Development Mode

Every major domain can operate without persistent storage.

This makes the client useful for:

```text
Unit tests
Integration tests
Prototypes
Storybook environments
Temporary sessions
CLI utilities
```

For example:

```typescript
const client = new MajikBuwizClient({});
```

or:

```typescript
const client =
  await MajikBuwizClient.create({});
```

The default managers use in-memory adapters where applicable.

---

# Custom Managers

Advanced applications can inject fully configured managers rather than relying on automatic construction.

```typescript
const client =
  new MajikBuwizClient({
    contactManager,
    invoiceManager,
    expenseManager,
    recurringExpenseManager,
    historyManager,
    activityManager,
  });
```

This allows applications to customize the lower layers while retaining the high-level orchestration API.

---

# Custom Storage Adapters

Storage adapters can be injected independently:

```typescript
const client =
  new MajikBuwizClient({
    adapters: {
      contacts: contactAdapter,
      invoices: invoiceAdapter,
      expenses: expenseAdapter,
      recurringExpenses: recurringExpenseAdapter,
      historyLogs: historyAdapter,
      userActivityLogs: activityAdapter,
    },
  });
```

This architecture allows Majik Buwiz applications to choose storage based on platform requirements rather than forcing a single persistence implementation.

---

# Typical Desktop Application Flow

A desktop application can follow this lifecycle:

```typescript
import { MajikBuwizClient } from "@majikah/majik-buwiz-client";

async function bootstrap() {
  const client =
    await MajikBuwizClient.create({
      adapters: {
        // persistent adapters
      },
    });

  const accounts =
    client.listOwnAccounts();

  if (accounts.length > 0) {
    client.setActiveAccount(accounts[0].id);
  }

  return client;
}
```

After initialization, application panels can operate entirely through the client:

```typescript
const invoices =
  client.listInvoices();

const expenses =
  client.listExpenses();

const contacts =
  client.listContacts();

const stats =
  client.getInvoiceStats();
```

---

# Typical Invoice Workflow

A complete UI workflow can look like this:

```typescript
// 1. Load or select active account
client.setActiveAccount(accountId);

// 2. Ensure account is unlocked
await client.unlockAccount(accountId);

// 3. Resolve contacts from the directory
const customer =
  client.getContactByID(customerContactId);

// 4. Finalize the invoice
const invoice =
  await client.finalizeInvoice(
    draft,
    "encrypted-and-signed",
    customer ? [customer.id] : [],
  );

// 5. Verify
const signatures =
  await client.verifyInvoiceSignatures(invoice);

// 6. Optionally seal
const sealed =
  await client.sealInvoice(invoice);
```

The application layer therefore does not need to manually construct:

```text
MajikRecipient[]
ExpectedSigner[]
signerKey
MajikInvoice
storage writes
invoice numbering
```

for the common workflow.

---

# Typical Expense Workflow

```typescript
const expense =
  await client.createExpense({
    ...
  });

const currentExpenses =
  await client.listExpensesByActiveAccount();

const monthlyExpenses =
  await client.listExpensesByCreatedAtRange({
    from: startDate,
    to: endDate,
  });
```

Recurring expenses can then be actualized:

```typescript
await client.actualizeAllRecurringExpenses();
```

---

# Typical Backup Workflow

A backup UI can be implemented in two phases.

### Export

```typescript
const backup =
  await client.backupAppData();
```

Save the returned `Blob` using the platform's file APIs.

### Restore

First inspect:

```typescript
const snapshot =
  await client.readAppDataBackup(
    backupBlob,
  );
```

Then selectively restore:

```typescript
await client.restoreAppDataSelective(
  snapshot,
  {
    contacts: true,
    groups: true,
    invoices: true,
    expenses: true,
    invoiceDefaults: true,
    preferences: true,
  },
);
```

This avoids forcing every restore operation to be all-or-nothing.

---

# Security-Oriented Design

`MajikBuwizClient` is designed to preserve the security boundaries established by the underlying Majikah cryptographic packages.

Important characteristics include:

### Local key ownership

Signing operations resolve `MajikKey` instances from the local key manager.

### Explicit unlocking

Operations requiring protected key material validate account/key availability and lock state.

### Cryptographic signing

Invoices are signed through the underlying `MajikInvoice` / `MajikSignature` implementations rather than relying on application-level identifiers alone.

### Recipient-aware encryption

Encrypted invoices resolve recipient cryptographic material from the contact directory.

### Integrity sealing

Invoice seals provide an additional integrity state for finalized records.

### Scoped logging

History and activity entries can be associated with the fingerprint of the account that actually performed the operation.

### Backup type validation

Backup blobs contain domain-specific magic headers so arbitrary binary input can be rejected before attempting to parse it as a supported backup type.

---

# Important Design Principles

`MajikBuwizClient` follows several architectural principles.

## One high-level client

Application code should not need to coordinate every Majikah manager directly for common business workflows.

## Account-aware by default

Operations use the active account unless another account is explicitly supplied.

## Explicit persistence boundaries

Invoices, contacts, expenses, recurring expenses, client state, and logs are independently persisted.

## Read-before-write backups

Backup contents can be parsed into snapshots before anything is written to the active store.

## Non-blocking logging

History and activity logging failures do not intentionally interrupt the primary business operation.

## Domain orchestration

The client translates application-level concepts such as:

```text
recipient contact IDs
signer contact IDs
account IDs
invoice drafts
```

into the cryptographic/domain structures required by the underlying Majikah libraries.

---

# API Surface

The following is a condensed view of the primary public API.

## Accounts

```text
Inherited MajikKeyClient account APIs
updateOwnAccountMeta()
updateActiveAccountMeta()
hasOwnIdentity()
exportActiveAccountKey()
```

## Contacts

```text
getContactByID()
hasContact()
hasContactByAddress()
getContactByAddress()
getContactByPublicKey()
getContactsByID()
getContactsByPublicKey()
listContacts()
addContact()
removeContact()
updateContactMeta()
exportContactAsJSON()
exportContactAsString()
importContactFromJSON()
importContactFromString()
exportContactCompressed()
importContactCompressed()
clearDirectory()
```

## Groups

```text
createGroup()
addGroup()
removeGroup()
getContactGroup()
getGroupOrThrow()
hasGroup()
listContactGroups()
listUserGroups()
listSystemGroups()
updateGroupMeta()
addContactToGroup()
addContactsToGroup()
removeContactFromGroup()
moveContactBetweenGroups()
getContactsInGroup()
getContactsInGroupSorted()
isContactInGroup()
getGroupsForContact()
getGroupIdsForContact()
```

## Favorites / Blocked

```text
addContactToFavorites()
removeContactFromFavorites()
isContactFavorite()
isContactBlocked()
getFavoritesGroup()
getBlockedGroup()
getFavoriteContacts()
getBlockedContacts()
```

## Invoice lifecycle

```text
createInvoice()
storeInvoice()
getInvoice()
getInvoiceOrThrow()
removeInvoice()
clearInvoices()

signInvoice()
signExternalInvoice()
sealInvoice()
decryptInvoice()
unlockInvoice()
decryptCachedInvoices()
decryptInvoices()
duplicateInvoice()

verifyInvoiceSignatures()
verifyInvoiceSignature()
verifyInvoiceSeal()
validateInvoice()

reissueInvoice()
restartInvoice()
setInvoiceMode()
switchInvoiceMode()

reissueSignAndStore()
finalizeInvoice()
```

## Invoice queries

```text
listInvoices()
queryInvoices()
queryInvoicesAdvanced()
listInvoicesByActiveAccount()
listInvoicesByIssuedAtRange()
listInvoicesByCreatedAtRange()
listInvoicesByMode()
listInvoicesByIssuer()
listInvoicesByRecipient()
listInvoicesByStatus()
hasInvoice()

getInvoicesNotOwnedByActiveAccount()
countInvoicesNotOwnedByActiveAccount()

getInvoiceStats()
getInvoicePublicSummary()
getInvoiceSealInfo()
```

## Invoice utilities

```text
batchExportInvoicesToCSV()
importInvoice()
expectedSignerFromKey()
expectedSignerFromContact()
```

## Expenses

```text
createExpense()
duplicateExpense()
getExpense()
getExpenseOrThrow()
storeExpense()
removeExpense()
clearExpenses()
listExpenses()
queryExpenses()
queryExpensesAdvanced()
listExpensesByActiveAccount()
listExpensesByCreatedAtRange()
listExpensesByCategory()
listExpensesByStatus()

getExpensesNotOwnedByActiveAccount()
countExpensesNotOwnedByActiveAccount()
```

## Recurring expenses

```text
actualizeRecurringExpense()
actualizeAllRecurringExpenses()
```

## Application state

```text
getInvoiceDefaults()
setInvoiceDefaults()
removeInvoiceDefaults()

getInvoiceTableColumns()
setInvoiceTableColumns()
resetInvoiceTableColumns()

getExpenseTableColumns()
setExpenseTableColumns()
resetExpenseTableColumns()

getUserAppPreferences()
setUserAppPreferences()
removeUserAppPreferences()
resetUserAppPreferences()

isAnalyticsEnabled()
isAutoDecryptInvoicesEnabled()
```

## Logging

```text
historyManager
activityManager

listHistoryForActiveAccount()
listActivityForActiveAccount()
recordActivity()

clearHistoryLogsForActiveAccount()
clearActivityLogsForActiveAccount()
restartLogsForActiveAccount()
hydrateLogsForActiveAccount()
```

## Backups

```text
backupInvoices()
backupExpenses()
backupContacts()
backupAppData()

readInvoicesBackup()
readContactsBackup()
readAppDataBackup()

restoreInvoices()
restoreContacts()
restoreAppData()
restoreAppDataSelective()

probeBackupType()
```

## Lifecycle

```text
hydrate()
MajikBuwizClient.create()
```

## Events

```text
on()
off()
```

---

# TypeScript

The client is written in TypeScript and exposes strongly typed domain models from the Majikah ecosystem.

Examples:

```typescript
import type {
  MajikInvoice,
  MajikInvoiceMode,
  MajikInvoiceContact,
  ExpenseRecord,
} from "@majikah/majik-buwiz-client";
```

The exact exported type surface depends on the package entry point and package build configuration.

---

# Related Majikah Packages

Majik Buwiz Client is intentionally built as an orchestration layer around the wider Majikah ecosystem.

Relevant packages include:

* [`@majikah/majik-key`](https://www.npmjs.com/package/@majikah/majik-key) — cryptographic identity and key management
* [`@majikah/majik-key-client`](https://www.npmjs.com/) — account/client lifecycle foundation
* [`@majikah/majik-invoice`](https://www.npmjs.com/) — invoice model and cryptographic invoice operations
* [`@majikah/majik-envelope`](https://www.npmjs.com/) — recipient/envelope construction
* [`@majikah/majik-signature`](https://www.npmjs.com/) — signing and verification primitives
* [`@majikah/majik-cjson`](https://www.npmjs.com/) — compressed JSON serialization
* [`@majikah/majik-file`](https://www.npmjs.com/) — file identity support

---

# License

[Apache-2.0](LICENSE) — free for personal and commercial use.

---

# Author

Developed by **Josef Elijah Fabian (Zelijah)** | [Majikah Solutions OPC](https://majikah.solutions/about)

## About the Developer

**Josef Elijah Fabian** is the founder and lead developer of **Majikah Solutions OPC**, building software across cryptography, document trust, business automation, and creative technology.

* **Developer:** Josef Elijah Fabian
* **GitHub:** [@thezelijah](https://github.com/jedlsf)
* **Organization:** [Majikah](https://github.com/Majikah)

---

# Majikah Solutions

**Your vision, my magic.**

Majik Buwiz is part of the broader Majikah ecosystem of developer tools and applications built around cryptographic identity, trustworthy digital documents, and practical business software.

* **Website:** https://majikah.solutions
* **GitHub:** https://github.com/Majikah

---

# Contact

* **Business:** [business@majikah.solutions](mailto:business@majikah.solutions)
* **Website:** https://majikah.solutions
* **GitHub:** https://github.com/Majikah

---

## Contributing

Contributions, bug reports, security reports, and improvements are welcome.

For security-sensitive issues, please follow the repository's security policy rather than publishing potentially exploitable details in a public issue.

---

## Summary

`MajikBuwizClient` is the application-facing orchestration layer for Majik Buwiz.

It brings together:

```text
MajikKey
   +
Accounts
   +
Contacts
   +
Invoices
   +
Expenses
   +
Recurring Expenses
   +
Signing / Verification
   +
Encryption / Decryption
   +
Audit / Activity Logs
   +
Backup / Restore
   +
Pluggable Storage
```

into a single client designed for real-world business applications.

The result is an API where common operations can stay simple:

```typescript
const client =
  await MajikBuwizClient.create(config);

client.setActiveAccount(accountId);

const invoice =
  await client.finalizeInvoice(
    draft,
    "encrypted-and-signed",
    [customerContactId],
  );

const verified =
  await client.verifyInvoiceSignatures(
    invoice,
  );

const backup =
  await client.backupAppData();
```

**Majik Buwiz Client — business data, cryptographic identity, and application state in one high-level client.**
