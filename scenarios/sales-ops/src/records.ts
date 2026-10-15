/**
 * Context records for Scenario B. Sablewood is a fictional software company; nothing here
 * describes a real organisation or person.
 */

export const QUALIFIED_LEAD_CHECK = "checks/qualified-lead-criteria.check";
export const SALES_ACTIVITY_CHECK = "checks/sales-activity-glossary.check";

export const QUALIFIED_LEAD_PATH = "context/definitions/qualified-lead.md";
export const SALES_ACTIVITY_PATH = "context/definitions/sales-activity.md";

/** v1: a lead is qualified once it has filled the form and has 50 or more employees. */
export const QUALIFIED_LEAD_V1 = `---
id: qualified-lead
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-09-29T16:00:00Z
validation: ${QUALIFIED_LEAD_CHECK}
facets:
  lead.qualified.criteria: form-fill-and-50-plus-employees
  lead.qualified.min-employees: 50
  lead.qualified.requires-form-fill: true
---
# Qualified lead (Sablewood)
A lead is qualified when it has submitted the web form and the company has 50 or more employees.
`;

/** v1 with the prose reworded. No facet moves. */
export const QUALIFIED_LEAD_V1_REWORDED = QUALIFIED_LEAD_V1.replace(
	"submitted the web form and the company has 50 or more employees",
	"submitted the web form and the company has at least 50 employees",
);

/** v2: adds a verified budget signal to the definition. */
export const QUALIFIED_LEAD_V2 = `---
id: qualified-lead
version: 2
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T16:00:00Z
supersedes: qualified-lead@1
validation: ${QUALIFIED_LEAD_CHECK}
facets:
  lead.qualified.criteria: form-fill-50-plus-employees-and-verified-budget
  lead.qualified.min-employees: 50
  lead.qualified.requires-form-fill: true
  lead.qualified.verified-budget-signal: required
not:
  lead.qualified.criteria: form-fill-and-50-plus-employees
---
# Qualified lead (Sablewood)
A lead is qualified when it has submitted the web form, the company has 50 or more employees, and a verified budget signal exists.
`;

export const SALES_ACTIVITY_V1 = `---
id: sales-activity
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-09-29T16:00:00Z
validation: ${SALES_ACTIVITY_CHECK}
facets:
  activity.touch.types: [call, email, meeting]
  activity.counts-as-touch: outbound-human-contact
---
# Sales activity (Sablewood)
A touch is an outbound call, email or meeting made by a person. Automated sequences do not count.
`;
