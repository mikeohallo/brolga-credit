// The investigator's vocabulary. Diagnoses and next steps are fixed labels, not
// prose, so that a briefing can be scored by comparison: the expected label on a
// labelled case either matches what the model chose or it doesn't. The prose
// around a label is for the operator; the label is for the report.

export type ExceptionType =
  | "timeout" // a request got no answer; the outcome is unknown until the provider says
  | "duplicate" // a duplicate notification versus a duplicate payment (slice 2)
  | "orphan_provider_record" // the provider holds a record Brolga has no match for (slice 2)
  | "late_cop_failure" // a name check fails after the loan was written (slice 2)
  | "returned_payout" // the debit cleared, the credit came back (slice 2)
  | "amount_mismatch"; // the app's amount and the provider's disagree (slice 2)

export const EXCEPTION_TYPES: Record<ExceptionType, { code: string; title: string }> = {
  timeout: { code: "T1", title: "Unknown outcome after a timeout" },
  duplicate: { code: "T2", title: "Duplicate notification or duplicate payment" },
  orphan_provider_record: { code: "T3", title: "Provider record with no matching app record" },
  late_cop_failure: { code: "T4", title: "Name check fails after the loan was written" },
  returned_payout: { code: "T5", title: "Returned payout" },
  amount_mismatch: { code: "T6", title: "Amount mismatch between app and provider" },
};

/**
 * What the investigator can conclude about a payment. "outcome_unknown" is a
 * conclusion in its own right: the records do not establish what happened, and
 * saying so is the correct answer, not a failure to answer.
 */
export type Diagnosis =
  | "outcome_unknown"
  | "settled_at_provider"
  | "pending_at_provider"
  | "failed_at_provider"
  | "never_reached_provider";

export const DIAGNOSES: Record<Diagnosis, string> = {
  outcome_unknown: "The records do not establish whether the payment exists at the provider or what state it is in.",
  settled_at_provider: "The provider holds the payment and reports it settled: the money has moved.",
  pending_at_provider: "The provider holds the payment and it is still in progress; nothing is final yet.",
  failed_at_provider: "The provider holds the payment and reports it failed, with a reason code.",
  never_reached_provider: "The provider has no record of the request; it never arrived, so no money moved.",
};

/** What should happen next. "insufficient_evidence" means: get the named record first; decide after. */
export type NextStep =
  | "insufficient_evidence"
  | "adopt_provider_record"
  | "resend_same_intent"
  | "retry_payment"
  | "wait_for_provider"
  | "escalate";

export const NEXT_STEPS: Record<NextStep, string> = {
  insufficient_evidence: "Do not act yet. Obtain the record that would settle it (the provider's view of the exact payment), then decide.",
  adopt_provider_record: "Record the provider's state against the instalment; do not send anything. The payment exists.",
  resend_same_intent: "Send the request again with the same payment identifier; the provider has no record of it, so this cannot pay twice.",
  retry_payment: "Retry the failed payment through the provider's retry, with the same identifier.",
  wait_for_provider: "Nothing to do yet; refresh when the provider has resolved the payment.",
  escalate: "A person with more context must decide; the records conflict in a way the desk cannot resolve.",
};

export function isDiagnosis(s: unknown): s is Diagnosis {
  return typeof s === "string" && s in DIAGNOSES;
}

export function isNextStep(s: unknown): s is NextStep {
  return typeof s === "string" && s in NEXT_STEPS;
}
