
import { SerializedMajikInvoiceContact } from "../../../party/types";
import { IDBGenericAdapter } from "../../idb-adapter";

const IDB_DB_NAME = "majik-contacts";
const IDB_STORE_NAME = "contacts";
const IDB_VERSION = 1;

export const IDB_ADAPTER_CONTACT =
  new IDBGenericAdapter<SerializedMajikInvoiceContact>(
    IDB_DB_NAME,
    IDB_STORE_NAME,
    IDB_VERSION,
  );
