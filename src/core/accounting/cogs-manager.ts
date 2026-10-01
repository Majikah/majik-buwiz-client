/**
 * @file cogs-manager.ts
 * @description COGSManager — SKU-based cost of goods/services manager.
 *
 * Responsibilities:
 *   - Maintain a catalog of SKU definitions with per-unit cost or
 *     percentage-of-revenue cost method
 *   - Match invoice line items to SKUs via:
 *       1. skuId on the LineItem (LineItem.skuId optional field)
 *       2. Manual lineItemId → skuId mapping provided by the caller
 *   - Compute total COGS for a set of invoices
 *   - Throw if a line item cannot be matched to any SKU
 *   - Produce a breakdown of COGS per SKU for audit trail
 *
 * Sits alongside ExpenseEntry[] in PeriodFilingContext.
 * Feeds into Item 29 (Cost of Sales/Service) on Form 1701Q/1701A.
 */

import type { CurrencyCode, ISODateString } from "./types/bir-types";

// =============================================================================
// ── SKU DEFINITION ─────────────────────────────────────────────────────────────
// =============================================================================

/**
 * How the cost for this SKU is computed.
 *
 * fixed-per-unit   — costPerUnit × quantitySold
 *                    Good for: services billed by hour/day/unit,
 *                    physical goods with a known unit cost
 *
 * percentage       — costRate × lineItemRevenue
 *                    Good for: resellers, commission-based services,
 *                    items where cost scales directly with revenue
 */
export type COGSMethod = "fixed-per-unit" | "percentage";

export interface SKUDefinition {
  /** Unique identifier for this SKU — matched against LineItem.skuId */
  skuId: string;

  /** Human-readable description */
  description: string;

  /**
   * Cost computation method.
   * "fixed-per-unit" → costPerUnit × quantity
   * "percentage"     → costRate × lineItemRevenue
   */
  method: COGSMethod;

  /**
   * Cost per unit in functional currency.
   * Required when method === "fixed-per-unit".
   * Ignored when method === "percentage".
   */
  costPerUnit?: number;

  /**
   * Cost as a fraction of revenue (0–1).
   * Required when method === "percentage".
   * Ignored when method === "fixed-per-unit".
   * @example 0.40 = 40% of line revenue is cost
   */
  costRate?: number;

  /** Currency of costPerUnit — should match functional currency */
  currency: CurrencyCode;

  /**
   * Optional date range this cost definition is valid for.
   * Useful when unit costs change over time (e.g. rate increases).
   * If not provided, the definition applies to all periods.
   */
  effectiveFrom?: ISODateString;
  effectiveTo?: ISODateString;

  metadata?: Record<string, unknown>;
}

// =============================================================================
// ── LINE ITEM INPUT (subset needed by COGSManager) ────────────────────────────
// =============================================================================

/**
 * The subset of a line item COGSManager needs to compute COGS.
 * Matches GeneralInvoice's LineItem shape without a hard import.
 */
