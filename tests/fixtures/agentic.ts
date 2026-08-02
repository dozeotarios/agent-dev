/**
 * Fixture: a real interview with define-constraints for a task-tracker API —
 * the operator's curated answers (AC-MANUAL-5/6). Fed to ralplan Planner
 * input, deliberate-mode triggers, and the Reliability/Security reviewer
 * checklists (AC-REVIEW-5).
 */
export const TASK_TRACKER_CONSTRAINTS = {
  failureModes: ["API timeout", "disk full", "partial write"],
  edgeCases: ["empty input", "huge input", "concurrent access", "duplicate events"],
  invariants: ["data integrity always holds", "no secrets in logs", "consistent error shape"],
  mustNots: ["no hardcoded secrets", "never swallow errors", "no breaking API changes"],
} as const;

/** Vulnerable fixture for the Security-lens review eval (injected defects). */
export const VULNERABLE_FIXTURE = `
// fixture: login handler
const sql = \`SELECT * FROM users WHERE name = '\${userInput}' AND pass = '\${passInput}'\`;
db.query(sql);
const apiKey = "sk-live-1234567890abcdef";
`;
