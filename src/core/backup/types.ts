import { MajikInvoice } from "@majikah/majik-invoice";
import { MajikInvoiceContact } from "../party/majik-invoice-contact";
import { MajikInvoiceContactGroup } from "../party/majik-invoice-contact-group";
import { MajikInvoiceContactManagerJSON } from "../party/types";
import { InvoiceDefaults, UserAppPreferences } from "../storage";
import { ExpenseRecord } from "../expenses/expense-record";

// In your types file or at the top of the client file
export interface ContactManagerSnapshot {
  /** Raw JSON payload — used internally by restoreContacts for bulk writes */
  managerJSON: MajikInvoiceContactManagerJSON;
  /** Hydrated contact instances — ready for preview/display */
  contacts: MajikInvoiceContact[];
  /** User-defined groups only — system groups excluded */
  groups: MajikInvoiceContactGroup[];
}

export interface AppDataSnapshot {
  invoices: MajikInvoice[];
  expenses: ExpenseRecord[];
  contacts: MajikInvoiceContact[];
  groups: MajikInvoiceContactGroup[];
  invoiceDefaults: InvoiceDefaults | null;
  preferences: UserAppPreferences | null;
  /** @internal Raw manager JSON — used by restoreAppDataSelective, not for display */
  _contactsManagerJSON: MajikInvoiceContactManagerJSON;
}
