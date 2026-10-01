/**
 * @file tax-accountant.ts
 * @description TaxAccountant — the main orchestrator for BIR tax computations.
 *
 * Responsibilities:
 *   - Holds one ITaxFormAdapter and one filing context at a time
 *   - Manages a FilingChain for monthly → quarterly → annual accumulation
 *   - Runs pre-flight capability checks before delegating to the adapter
 *   - Exposes prepare(), validate(), summarize() as top-level methods
 *   - Supports both manual construction and TaxAccountant.init() factory
 *   - Supports in-place adapter swapping via setAdapter()
 *   - Supports typed adapter swapping via withAdapter() (returns new instance)
 *   - Hosts an AdapterRegistry for form-code-based adapter resolution
 *
 */

import type {
  AdapterCapabilities,
  BaseFilingContext,
  BaseFilingOutput,
  FilingChain,
  FilingSummary,
  PeriodFilingContext,
  ValidationResult,
} from "./types/bir-types";

import { FilingChainImpl } from "./filing-context";

import { ITaxFormAdapter } from "./adapters/base-adapter";

export interface TaxAccountantStatic {
  new <TContext extends BaseFilingContext, TOutput extends BaseFilingOutput>(
    adapter: ITaxFormAdapter<TContext, TOutput>,
    context: TContext,
    options?: TaxAccountantOptions,
    chain?: FilingChain,
  ): TaxAccountant<TContext, TOutput>;

  init<TContext extends BaseFilingContext, TOutput extends BaseFilingOutput>(
    input: TaxAccountantInitInput<TContext, TOutput>,
  ): TaxAccountant<TContext, TOutput>;

  for<TContext extends BaseFilingContext, TOutput extends BaseFilingOutput>(
    formCode: string,
    context: TContext,
    options?: TaxAccountantOptions,
    chain?: FilingChain,
  ): TaxAccountant<TContext, TOutput>;
}

// =============================================================================
// ── TAXACCOUNTANT OPTIONS ──────────────────────────────────────────────────────
// =============================================================================

export interface TaxAccountantOptions {
  /**
   * When true, pre-flight capability checks produce warnings instead
   * of throwing. Useful during development when adapters are partially
   * implemented.
   * Default: false
   */
  lenientPreFlight?: boolean;

  /**
   * When true, successful prepare() calls automatically register
   * the output into the FilingChain.
   * Default: true
   */
  autoRegisterOutputs?: boolean;

  /**
   * When true, clearCache() is called on the previous adapter
   * when setAdapter() is called.
   * Default: true
   */
  clearCacheOnAdapterSwap?: boolean;
}

// =============================================================================
// ── TAXACCOUNTANT INIT INPUT ──────────────────────────────────────────────────
// =============================================================================

export interface TaxAccountantInitInput<
  TContext extends BaseFilingContext,
  TOutput extends BaseFilingOutput,
> {
  adapter: ITaxFormAdapter<TContext, TOutput>;
  context: TContext;
  /**
   * Bring your own FilingChain — useful when sharing a chain
   * across multiple TaxAccountant instances for the same taxpayer/year.
   * If omitted, a new FilingChainImpl is created.
   */
  chain?: FilingChain;
  options?: TaxAccountantOptions;
}

// =============================================================================
// ── PRE-FLIGHT ERROR ──────────────────────────────────────────────────────────
// =============================================================================

/**
 * Thrown by TaxAccountant when an adapter's capabilities are
 * incompatible with the current context profile.
 *
 * Separate from FilingAdapterError (computation errors) and
 * FilingContextError (context assembly errors).
 */
export class TaxAccountantPreFlightError extends Error {
  readonly formCode: string;
  readonly reasons: string[];

  constructor(formCode: string, reasons: string[]) {
    super(
      `[${formCode}] Pre-flight check failed:\n` +
        reasons.map((r) => `  - ${r}`).join("\n"),
    );
    this.name = "TaxAccountantPreFlightError";
    this.formCode = formCode;
    this.reasons = reasons;
  }
}

// =============================================================================
// ── TAXACCOUNTANT ─────────────────────────────────────────────────────────────
// =============================================================================

