// =============================================================================
// ── ERRORS ───────────────────────────────────────────────────────────────────
// =============================================================================

import { ExpenseRecordStatus } from "./types";

export class ExpenseRecordError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ExpenseRecordError";
    this.field = field;
  }
}

export class ExpenseRecordLifecycleError extends ExpenseRecordError {
  readonly from: ExpenseRecordStatus;
  readonly to: ExpenseRecordStatus;

  constructor(
    message: string,
    from: ExpenseRecordStatus,
    to: ExpenseRecordStatus,
  ) {
    super(message);
    this.name = "ExpenseRecordLifecycleError";
    this.from = from;
    this.to = to;
  }
}

export class ExpenseRecordMutationError extends ExpenseRecordError {
  constructor(message: string, field?: string) {
    super(message, field);
    this.name = "ExpenseRecordMutationError";
  }
}
