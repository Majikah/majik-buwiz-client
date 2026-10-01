
import { SerializedMajikInvoiceContact } from "../../../party/types";
import { MajikStorageAdapter } from "../../storage-adapter";

export type MajikInvoiceContactStorageAdapter =
  MajikStorageAdapter<SerializedMajikInvoiceContact>;
