import { MajikStorageAdapter, StorageSource } from "../../storage-adapter";

import { RecurringExpenseItemJSON } from "../../../expenses/recurring/types";
import {
  DateRangeFilter,
  RecurringExpenseAdvancedQueryOptions,
} from "../../../expenses/types";

/**
 * All methods are async — consistent regardless of the backing store.
 * The adapter works only with serialized JSON; it never sees RecurringExpenseItem
 * instances directly. Deserialization happens in RecurringExpenseManager.
 */
export interface RecurringExpenseItemStorageAdapter extends MajikStorageAdapter<RecurringExpenseItemJSON> {
  queryAdvanced?(
    opts: RecurringExpenseAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<RecurringExpenseItemJSON[]>;
  countAdvanced?(
    opts: RecurringExpenseAdvancedQueryOptions,
    source?: StorageSource,
  ): Promise<number>;
  listByPublicKey?(
    publicKey: string,
    source?: StorageSource,
  ): Promise<RecurringExpenseItemJSON[]>;
  listByCreatedAtRange?(
    range: DateRangeFilter,
    source?: StorageSource,
  ): Promise<RecurringExpenseItemJSON[]>;
}