/**
 * TaxAccountant — main orchestrator.
 *
 * Generic parameters:
 *   TContext — the filing context type the current adapter accepts
 *   TOutput  — the output type the current adapter produces
 *
 * Both parameters update when withAdapter() is called, preserving
 * full type safety through adapter swaps.
 */
export class TaxAccountant<
  TContext extends BaseFilingContext,
  TOutput extends BaseFilingOutput,
> {
  // ── Core state ────────────────────────────────────────────────────────────

  private _adapter: ITaxFormAdapter<TContext, TOutput>;
  private _context: TContext;
  private readonly _chain: FilingChain;
  private readonly _options: Required<TaxAccountantOptions>;

  // ── Last computed output (in-memory, not persisted) ───────────────────────

  private _lastOutput: TOutput | undefined;

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(
    adapter: ITaxFormAdapter<TContext, TOutput>,
    context: TContext,
    options?: TaxAccountantOptions,
    chain?: FilingChain,
  ) {
    this._adapter = adapter;
    this._context = context;
    this._chain = chain ?? new FilingChainImpl();
    this._options = {
      lenientPreFlight: options?.lenientPreFlight ?? false,
      autoRegisterOutputs: options?.autoRegisterOutputs ?? true,
      clearCacheOnAdapterSwap: options?.clearCacheOnAdapterSwap ?? true,
    };
  }

  // ── Static factory ────────────────────────────────────────────────────────

  /**
   * Create a TaxAccountant from a single input object.
   * Equivalent to the constructor but more ergonomic for one-liners.
   *
   * @example
   * const ta = TaxAccountant.init({
   *   adapter: new Form1701QAdapter(),
   *   context: await FilingContextBuilder.from({ ... }).build(),
   * });
   */
  static init<
    TContext extends BaseFilingContext,
    TOutput extends BaseFilingOutput,
  >(
    input: TaxAccountantInitInput<TContext, TOutput>,
  ): TaxAccountant<TContext, TOutput> {
    return new TaxAccountant(
      input.adapter,
      input.context,
      input.options,
      input.chain,
    );
  }

  // ==========================================================================
  // ── CORE DELEGATION METHODS ────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Validate the current context against the current adapter.
   * Runs the adapter's validate() after pre-flight checks pass.
   * Never throws — returns a ValidationResult.
   *
   * Pre-flight errors are included as validation errors in the result
   * when lenientPreFlight is true.
   */
  validate(): ValidationResult {
    // Pre-flight — collect reasons rather than throw when lenient
    const preFlightReasons = this._runPreFlight(this._adapter, this._context);

    if (preFlightReasons.length > 0 && !this._options.lenientPreFlight) {
      // Convert pre-flight failures into a ValidationResult
      return {
        valid: false,
        issues: preFlightReasons.map((r) => ({
          severity: "error" as const,
          code: "PRE_FLIGHT_FAILURE",
          message: r,
        })),
        errors: preFlightReasons.map((r) => ({
          severity: "error" as const,
          code: "PRE_FLIGHT_FAILURE",
          message: r,
        })),
        warnings: [],
      };
    }

    return this._adapter.validate(this._context);
  }

  /**
   * Compute the full filing output.
   *
   * Flow:
   *   1. Run pre-flight capability checks
   *   2. Delegate to adapter.compute() (which auto-validates internally)
   *   3. Cache the output as _lastOutput
   *   4. Auto-register into FilingChain if autoRegisterOutputs is true
   *   5. Return the typed output
   *
   * @throws {TaxAccountantPreFlightError} if pre-flight fails and not lenient
   * @throws {FilingAdapterError} if adapter validation fails and not dryRun
   */
  prepare(): TOutput {
    // ── Pre-flight ─────────────────────────────────────────────────────────
    const preFlightReasons = this._runPreFlight(this._adapter, this._context);

    if (preFlightReasons.length > 0 && !this._options.lenientPreFlight) {
      throw new TaxAccountantPreFlightError(
        this._adapter.formCode,
        preFlightReasons,
      );
    }

    // ── Delegate to adapter ────────────────────────────────────────────────
    const output = this._adapter.compute(this._context);

    // ── Cache locally ──────────────────────────────────────────────────────
    this._lastOutput = output;

    // ── Auto-register into FilingChain ────────────────────────────────────
    if (this._options.autoRegisterOutputs) {
      this._chain.add(output);
    }

    return output;
  }

  /**
   * Summarize the last computed output.
   * Throws if prepare() has not been called yet.
   *
   * @throws {TaxAccountantError} if no output has been computed yet
   */
  summarize(): FilingSummary {
    if (!this._lastOutput) {
      throw new TaxAccountantError(
        "No output to summarize. Call prepare() first.",
      );
    }
    return this._adapter.summarize(this._lastOutput);
  }

  /**
   * Summarize a specific output — useful for summarizing outputs
   * retrieved from the FilingChain without re-computing.
   */
  summarizeOutput(output: TOutput): FilingSummary {
    return this._adapter.summarize(output);
  }

  // ==========================================================================
  // ── ADAPTER MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Swap the adapter in place.
   * Clears the previous adapter's cache (unless clearCacheOnAdapterSwap: false).
   * Preserves the current context and FilingChain.
   * Clears _lastOutput since it belongs to the previous adapter.
   *
   * NOTE: TypeScript cannot change the generic parameters of an existing
   * instance. If the new adapter produces a different output type, use
   * withAdapter() instead to get a properly typed new instance.
   *
   * @example — same output type, different adapter config
   * ta.setAdapter(new Form1701QAdapter({ quarter: 2 }));
   * const q2Output = ta.prepare();
   */
  setAdapter(adapter: ITaxFormAdapter<TContext, TOutput>): this {
    if (this._options.clearCacheOnAdapterSwap) {
      this._adapter.clearCache();
    }
    this._adapter = adapter;
    this._lastOutput = undefined;
    return this;
  }

  /**
   * Return a new TaxAccountant with a different adapter.
   * The new instance shares the same FilingChain and context.
   * The original instance is untouched.
   *
   * Use this when the new adapter produces a DIFFERENT output type,
   * so TypeScript can infer the correct TOutput on the new instance.
   *
   * @example — switch from quarterly to annual (different output types)
   * const annualTa = ta.withAdapter(new Form1701AAdapter());
   * const annualOutput = annualTa.prepare(); // typed as Form1701AOutput
   */
  withAdapter<TNewOutput extends BaseFilingOutput>(
    adapter: ITaxFormAdapter<TContext, TNewOutput>,
  ): TaxAccountant<TContext, TNewOutput> {
    return new TaxAccountant<TContext, TNewOutput>(
      adapter,
      this._context,
      this._options,
      this._chain, // shared FilingChain
    );
  }

  /**
   * Return a new TaxAccountant with a different context.
   * The new instance shares the same adapter and FilingChain.
   * The original instance is untouched.
   *
   * @example — same adapter, next quarter's context
   * const q2Ta = ta.withContext(q2Context);
   * const q2Output = q2Ta.prepare();
   */
  withContext(context: TContext): TaxAccountant<TContext, TOutput> {
    return new TaxAccountant<TContext, TOutput>(
      this._adapter,
      context,
      this._options,
      this._chain, // shared FilingChain
    );
  }

  // ==========================================================================
  // ── CONTEXT MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Replace the current context in place.
   * Clears the adapter's cache since a new context needs fresh computation.
   * Clears _lastOutput.
   */
  setContext(context: TContext): this {
    this._adapter.clearCache();
    this._context = context;
    this._lastOutput = undefined;
    return this;
  }

  // ==========================================================================
  // ── FILING CHAIN ACCESS ────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Access the FilingChain directly for reading prior outputs.
   *
   * @example — get all Q1-Q3 outputs to pass as priorPeriodOutputs for Q4
   * const priorQuarters = ta.chain.getByForm("1701Q", 2024);
   */
  get chain(): FilingChain {
    return this._chain;
  }

  /**
   * Manually register an output into the FilingChain.
   * Useful when autoRegisterOutputs is false or when registering
   * outputs from external sources (e.g. a previously filed return
   * loaded from storage).
   */
  registerOutput(output: BaseFilingOutput): this {
    this._chain.add(output);
    return this;
  }

  // ==========================================================================
  // ── GETTERS ────────────────────────────────────────────────────────────────
  // ==========================================================================

  get adapter(): ITaxFormAdapter<TContext, TOutput> {
    return this._adapter;
  }

  get context(): TContext {
    return this._context;
  }

  get lastOutput(): TOutput | undefined {
    return this._lastOutput;
  }

  get formCode(): string {
    return this._adapter.formCode;
  }

  get formTitle(): string {
    return this._adapter.formTitle;
  }

  get capabilities(): AdapterCapabilities {
    return this._adapter.capabilities;
  }

  // ==========================================================================
  // ── CONVENIENCE CHAIN QUERIES ──────────────────────────────────────────────
  // ==========================================================================

  /**
   * Get all outputs for a specific form code in the current tax year.
   * Shorthand for ta.chain.getByForm(formCode, taxYear).
   */
  getOutputsForYear(formCode: string, year?: number): BaseFilingOutput[] {
    const taxYear = year ?? this._getTaxYear();
    return this._chain.getByForm(formCode, taxYear);
  }

  /**
   * Get the prior period outputs needed by the current adapter,
   * automatically resolved from the FilingChain.
   *
   * Returns outputs for all formCodes listed in
   * capabilities.requiredPriorFormCodes for the current tax year.
   */
  getRequiredPriorOutputs(): BaseFilingOutput[] {
    const required = this._adapter.capabilities.requiredPriorFormCodes ?? [];
    const taxYear = this._getTaxYear();
    const outputs: BaseFilingOutput[] = [];

    for (const formCode of required) {
      outputs.push(...this._chain.getByForm(formCode, taxYear));
    }

    return outputs;
  }

  // ==========================================================================
  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Pre-flight capability checks.
   * Returns an array of failure reasons — empty means all checks passed.
   * Never throws — callers decide what to do with the reasons.
   */
  private _runPreFlight(
    adapter: ITaxFormAdapter<any, any>,
    ctx: TContext,
  ): string[] {
    const reasons: string[] = [];
    const caps = adapter.capabilities;
    const profile = ctx.profile;

    if (!profile) {
      reasons.push("TaxpayerProfile is missing from context.");
      return reasons; // can't continue without profile
    }

    // ── Entity type check ─────────────────────────────────────────────────
    if (
      caps.validForEntityTypes &&
      caps.validForEntityTypes.length > 0 &&
      !caps.validForEntityTypes.includes(profile.entityType)
    ) {
      reasons.push(
        `Adapter "${caps.formCode}" is only valid for entity types ` +
          `[${caps.validForEntityTypes.join(", ")}]. ` +
          `Profile entity type is "${profile.entityType}".`,
      );
    }

    // ── Tax regime check ──────────────────────────────────────────────────
    if (
      caps.validForRegimes &&
      caps.validForRegimes.length > 0 &&
      !caps.validForRegimes.includes(profile.taxRegime)
    ) {
      reasons.push(
        `Adapter "${caps.formCode}" is only valid for tax regimes ` +
          `[${caps.validForRegimes.join(", ")}]. ` +
          `Profile tax regime is "${profile.taxRegime}". ` +
          `Note: Form 2551Q requires "percentage-tax" regime; ` +
          `Form 2550M/2550Q require "vat" regime.`,
      );
    }

    // ── Period context checks ─────────────────────────────────────────────
    if (caps.contextType === "period") {
      const pCtx = ctx as unknown as PeriodFilingContext;

      // Expenses required
      if (
        caps.requiresExpenses &&
        (!pCtx.expenses || pCtx.expenses.length === 0)
      ) {
        reasons.push(
          `Adapter "${caps.formCode}" requires expense entries ` +
            `(itemized deductions or input VAT computation) ` +
            `but none are present in the context.`,
        );
      }

      // Issued certificates required (payor role forms)
      if (
        caps.requiresIssuedCertificates &&
        (!pCtx.issuedCertificates || pCtx.issuedCertificates.length === 0)
      ) {
        reasons.push(
          `Adapter "${caps.formCode}" requires issued Form 2307 ` +
            `certificates (payor role) but none are present.`,
        );
      }

      // Required prior form codes — check FilingChain
      if (
        caps.requiredPriorFormCodes &&
        caps.requiredPriorFormCodes.length > 0
      ) {
        const taxYear = pCtx.taxYear;
        for (const requiredCode of caps.requiredPriorFormCodes) {
          // Check both the context's priorPeriodOutputs and the FilingChain
          const inContext = (pCtx.priorPeriodOutputs ?? []).some(
            (o) => o.formCode === requiredCode,
          );
          const inChain =
            this._chain.getByForm(requiredCode, taxYear).length > 0;

          if (!inContext && !inChain) {
            reasons.push(
              `Adapter "${caps.formCode}" requires prior output from ` +
                `form "${requiredCode}" but none found in context or ` +
                `FilingChain. Call ta.chain.add() or pass priorPeriodOutputs.`,
            );
          }
        }
      }
    }

    return reasons;
  }

  private _getTaxYear(): number {
    const ctx = this._context as unknown as PeriodFilingContext;
    return ctx.taxYear ?? new Date().getFullYear();
  }
}

