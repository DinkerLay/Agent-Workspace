export class AcpBoundaryError extends Error {
  readonly code: string;
  readonly diagnosticCode?: string;

  constructor(code: string, diagnosticCode?: string) {
    super(code);
    this.name = "AcpBoundaryError";
    this.code = code;
    if (diagnosticCode !== undefined
      && diagnosticCode !== code
      && /^acp_[a-z0-9_]{1,120}$/u.test(diagnosticCode)) {
      this.diagnosticCode = diagnosticCode;
    }
  }
}

export function failAcp(code: string, diagnosticCode?: string): never {
  throw new AcpBoundaryError(code, diagnosticCode);
}
