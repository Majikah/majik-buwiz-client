import { MajikFileJSON } from "@majikah/majik-file";
import {
  LogType,
  HistoryType,
  HistoryStatus,
  HistorySource,
  AuditAction,
  NotaryNetwork,
} from "./enums";

/**
 * ROOT INTERFACE
 * Reusable base for all log entries.
 */
export interface BaseLogEntry<T extends LogType> {
  /**
   * Unique log identifier.
   * This is a UUID.
   */
  id: string;
  /**
   * Unique file identifier.
   * This is the digest hash.
   */
  reference_id: string;
  type: T;
  timestamp: string;
  version: number;
  /**
   * Blob encrypted data.
   * For History logs: standard encrypted blob.
   * For Audit logs: encrypted with majik envelope.
   */
  data?: Uint8Array;
}


/**
 * JSON-serializable base representation (Base64 strings for binary data).
 */
export interface BaseLogJSON<T extends LogType> {
  id: string;
  reference_id: string;
  type: T;
  timestamp: string;
  version: number;
  fingerprint?: string;
  data?: string; // Base64-encoded encrypted .mjkb binary
  fileJson?: MajikFileJSON;
}

export interface HistoryLogJSON extends BaseLogJSON<"history"> {
  historyType: HistoryType;
  status: HistoryStatus;
  source: HistorySource;
  operation: InvoiceOperation;
  signerCount?: number;
  valid?: boolean;
  network?: NotaryNetwork;
  transactionId?: string;
}

export interface UserActivityLogJSON extends BaseLogJSON<"audit"> {
  action: AuditAction;
  metadata?: Record<string, unknown>;
}

/* ==========================================
 * HISTORY LOGS
 * ========================================== */

/**
 * Parent type for all history entries.
 * Branches off the root LogEntry.
 */
export interface BaseHistoryEntry<
  T extends HistoryType,
> extends BaseLogEntry<"history"> {
  historyType: T;
  status: HistoryStatus;
  source: HistorySource;
}

export interface InvoiceOperation {
  reference_id: string;
  detached: boolean;
  sealed: boolean;
  tsa: boolean;
}

export interface InvoiceHistoryEntry extends BaseHistoryEntry<"sign"> {
  operation: InvoiceOperation;
  signerCount: number;
}

export interface VerifiedHistoryEntry extends BaseHistoryEntry<"verify"> {
  operation: InvoiceOperation;
  valid: boolean;
}

export interface SealedHistoryEntry extends BaseHistoryEntry<"seal"> {
  operation: InvoiceOperation;
}

// Added the missing Notarized interface based on your checklist
export interface NotarizedHistoryEntry extends BaseHistoryEntry<"notarize"> {
  operation: InvoiceOperation;
  network: NotaryNetwork;
  transactionId?: string; // Helpful for blockchain verification
}

/**
 * Union type for type-safe history handling.
 */
export type HistoryEntry =
  | InvoiceHistoryEntry
  | VerifiedHistoryEntry
  | SealedHistoryEntry
  | NotarizedHistoryEntry;

/* ==========================================
 * AUDIT (USER ACTIVITY) LOGS
 * ========================================== */

/**
 * Audit log entry.
 * Branches off the root LogEntry entirely independent of History.
 */
export interface AuditEntry extends BaseLogEntry<"audit"> {
  action: AuditAction;
  /**
   * Unencrypted metadata for fast querying (optional).
   * The primary sensitive details should remain in `data` (majik envelope).
   */
  metadata?: Record<string, unknown>;
}

/* ==========================================
 * EXPORTED MASTER TYPE
 * ========================================== */

/**
 * The final Discriminated Union.
 * Use this type when fetching an array of mixed logs.
 */
export type LogEntry = HistoryEntry | AuditEntry;