// =============================================================================
// ── TAXACCOUNTANT ERROR ────────────────────────────────────────────────────────
// =============================================================================

export class TaxAccountantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxAccountantError";
  }
}

// =============================================================================
// ── ADAPTER REGISTRY ──────────────────────────────────────────────────────────
// =============================================================================

type AdapterFactory = () => ITaxFormAdapter<any, any>;

/**
 * Global registry mapping BIR form codes to adapter factory functions.
 *
 * Register adapters at app startup:
 * ```ts
 * AdapterRegistry.register("1701Q", () => new Form1701QAdapter());
 * AdapterRegistry.register("1701A", () => new Form1701AAdapter());
 * AdapterRegistry.register("2550M", () => new Form2550MAdapter());
 * ```
 *
 * Then resolve by form code:
 * ```ts
 * const adapter = AdapterRegistry.resolve("1701Q");
 * const ta = TaxAccountant.init({ adapter, context });
 * ```
 *
 * Or use TaxAccountant.for() as a shorthand:
 * ```ts
 * const ta = TaxAccountant.for("1701Q", context);
 * ```
 */
export class AdapterRegistry {
  private static readonly _registry = new Map<string, AdapterFactory>();

  /**
   * Register an adapter factory for a form code.
   * Overwrites any existing registration for the same code.
   */
  static register(formCode: string, factory: AdapterFactory): void {
    AdapterRegistry._registry.set(formCode.toUpperCase(), factory);
  }

