import { RecurringExpenseItemStatus } from "./types";

export const RECURRING_EXPENSE_ITEM_ALLOWED_TRANSITIONS: Record<
  RecurringExpenseItemStatus,
  RecurringExpenseItemStatus[]
> = {
  active: ["paused", "ended"],
  paused: ["active", "ended"],
  ended: [], // terminal
};
