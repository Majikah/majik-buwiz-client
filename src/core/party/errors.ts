/**
 * @file majik-invoice-contact.error.ts
 * @description Typed error class for MajikInvoiceContact operations.
 */

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

export class MajikInvoiceContactError extends Error {
  public readonly code: MajikInvoiceContactErrorCode;
  public readonly field?: string;
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: MajikInvoiceContactErrorCode,
    options?: { field?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "MajikInvoiceContactError";
    this.code = code;
    this.field = options?.field;
    this.cause = options?.cause;

    // Maintain correct prototype chain in transpiled environments
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

export class MajikInvoiceContactGroupError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikInvoiceContactGroupError";
    this.cause = cause;
  }
}

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