  /**
   * Resolve an adapter by form code.
   * Returns a fresh adapter instance (factory is called each time).
   *
   * @throws {TaxAccountantError} if no adapter is registered for the code
   */
  static resolve(formCode: string): ITaxFormAdapter<any, any> {
    const factory = AdapterRegistry._registry.get(formCode.toUpperCase());
    if (!factory) {
      throw new TaxAccountantError(
        `No adapter registered for form code "${formCode}". ` +
          `Call AdapterRegistry.register("${formCode}", () => new YourAdapter()) ` +
          `before using this form code.`,
      );
    }
    return factory();
  }

  /**
   * Check if an adapter is registered for a form code.
   */
  static has(formCode: string): boolean {
    return AdapterRegistry._registry.has(formCode.toUpperCase());
  }

  /**
   * List all registered form codes.
   */
  static list(): string[] {
    return [...AdapterRegistry._registry.keys()].sort();
  }

  /**
   * Unregister an adapter. Primarily useful in tests.
   */
  static unregister(formCode: string): void {
    AdapterRegistry._registry.delete(formCode.toUpperCase());
  }

  /**
   * Clear all registrations. Primarily useful in tests.
   */
  static clear(): void {
    AdapterRegistry._registry.clear();
  }
}

// =============================================================================
// ── TAXACCOUNTANT.FOR() — registry shorthand ──────────────────────────────────
// =============================================================================

export const TaxAccountantStaticImpl = TaxAccountant as unknown as TaxAccountantStatic;

TaxAccountantStaticImpl.for = function <
  TContext extends BaseFilingContext,
  TOutput extends BaseFilingOutput,
>(
  formCode: string,
  context: TContext,
  options?: TaxAccountantOptions,
  chain?: FilingChain,
): TaxAccountant<TContext, TOutput> {
  const adapter = AdapterRegistry.resolve(formCode) as ITaxFormAdapter<
    TContext,
    TOutput
  >;

  return new TaxAccountant(adapter, context, options, chain);
};