export interface COGSLineItemInput {
  id: string;
  description: string;
  quantity: number;
  /** Revenue amount for this line (post-discount, pre-tax) */
  lineTotalAmount: number;
  currency: CurrencyCode;
  /** Optional skuId — if present, used for direct SKU matching */
  skuId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * An invoice reduced to what COGSManager needs.
 * Accepts both ResolvedInvoice (GeneralInvoice) and a lightweight shape.
 */
export interface COGSInvoiceInput {
  id: string;
  issueDate: ISODateString;
  currency: CurrencyCode;
  lineItems: COGSLineItemInput[];
}

// =============================================================================
// ── COGS COMPUTATION RESULT ────────────────────────────────────────────────────
// =============================================================================

export interface COGSLineResult {
  lineItemId: string;
  lineItemDescription: string;
  skuId: string;
  skuDescription: string;
  method: COGSMethod;
  quantity: number;
  lineRevenue: number;
  costPerUnit?: number;
  costRate?: number;
  cogsAmount: number;
  currency: CurrencyCode;
}

export interface COGSInvoiceResult {
  invoiceId: string;
  issueDate: ISODateString;
  totalCOGS: number;
  lines: COGSLineResult[];
  /** Line items that had no SKU match — only present if allowUnmatched: true */
  unmatchedLines?: COGSUnmatchedLine[];
}

export interface COGSUnmatchedLine {
  lineItemId: string;
  lineItemDescription: string;
  reason: string;
}

export interface COGSComputationResult {
  /** Total COGS across all invoices — feeds into Form 1701Q Item 29 */
  totalCOGS: number;
  currency: CurrencyCode;
  invoiceResults: COGSInvoiceResult[];
  /** Aggregated COGS per SKU across all invoices */
  breakdown: COGSBreakdownEntry[];
  /** Any unmatched line items — only present if allowUnmatched: true */
  unmatchedLines: COGSUnmatchedLine[];
  /** True if all line items were successfully matched */
  fullyMatched: boolean;
}

export interface COGSBreakdownEntry {
  skuId: string;
  skuDescription: string;
  method: COGSMethod;
  totalQuantity: number;
  totalRevenue: number;
  totalCOGS: number;
}

// =============================================================================
// ── COGS MANAGER OPTIONS ──────────────────────────────────────────────────────
// =============================================================================

export interface COGSManagerOptions {
  /**
   * When true, line items with no SKU match are collected in
   * unmatchedLines instead of throwing.
   * Default: false — throw on first unmatched line item
   */
  allowUnmatched?: boolean;

  /**
   * When true, line items with no SKU match are silently skipped
   * (COGS contribution = 0 for those lines).
   * Takes precedence over allowUnmatched.
   * Default: false
   */
  skipUnmatched?: boolean;
}

// =============================================================================
// ── COGS MANAGER ──────────────────────────────────────────────────────────────
// =============================================================================

/**
 * COGSManager — SKU-based cost of goods/services manager.
 *
 * @example — basic usage
 * ```ts
 * const cogs = new COGSManager()
 *   .addSKU({
 *     skuId: "DEV-HR",
 *     description: "Development - Per Hour",
 *     method: "fixed-per-unit",
 *     costPerUnit: 250,
 *     currency: "PHP",
 *   })
 *   .addSKU({
 *     skuId: "RESELL-001",
 *     description: "Resold Software License",
 *     method: "percentage",
 *     costRate: 0.70,
 *     currency: "PHP",
 *   });
 *
 * // Compute COGS for a set of invoices
 * const result = cogs.compute(invoices);
 * console.log(result.totalCOGS); // feeds into Form 1701Q Item 29
 * ```
 *
 * @example — with manual lineItemId → skuId mapping
 * ```ts
 * const cogs = new COGSManager()
 *   .addSKU({ skuId: "SVC-001", ... })
 *   .addMapping("line-item-uuid-123", "SVC-001")
 *   .addMapping("line-item-uuid-456", "SVC-001");
 * ```
 */
export class COGSManager {
  private readonly _skus = new Map<string, SKUDefinition>();
  private readonly _mappings = new Map<string, string>(); // lineItemId → skuId
  private readonly _options: Required<COGSManagerOptions>;

  constructor(options?: COGSManagerOptions) {
    this._options = {
      allowUnmatched: options?.allowUnmatched ?? false,
      skipUnmatched: options?.skipUnmatched ?? false,
    };
  }

  // ── SKU catalog management ────────────────────────────────────────────────

  /**
   * Add a SKU definition to the catalog.
   * Throws if a SKU with the same skuId already exists.
   * Use replaceSKU() to update an existing definition.
   */
  addSKU(sku: SKUDefinition): this {
    COGSManager._validateSKU(sku);

    if (this._skus.has(sku.skuId)) {
      throw new COGSManagerError(
        `SKU "${sku.skuId}" already exists. Use replaceSKU() to update it.`,
        "skuId",
      );
    }
    this._skus.set(sku.skuId, { ...sku });
    return this;
  }

