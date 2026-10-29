// The investigator's vocabulary. Diagnoses and next steps are fixed labels, not
// prose, so that a briefing can be scored by comparison: the expected label on a
// labelled case either matches what the model chose or it doesn't. The prose
// around a label is for the operator; the label is for the report.
//
// Rule for the test set: every case has exactly one right next step by
// definition. Where two labels could both fit one situation, the definitions
// below are drawn so that only one does (see "wait_for_provider").

export type ExceptionType =
  | "timeout" // a request got no answer; the outcome is unknown until the provider says
  | "duplicate" // a duplicate notification versus a duplicate payment
  | "orphan_provider_record" // the provider holds a record Brolga has no match for
  | "late_cop_failure" // a name check fails after the loan was written
  | "returned_payout" // the debit cleared, the credit came back
  | "amount_mismatch"; // the app's amount and the provider's disagree

export const EXCEPTION_TYPES: Record<ExceptionType, { code: string; title: string }> = {
  timeout: { code: "T1", title: "Unknown outcome after a timeout" },
  duplicate: { code: "T2", title: "Duplicate notification or duplicate payment" },
  orphan_provider_record: { code: "T3", title: "Provider record with no matching app record" },
  late_cop_failure: { code: "T4", title: "Name check fails after the loan was written" },
  returned_payout: { code: "T5", title: "Returned payout" },
  amount_mismatch: { code: "T6", title: "Amount mismatch between app and provider" },
};

/**
 * What the investigator can conclude. "outcome_unknown" is a conclusion in its
 * own right: the records do not establish what happened, and saying so is the
 * correct answer, not a failure to answer. Labels are shared across types.
 */
export type Diagnosis =
  // the state of one payment
  | "outcome_unknown"
  | "settled_at_provider"
  | "pending_at_provider"
  | "failed_at_provider"
  | "never_reached_provider"
  // duplicates
  | "single_payment_duplicate_notification"
  | "duplicate_payment"
  | "payments_as_scheduled"
  // records the app has no match for
  | "provider_record_is_ours"
  | "unexplained_provider_record"
  | "record_belongs_elsewhere"
  | "records_agree"
  // the name check (Confirmation of Payee)
  | "payee_check_failed_before_money"
  | "payee_check_failed_after_money"
  | "payee_check_unavailable"
  | "payee_check_overridden"
  | "payee_check_passed"
  // payouts
  | "payout_returned"
  | "payout_returned_reversal_pending"
  | "payout_cleared"
  // amounts
  | "amount_mismatch_provider_truth";

export const DIAGNOSES: Record<Diagnosis, string> = {
  outcome_unknown: "The records do not establish what the provider holds for the payment in question, or what state it is in.",
  settled_at_provider: "The provider holds the payment and reports it settled: the money has moved.",
  pending_at_provider: "The provider holds the payment and it is still in progress; nothing is final yet.",
  failed_at_provider: "The provider holds the payment and reports it failed, with a reason code.",
  never_reached_provider: "The provider has no record of the request; it never arrived, so no money moved.",
  single_payment_duplicate_notification: "One payment exists at the provider; the app recorded the same settlement more than once. Nothing was collected twice.",
  duplicate_payment: "Two payments exist at the provider for the same instalment; the borrower was collected from twice.",
  payments_as_scheduled: "The payments the provider holds are the scheduled instalments, each once; there is no duplicate.",
  provider_record_is_ours: "The provider's record belongs to this loan: the app sent it and lost track of it, so the app is behind the provider.",
  unexplained_provider_record: "The provider holds a record on this loan's agreement or account that the app never made and nothing in the records explains.",
  record_belongs_elsewhere: "The provider record in question belongs to a different loan; this loan's records are complete.",
  records_agree: "The app's records and the provider's agree with each other; the discrepancy is in what someone said, not in the records.",
  payee_check_failed_before_money: "The name check returned no match or a closed account before any money moved; the hold is in force.",
  payee_check_failed_after_money: "The name check failed after the money had already cleared; there is nothing to hold, and a possibly misdirected payment to raise.",
  payee_check_unavailable: "The name check could not be performed; that is not a failed match and not a passed one.",
  payee_check_overridden: "A named person recorded an override with a reason; the hold is lifted although the check itself did not match.",
  payee_check_passed: "The name check matched (or closely matched, which the desk's policy treats as verified); there is no hold.",
  payout_returned: "The borrower's bank returned the payout and the reversal back to the lender has cleared; the money is back.",
  payout_returned_reversal_pending: "The borrower's bank returned the payout; the reversal back to the lender has not yet been seen.",
  payout_cleared: "The borrower-side credit cleared; the money arrived in the borrower's account.",
  amount_mismatch_provider_truth: "The amount the provider holds (on the payment or the agreement) differs from the app's figure; the provider's amount is what governs, and the app's figure is the one to correct.",
};

/** What should happen next. Exactly one label fits a case by definition. */
export type NextStep =
  | "insufficient_evidence"
  | "adopt_provider_record"
  | "resend_same_intent"
  | "retry_payment"
  | "wait_for_provider"
  | "no_action"
  | "refund_duplicate"
  | "hold_disbursement"
  | "reverify_payee"
  | "escalate";

export const NEXT_STEPS: Record<NextStep, string> = {
  insufficient_evidence: "Do not act yet. Obtain the record that would settle it (the provider's view of the exact payment, agreement or transaction), then decide.",
  adopt_provider_record: "The provider's record is the truth and the app is behind it: record the provider's state, amount or existence against the app's instalment, loan or schedule. Send nothing.",
  resend_same_intent: "Send the request again with the same payment identifier; the provider has no record of it, so this cannot pay twice.",
  retry_payment: "Retry the failed payment through the provider's retry, with the same identifier.",
  wait_for_provider: "The app already matches the provider and the payment is still in progress at the provider; there is nothing to record. Refresh later.",
  no_action: "The records agree and nothing is owed either way; the question was a false alarm. Answer the person who raised it; change nothing.",
  refund_duplicate: "One instalment was collected twice; the second collection must be returned to the borrower.",
  hold_disbursement: "Keep the loan on hold: no money moves until a named person records an override with a reason, or the borrower supplies an account that passes the check.",
  reverify_payee: "Run the name check again (and obtain corrected account details if it fails) before any payment is sent to this payee.",
  escalate: "A person with more context must decide: a payment may have gone somewhere it should not have, or the records conflict in a way the desk cannot resolve.",
};

export function isDiagnosis(s: unknown): s is Diagnosis {
  return typeof s === "string" && s in DIAGNOSES;
}

export function isNextStep(s: unknown): s is NextStep {
  return typeof s === "string" && s in NEXT_STEPS;
}
