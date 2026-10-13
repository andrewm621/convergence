/**
 * The drafts that the five agents produce. Plain text standing in for volunteer materials.
 *
 * Synthetic scenario. Not operational guidance. Every document is invented for this fixture.
 */

export const SCRIPT_PATH = "scripts/front-desk.md";
export const SIGNAGE_PATH = "signs/door.md";
export const BRIEFING_PATH = "briefing/one-pager.md";
export const SUPPLIES_PATH = "supplies/cots-and-blankets.md";
export const SCHEDULE_PATH = "schedule/shifts.md";

const NOTE = "Synthetic scenario. Not operational guidance.";

/** Built on shelter-intake-policy@1. */
export const SCRIPT_V1 = `# Front-desk intake script

${NOTE}

1. Greeting: the household is welcomed and offered water and a seat.
2. Intake: ID required. First names and household size are noted.
3. Pets: service animals only.
4. Cots: Hall A.
`;

/** Rewritten against shelter-intake-policy@2. */
export const SCRIPT_V2 = `# Front-desk intake script

${NOTE}

1. Greeting: the household is welcomed and offered water and a seat.
2. Intake: ID is not listed as a requirement. First names and household size are noted.
3. Pets: crated pets are included. The pet area is in Hall B.
4. Cots: Hall A.
`;

/** Built on shelter-intake-policy@1. Stays as it is in the story: the printed signs are already posted. */
export const SIGNAGE_V1 = `# Door signage text

${NOTE}

WELCOME TO THE SHELTER
Service animals only.
ID required at the front desk.
Doors open 7:00 to 21:00 daily.
`;

/** Built on shelter-intake-policy@1. */
export const BRIEFING_V1 = `# Volunteer briefing one-pager

${NOTE}

- Doors open 7:00 to 21:00 daily.
- Pets: service animals only. ID required at the front desk.
- Greeters welcome people at the door. The intake desk keeps the list.
`;

/** Rewritten against shelter-intake-policy@2. */
export const BRIEFING_V2 = `# Volunteer briefing one-pager

${NOTE}

- Doors open 7:00 to 21:00 daily.
- Pets: crated pets are included; the pet area is in Hall B. ID is not listed as a requirement.
- Greeters welcome people at the door. The intake desk keeps the list.
`;

/** Depends on capacity only. Never touched by the pets or ID change. */
export const SUPPLIES_V1 = `# Supply list: cots and blankets

${NOTE}

- 120 cots for Hall A.
- One blanket per cot, plus 20 spare.
- Two folding tables for the intake desk.
`;

/** Depends on volunteer roles and hours. Never touched by the pets or ID change. */
export const SCHEDULE_V1 = `# Shift schedule

${NOTE}

Doors open 7:00 to 21:00 daily.

| Shift | Greeters | Intake desk |
| --- | --- | --- |
| 7:00 to 14:00 | 2 | 2 |
| 14:00 to 21:00 | 2 | 2 |
`;
