import { MajikInvoiceJSON } from "@majikah/majik-invoice";
import { MajikStorageAdapter, StorageSource } from "../storage-adapter";
import { InvoiceAdvancedQueryOptions, InvoiceDateRangeFilter } from "../../invoice/invoice-manager";

/**
 * All methods are async — consistent regardless of the backing store.
 * The adapter works only with serialized JSON; it never sees MajikInvoice
 * instances directly. Deserialization happens in MajikInvoiceManager.
 */
export interface MajikInvoiceStorageAdapter extends MajikStorageAdapter<MajikInvoiceJSON> {
  queryAdvanced?(opts: InvoiceAdvancedQueryOptions, source?: StorageSource): Promise<MajikInvoiceJSON[]>;
    countAdvanced?(opts: InvoiceAdvancedQueryOptions, source?: StorageSource): Promise<number>;
  listByPublicKey?(publicKey: string, source?: StorageSource): Promise<MajikInvoiceJSON[]>;
  listByIssuedAtRange?(range: InvoiceDateRangeFilter, source?: StorageSource): Promise<MajikInvoiceJSON[]>;
  listByCreatedAtRange?(range: InvoiceDateRangeFilter, source?: StorageSource): Promise<MajikInvoiceJSON[]>;
  listByMode?(mode: string, source?: StorageSource): Promise<MajikInvoiceJSON[]>;
}