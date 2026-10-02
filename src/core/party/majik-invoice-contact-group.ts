/**
 * Invoice groups only store contact IDs, so there is nothing invoice-specific
 * to add. Re-export the base class under the old name — value AND type —
 * which deletes ~400 duplicated lines and keeps every existing import
 * (`new MajikInvoiceContactGroup`, `instanceof`, statics) working.
 */
export { MajikContactGroup as MajikInvoiceContactGroup } from "@majikah/majik-contact";