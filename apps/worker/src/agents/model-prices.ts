// Worst-case prices for the models a run may be pinned to. The gateway uses them to reserve cost before a call
// and to charge a call whose usage is unknown or whose reported cost is missing or unusable. A model with no
// entry here cannot run in claude mode: with no price there is no worst case to charge, so the gateway refuses it.
//
// Dollars per million tokens, taken from OpenRouter's model list (2026-10). Each figure is the highest rate that
// can apply to that model: the input rate is the larger of the prompt, cache-write and long-prompt override
// rates; the output rate is the larger of the completion and long-prompt override rates. Update an entry here
// when a model is added to AGENT_MODELS; an out-of-date price only makes the fallback cost wrong, not the real
// cost, which comes from the `usage.cost` OpenRouter reports whenever it is present.

/** Stand-in dollar figure for a call that cannot be priced; far above any run cap. */
const UNPRICEABLE_USD = 1e6;

export interface ModelPrice {
	/** Dollars per million input tokens (highest applicable rate). */
	inPerM: number;
	/** Dollars per million output tokens (highest applicable rate). */
	outPerM: number;
}

const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	"openai/gpt-6-luna": { inPerM: 0.1, outPerM: 0.5 },
	"z-ai/glm-5.3-flash": { inPerM: 0.0261, outPerM: 0.9 },
	"minimax/minimax-m3": { inPerM: 0.3, outPerM: 1.2 },
	"anthropic/claude-sonnet-5.5": { inPerM: 4, outPerM: 10 },
};

/** The price for an exact slug, or null when the model is unknown (own-property lookup only). */
export function modelPrice(slug: string): ModelPrice | null {
	return Object.hasOwn(MODEL_PRICES, slug) ? MODEL_PRICES[slug]! : null;
}

/** Dollars for a call at the given token counts (never negative; a NaN or infinite input gives a huge figure so it fails closed). */
export function priceTokens(price: ModelPrice, inputTokens: number, outputTokens: number): number {
	if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return UNPRICEABLE_USD;
	return (inputTokens * price.inPerM + outputTokens * price.outPerM) / 1_000_000;
}
