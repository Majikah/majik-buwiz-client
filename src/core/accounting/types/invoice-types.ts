// ---------------------------------------------------------------------------
// Invoice input union
// ---------------------------------------------------------------------------

import { GeneralInvoice, MajikInvoice } from "@majikah/majik-invoice";

/**
 * What the builder accepts as invoice input.
 * MajikInvoice is typed loosely here to avoid a hard dependency on the
 * MajikInvoice class — we only need a small interface from it.
 */
export type ResolvableInvoice = MajikInvoice;

/**
 * The subset of GeneralInvoice the builder needs for normalization.
 * Matches GeneralInvoice's actual shape without importing the class.
 */
export type ResolvedInvoice = GeneralInvoice;
