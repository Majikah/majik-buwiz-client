
import { SerializedMajikInvoiceContactGroup } from "../../../party/types";
import { IDBGenericAdapter } from "../../idb-adapter";

const IDB_DB_NAME = "majik-contact-groups";
const IDB_STORE_NAME = "groups";
const IDB_VERSION = 1;

export const IDB_ADAPTER_CONTACT_GROUP =
  new IDBGenericAdapter<SerializedMajikInvoiceContactGroup>(
    IDB_DB_NAME,
    IDB_STORE_NAME,
    IDB_VERSION,
  );
