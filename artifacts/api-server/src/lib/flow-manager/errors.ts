/** Structural rejection, not a substitute for the domain's live permission checks. */
export class FlowTransitionError extends Error {
  readonly status = 409;
  readonly code = "CASE_FLOW_HELD";
  constructor(readonly reason: string) {
    super(`Flow transition held: ${reason}`);
    this.name = "FlowTransitionError";
  }
}