  /**
   * Replace an existing SKU definition.
   * Throws if the SKU does not exist.
   */
  replaceSKU(sku: SKUDefinition): this {
    COGSManager._validateSKU(sku);

    if (!this._skus.has(sku.skuId)) {
      throw new COGSManagerError(
        `SKU "${sku.skuId}" not found. Use addSKU() to add a new SKU.`,
        "skuId",
      );
    }
    this._skus.set(sku.skuId, { ...sku });
    return this;
  }

  /**
   * Add or replace — upsert semantics.
   */
  setSKU(sku: SKUDefinition): this {
    COGSManager._validateSKU(sku);
    this._skus.set(sku.skuId, { ...sku });
    return this;
  }

  /**
   * Remove a SKU by skuId.
   * No-op if not found.
   */
  removeSKU(skuId: string): this {
    this._skus.delete(skuId);
    return this;
  }

  /**
   * Get a SKU by skuId.
   * Returns undefined if not found.
   */
  getSKU(skuId: string): SKUDefinition | undefined {
    return this._skus.get(skuId);
  }

  /**
   * List all SKU definitions.
   */
  listSKUs(): SKUDefinition[] {
    return [...this._skus.values()];
  }

  // ── Manual lineItemId → skuId mapping ────────────────────────────────────

  /**
   * Manually map a specific line item ID to a SKU ID.
   * This mapping takes precedence over LineItem.skuId.
   *
   * Use when you cannot or do not want to add skuId to line item metadata.
   *
   * @param lineItemId  - The ID of the line item on the invoice
   * @param skuId       - The SKU ID to map it to
   */
  addMapping(lineItemId: string, skuId: string): this {
    if (!lineItemId?.trim()) {
      throw new COGSManagerError("lineItemId cannot be empty", "lineItemId");
    }
    if (!skuId?.trim()) {
      throw new COGSManagerError("skuId cannot be empty", "skuId");
    }
    if (!this._skus.has(skuId)) {
      throw new COGSManagerError(
        `Cannot map to SKU "${skuId}" — it does not exist in the catalog. ` +
          `Call addSKU() first.`,
        "skuId",
      );
    }
    this._mappings.set(lineItemId, skuId);
    return this;
  }

  /**
   * Remove a manual mapping.
   * No-op if not found.
   */
  removeMapping(lineItemId: string): this {
    this._mappings.delete(lineItemId);
    return this;
  }

  /**
   * Clear all manual mappings.
   */
  clearMappings(): this {
    this._mappings.clear();
    return this;
  }

  // ── Core computation ──────────────────────────────────────────────────────

  /**
   * Compute total COGS for a set of invoices.
   *
   * Matching priority per line item:
   *   1. Manual mapping (lineItemId → skuId via addMapping())
   *   2. LineItem.skuId field (direct SKU reference on the line item)
   *   3. If neither found → throw COGSManagerError
   *      (unless allowUnmatched or skipUnmatched is true)
   *
   * @param invoices    - Invoices to compute COGS for
   * @param asOfDate    - Optional date filter — only SKUs effective on this date
   * @throws {COGSManagerError} if a line item cannot be matched and
   *         neither allowUnmatched nor skipUnmatched is true
   */
  compute(
    invoices: COGSInvoiceInput[],
    asOfDate?: ISODateString,
  ): COGSComputationResult {
    const invoiceResults: COGSInvoiceResult[] = [];
    const globalUnmatched: COGSUnmatchedLine[] = [];
    const breakdownMap = new Map<string, COGSBreakdownEntry>();
    let totalCOGS = 0;

    for (const invoice of invoices) {
      const invoiceResult = this._computeInvoice(
        invoice,
        asOfDate ?? invoice.issueDate,
        globalUnmatched,
      );
      invoiceResults.push(invoiceResult);
      totalCOGS += invoiceResult.totalCOGS;

      // Aggregate breakdown per SKU
      for (const line of invoiceResult.lines) {
        const existing = breakdownMap.get(line.skuId) ?? {
          skuId: line.skuId,
          skuDescription: line.skuDescription,
          method: line.method,
          totalQuantity: 0,
          totalRevenue: 0,
          totalCOGS: 0,
        };
        existing.totalQuantity += line.quantity;
        existing.totalRevenue += line.lineRevenue;
        existing.totalCOGS += line.cogsAmount;
        breakdownMap.set(line.skuId, existing);
      }
    }

    const currency = invoices[0]?.currency ?? "PHP";

    return {
      totalCOGS,
      currency,
      invoiceResults,
      breakdown: [...breakdownMap.values()].sort(
        (a, b) => b.totalCOGS - a.totalCOGS,
      ),
      unmatchedLines: globalUnmatched,
      fullyMatched: globalUnmatched.length === 0,
    };
  }

