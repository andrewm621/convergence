/**
 * Context records for the shelter-intake scenario.
 *
 * Synthetic scenario. Not operational guidance. "Larkhaven County" and its river flood are invented for this
 * fixture, and "Larkhaven Mutual Aid Network" is a made-up volunteer group. Nothing here
 * describes a real place, event, organisation or person, and none of it is advice.
 */

export const SHELTER_INTAKE_CHECK = "checks/shelter-intake.check";

export const SHELTER_POLICY_PATH = "context/policies/shelter-intake-policy.md";
export const VOLUNTEER_ROLES_PATH = "context/roles/volunteer-roles.md";

const NOTE = "> Synthetic scenario. Not operational guidance. Larkhaven County and its river flood are fictional.";

const V1_FACETS = `facets:
  pets: "service animals only"
  id_required: "ID required"
  capacity_note: "Hall A holds 120 cots; the shift lead decides on overflow"
  hours: "doors open 7:00 to 21:00 daily"`;

/** v1: service animals only, ID required at intake. Carries a typo in the welcome text on purpose. */
export const SHELTER_POLICY_V1 = `---
id: shelter-intake-policy
version: 1
status: accepted
authority: shelter-coordinator
proposed_by: shelter-coordinator
accepted_by: shelter-coordinator
accepted_at: 2026-09-29T16:00:00Z
validation: ${SHELTER_INTAKE_CHECK}
${V1_FACETS}
---
# Shelter intake policy (Larkhaven Mutual Aid Network)

${NOTE}

Thank you for volunteering. Every neighbor who arrives should recieve a warm welcome and a calm, clear next step.

- Pets: service animals only.
- Identification: ID required.
- Capacity: Hall A holds 120 cots; the shift lead decides on overflow.
- Hours: doors open 7:00 to 21:00 daily.
`;

/** v1 with the typo in the welcome text fixed. Prose only: no facet moves, so nothing goes stale. */
export const SHELTER_POLICY_V1_TYPO_FIXED = SHELTER_POLICY_V1.replace("recieve", "receive");

/** v2: crated pets are admitted with a pet area in Hall B, and ID is no longer listed as a requirement. */
export const SHELTER_POLICY_V2 = `---
id: shelter-intake-policy
version: 2
status: accepted
authority: shelter-coordinator
proposed_by: shelter-coordinator
accepted_by: shelter-coordinator
accepted_at: 2026-10-13T16:00:00Z
supersedes: shelter-intake-policy@1
validation: ${SHELTER_INTAKE_CHECK}
facets:
  pets: "crated pets admitted, pet area in Hall B"
  id_required: "ID not listed as a requirement"
  capacity_note: "Hall A holds 120 cots; the shift lead decides on overflow"
  hours: "doors open 7:00 to 21:00 daily"
not:
  pets: "service animals only"
  id_required: "ID required"
---
# Shelter intake policy (Larkhaven Mutual Aid Network)

${NOTE}

In this fictional exercise, the policy record changes: crated pets are included; ID is no longer listed as a requirement.

- Pets: crated pets are included. The pet area is in Hall B.
- Identification: not listed as a requirement.
- Capacity: Hall A holds 120 cots; the shift lead decides on overflow.
- Hours: doors open 7:00 to 21:00 daily.
`;

/** v3: a later change to capacity only. Used to show a scoped exception lapsing on the next version. */
export const SHELTER_POLICY_V3 = `---
id: shelter-intake-policy
version: 3
status: accepted
authority: shelter-coordinator
proposed_by: shelter-coordinator
accepted_by: shelter-coordinator
accepted_at: 2026-10-14T09:00:00Z
supersedes: shelter-intake-policy@2
validation: ${SHELTER_INTAKE_CHECK}
facets:
  pets: "crated pets admitted, pet area in Hall B"
  id_required: "ID not listed as a requirement"
  capacity_note: "Hall A holds 120 cots; Hall C opens as overflow after 100 guests"
  hours: "doors open 7:00 to 21:00 daily"
not:
  capacity_note: "Hall A holds 120 cots; the shift lead decides on overflow"
---
# Shelter intake policy (Larkhaven Mutual Aid Network)

${NOTE}

In this fictional exercise, the policy record changes again: the capacity note now mentions an overflow hall.

- Pets: crated pets are included. The pet area is in Hall B.
- Identification: not listed as a requirement.
- Capacity: Hall A holds 120 cots; Hall C opens as overflow after 100 guests.
- Hours: doors open 7:00 to 21:00 daily.
`;

/** A second record that never changes in this scenario. */
export const VOLUNTEER_ROLES_V1 = `---
id: volunteer-roles
version: 1
status: accepted
authority: shelter-coordinator
proposed_by: shelter-coordinator
accepted_by: shelter-coordinator
accepted_at: 2026-09-29T16:00:00Z
facets:
  greeter: "welcomes each household at the main door and points them to the intake desk"
  intake_desk: "records first names and household size, and answers questions about the hall"
---
# Volunteer roles (Larkhaven Mutual Aid Network)

${NOTE}

Two roles cover the front of the hall. Greeters welcome people at the door. The intake desk keeps a simple list so that families can find each other.
`;
