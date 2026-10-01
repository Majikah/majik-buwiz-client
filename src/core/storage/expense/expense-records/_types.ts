import { MajikStorageAdapter, StorageSource } from "../../storage-adapter";

import {
  DateRangeFilter,
  ExpenseAdvancedQueryOptions,
  ExpenseCategory,
  ExpenseRecordJSON,
} from "../../../expenses/types";

/**
 * All methods are async — consistent regardless of the backing store.
 * The adapter works only with serialized JSON; it never sees ExpenseRecord
 * instances directly. Deserialization happens in ExpenseManager.
 */
export interface ExpenseRecordStorageAdapter extends MajikStorageAdapter<ExpenseRecordJSON> {
  queryAdvanced?(
    opts: ExpenseAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]>;
  countAdvanced?(
    opts: ExpenseAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<number>;
  listByPublicKey?(
    publicKey: string,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]>;
  listByCreatedAtRange?(
    range: DateRangeFilter,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]>;

  listByCategory?(
    category: ExpenseCategory,
    source?: StorageSource,
  ): Promise<ExpenseRecordJSON[]>;
}
