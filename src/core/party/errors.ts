/**
 * @file errors.ts (invoice domain)
 * Only the contact + group errors change; Manager / Directory / GroupManager
 * errors stay as-is until phase 2.
 */
import {
  MajikContactError,
  MajikContactGroupError,
} from "@majikah/majik-contact";

export type MajikInvoiceContactErrorCode =
  | "INVALID_ID"
  | "INVALID_PUBLIC_KEY"
  | "INVALID_ML_KEY"
  | "INVALID_FINGERPRINT"
  | "INVALID_META"
  | "INVALID_LEGAL_NAME"
  | "INVALID_TIN"
  | "INVALID_ADDRESS"
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "INVALID_COUNTRY_CODE"
  | "MISSING_MAJIK_SNAPSHOT"
  | "SERIALIZATION_FAILED"
  | "DESERIALIZATION_FAILED"
  | "UPDATE_FAILED"
  | "INVALID_TAXPAYER_PROFILE";

/** Now `instanceof MajikContactError` is also true for invoice-contact errors. */
export class MajikInvoiceContactError extends MajikContactError {
  public readonly code: MajikInvoiceContactErrorCode;
  public readonly field?: string;

  constructor(
    message: string,
    code: MajikInvoiceContactErrorCode,
    options?: { field?: string; cause?: unknown },
  ) {
    super(message, options?.cause);
    this.name = "MajikInvoiceContactError";
    this.code = code;
    this.field = options?.field;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      field: this.field ?? null,
    };
  }
}

// Groups hold only contact IDs — no invoice-specific behaviour — so the
// invoice group error is the base error.
export { MajikContactGroupError as MajikInvoiceContactGroupError };

/* -------------------------------
 * Errors
 * ------------------------------- */

export class MajikInvoiceContactManagerError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikContactManagerError";
    this.cause = cause;
  }
}

export class MajikInvoiceContactDirectoryError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikContactDirectoryError";
    this.cause = cause;
  }
}

export class MajikInvoiceContactGroupManagerError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikContactGroupManagerError";
    this.cause = cause;
  }
}