  /**
   * Convenience method — compute and return only the total COGS amount.
   * Equivalent to compute(invoices).totalCOGS.
   */
  computeTotal(invoices: COGSInvoiceInput[], asOfDate?: ISODateString): number {
    return this.compute(invoices, asOfDate).totalCOGS;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get skuCount(): number {
    return this._skus.size;
  }

  get mappingCount(): number {
    return this._mappings.size;
  }

  hasSKU(skuId: string): boolean {
    return this._skus.has(skuId);
  }

  hasMapping(lineItemId: string): boolean {
    return this._mappings.has(lineItemId);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _computeInvoice(
    invoice: COGSInvoiceInput,
    asOfDate: ISODateString,
    globalUnmatched: COGSUnmatchedLine[],
  ): COGSInvoiceResult {
    const lines: COGSLineResult[] = [];
    const invoiceUnmatched: COGSUnmatchedLine[] = [];
    let totalCOGS = 0;

    for (const lineItem of invoice.lineItems) {
      // ── Step 1: Resolve SKU ID ───────────────────────────────────────────
      const resolvedSkuId = this._resolveSkuId(lineItem);

      if (!resolvedSkuId) {
        const unmatched: COGSUnmatchedLine = {
          lineItemId: lineItem.id,
          lineItemDescription: lineItem.description,
          reason:
            `No SKU match found for line item "${lineItem.id}" ` +
            `("${lineItem.description}"). ` +
            `Provide a manual mapping via addMapping() or add skuId ` +
            `to the line item.`,
        };

        if (this._options.skipUnmatched) {
          continue; // silently skip
        }

        if (this._options.allowUnmatched) {
          invoiceUnmatched.push(unmatched);
          globalUnmatched.push(unmatched);
          continue;
        }

        // Default: throw
        throw new COGSManagerError(unmatched.reason, "skuId");
      }

      // ── Step 2: Resolve SKU definition ───────────────────────────────────
      const sku = this._resolveSKUForDate(resolvedSkuId, asOfDate);

      if (!sku) {
        const reason =
          `SKU "${resolvedSkuId}" is not effective on ${asOfDate}. ` +
          `Check effectiveFrom/effectiveTo on the SKU definition.`;

        const unmatched: COGSUnmatchedLine = {
          lineItemId: lineItem.id,
          lineItemDescription: lineItem.description,
          reason,
        };

        if (this._options.skipUnmatched) continue;
        if (this._options.allowUnmatched) {
          invoiceUnmatched.push(unmatched);
          globalUnmatched.push(unmatched);
          continue;
        }

        throw new COGSManagerError(reason, "skuId");
      }

      // ── Step 3: Compute COGS for this line ───────────────────────────────
      const cogsAmount = this._computeLineCOGS(sku, lineItem);

      lines.push({
        lineItemId: lineItem.id,
        lineItemDescription: lineItem.description,
        skuId: sku.skuId,
        skuDescription: sku.description,
        method: sku.method,
        quantity: lineItem.quantity,
        lineRevenue: lineItem.lineTotalAmount,
        costPerUnit: sku.costPerUnit,
        costRate: sku.costRate,
        cogsAmount,
        currency: sku.currency,
      });

      totalCOGS += cogsAmount;
    }

    return {
      invoiceId: invoice.id,
      issueDate: invoice.issueDate,
      totalCOGS,
      lines,
      unmatchedLines:
        invoiceUnmatched.length > 0 ? invoiceUnmatched : undefined,
    };
  }

  /**
   * Resolve the skuId for a line item.
   * Priority: manual mapping → LineItem.skuId → null
   */
  private _resolveSkuId(lineItem: COGSLineItemInput): string | null {
    // Priority 1: manual mapping
    const mapped = this._mappings.get(lineItem.id);
    if (mapped) return mapped;

    // Priority 2: skuId on the line item itself
    if (lineItem.skuId?.trim()) return lineItem.skuId.trim();

    // Priority 3: check metadata for skuId (backward compat)
    if (lineItem.metadata?.skuId) {
      return String(lineItem.metadata.skuId);
    }

    return null;
  }

  /**
   * Resolve a SKU definition effective on a given date.
   * Returns undefined if the SKU doesn't exist or is not effective.
   */
  private _resolveSKUForDate(
    skuId: string,
    asOfDate: ISODateString,
  ): SKUDefinition | undefined {
    const sku = this._skus.get(skuId);
    if (!sku) return undefined;

    // Check effectiveFrom
    if (sku.effectiveFrom && asOfDate < sku.effectiveFrom) {
      return undefined;
    }

    // Check effectiveTo
    if (sku.effectiveTo && asOfDate > sku.effectiveTo) {
      return undefined;
    }

    return sku;
  }

  /**
   * Compute COGS for a single line item against a SKU definition.
   */
  private _computeLineCOGS(
    sku: SKUDefinition,
    lineItem: COGSLineItemInput,
  ): number {
    if (sku.method === "fixed-per-unit") {
      if (sku.costPerUnit === undefined || sku.costPerUnit < 0) {
        throw new COGSManagerError(
          `SKU "${sku.skuId}" uses method "fixed-per-unit" but costPerUnit ` +
            `is not defined or is negative.`,
          "costPerUnit",
        );
      }
      return sku.costPerUnit * lineItem.quantity;
    }

    // method === "percentage"
    if (sku.costRate === undefined || sku.costRate < 0 || sku.costRate > 1) {
      throw new COGSManagerError(
        `SKU "${sku.skuId}" uses method "percentage" but costRate ` +
          `is not defined or is outside 0–1 range.`,
        "costRate",
      );
    }
    return sku.costRate * lineItem.lineTotalAmount;
  }

  // ── Static validation ─────────────────────────────────────────────────────

  private static _validateSKU(sku: SKUDefinition): void {
    if (!sku.skuId?.trim()) {
      throw new COGSManagerError("SKU skuId is required", "skuId");
    }
    if (!sku.description?.trim()) {
      throw new COGSManagerError("SKU description is required", "description");
    }
    if (!sku.currency?.trim()) {
      throw new COGSManagerError("SKU currency is required", "currency");
    }
    if (!["fixed-per-unit", "percentage"].includes(sku.method)) {
      throw new COGSManagerError(
        `SKU method must be "fixed-per-unit" or "percentage"`,
        "method",
      );
    }
    if (sku.method === "fixed-per-unit") {
      if (sku.costPerUnit === undefined || sku.costPerUnit < 0) {
        throw new COGSManagerError(
          `costPerUnit is required and must be ≥ 0 for method "fixed-per-unit"`,
          "costPerUnit",
        );
      }
    }
    if (sku.method === "percentage") {
      if (sku.costRate === undefined || sku.costRate < 0 || sku.costRate > 1) {
        throw new COGSManagerError(
          `costRate is required and must be between 0 and 1 for method "percentage"`,
          "costRate",
        );
      }
    }
    if (
      sku.effectiveFrom &&
      sku.effectiveTo &&
      sku.effectiveFrom > sku.effectiveTo
    ) {
      throw new COGSManagerError(
        `effectiveFrom (${sku.effectiveFrom}) cannot be after effectiveTo (${sku.effectiveTo})`,
        "effectiveFrom",
      );
    }
  }
}

// =============================================================================
// ── ERROR ─────────────────────────────────────────────────────────────────────
// =============================================================================

export class COGSManagerError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "COGSManagerError";
    this.field = field;
  }
}
