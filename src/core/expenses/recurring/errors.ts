// =============================================================================
// ── ERRORS ────────────────────────────────────────────────────────────────────
// =============================================================================

import { ActualizationMonth, RecurringExpenseItemStatus } from "./types";

export class RecurringExpenseItemError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "RecurringExpenseItemError";
    this.field = field;
  }
}

export class RecurringExpenseItemLifecycleError extends RecurringExpenseItemError {
  readonly from: RecurringExpenseItemStatus;
  readonly to: RecurringExpenseItemStatus;
  constructor(
    message: string,
    from: RecurringExpenseItemStatus,
    to: RecurringExpenseItemStatus,
  ) {
    super(message);
    this.name = "RecurringExpenseItemLifecycleError";
    this.from = from;
    this.to = to;
  }
}

export class ActualizationConflictError extends RecurringExpenseItemError {
  readonly itemId: string;
  readonly month: ActualizationMonth;
  constructor(itemId: string, month: ActualizationMonth) {
    super(
      `Recurring expense item "${itemId}" has already been actualized for month "${month}". ` +
        `Pass strict: false (or omit it) to skip conflicts instead of throwing.`,
    );
    this.name = "ActualizationConflictError";
    this.itemId = itemId;
    this.month = month;
  }
}
