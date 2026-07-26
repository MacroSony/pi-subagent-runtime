import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Shared hermetic Pi preparation fixture: a faux provider wired through a
 * network-disabled ModelRuntime so backend SDK preparation sees the exact
 * prompt without ever reaching a real provider.
 */
export interface FixturePiRuntimeOptions {
	provider: string;
	api: string;
	modelId: string;
	modelName?: string;
}

export async function createFixturePiRuntime(options: FixturePiRuntimeOptions): Promise<{
	faux: ReturnType<typeof createFauxCore>;
	modelRuntime: ModelRuntime;
	modelRegistry: ModelRegistry;
}> {
	const faux = createFauxCore({
		api: options.api,
		provider: options.provider,
		models: [
			{ id: options.modelId, name: options.modelName ?? "Fixture", reasoning: true },
		],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(options.provider, {
		api: options.api,
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-key",
		streamSimple: (
			model: Model<any>,
			context: Context,
			streamOptions?: SimpleStreamOptions,
		) => faux.streamSimple(model, context, streamOptions),
		models: [
			{
				id: options.modelId,
				name: options.modelName ?? "Fixture model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 4_000,
			},
		],
	});
	return { faux, modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}
