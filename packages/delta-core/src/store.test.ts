import { describeStoreConformance } from "./testing/store-conformance";
import { notifications, stores } from "./testing/scenarios";

for (const [label, makeStore] of stores) {
	describeStoreConformance(label, makeStore, {
		seed: notifications.seed,
		policy: notifications.policy,
		events: [notifications.events.registerWi1, notifications.events.registerWi2, notifications.events.wi1Pushed, notifications.events.v2],
	});
}
