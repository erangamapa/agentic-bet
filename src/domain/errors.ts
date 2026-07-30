/** Base for every error the system raises deliberately (as opposed to a crash). */
export class AppError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(code: string, message: string, opts: { detail?: Record<string, unknown>; httpStatus?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = opts.detail ?? {};
    this.httpStatus = opts.httpStatus ?? 400;
  }
}

/**
 * Raised when an agent is constructed with a tool above its clearance, or when
 * a privileged tool factory is called without a valid grant. This is a
 * programming error and must fail loudly at startup, never be swallowed.
 */
export class PrivilegeViolationError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('privilege_violation', message, { detail, httpStatus: 500 });
  }
}

/** A risk rule (stake, odds, daily cap, open-bet count) refused the bet. */
export class RiskRuleError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('risk_rule_violation', message, { detail, httpStatus: 422 });
  }
}

/** No valid, unconsumed, matching user confirmation exists for this bet. */
export class ConfirmationRequiredError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('confirmation_required', message, { detail, httpStatus: 428 });
  }
}

/** The transaction was broadcast but did not reach a confirmed state. */
export class ExecutionNotConfirmedError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('execution_not_confirmed', message, { detail, httpStatus: 502 });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('not_found', message, { detail, httpStatus: 404 });
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('configuration_error', message, { detail, httpStatus: 500 });
  }
}

export function toErrorPayload(err: unknown): { code: string; message: string; detail: Record<string, unknown> } {
  if (err instanceof AppError) return { code: err.code, message: err.message, detail: err.detail };
  return { code: 'internal_error', message: err instanceof Error ? err.message : String(err), detail: {} };
}
