import { ExpenseDocumentType, ExpenseRecordStatus } from "./types";

export const EXPENSE_DOCUMENT_TYPE_LABELS: Record<ExpenseDocumentType, string> =
  {
    "supplier-invoice": "Supplier Invoice",
    "official-receipt": "Official Receipt",
    "billing-statement": "Billing Statement",
    "utility-bill": "Utility Bill",
    "rent-invoice": "Rent Invoice",
    "professional-fee-invoice": "Professional Fee Invoice",
    "importation-document": "Importation Document",
    other: "Other",
  };

export const EXPENSE_RECORD_ALLOWED_TRANSITIONS: Record<
  ExpenseRecordStatus,
  ExpenseRecordStatus[]
> = {
  draft: ["approved"],
  approved: ["refunded"],
  refunded: [], // terminal
};
