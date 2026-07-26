import {
	canonicalJson,
	conversationFingerprint,
	createExecutionRuntime,
	validateExecutionIntent,
	type ExecutionBackend,
	type ExecutionIntent,
	type ExecutionRuntime,
	type PreparedConversation,
	type PreparedRun,
	type PromptRuntime,
	type RunHandle,
	type RunResult,
	type SealedPlanSnapshot,
} from "@zihanw/pi-subagent-runtime";

/**
 * MiniHost — the smallest complete independent host for
 * @zihanw/pi-subagent-runtime.
 *
 * It owns everything a host is allowed to own: its own profile format,
 * its own prompt compilation, its own approval gate, and its own
 * cancellation/receipt handling. The runtime owns everything else:
 * preflight, plan sealing, lifecycle, and exactly-once settlement.
 *
 * No pi-forge modules, no Pi host singletons — every input is explicit.
 * Imports resolve through the published package surface only.
 */

export interface MiniProfile {
	id: string;
	model: { provider: string; id: string };
	thinkingLevel: NonNullable<ExecutionIntent["thinkingLevel"]>;
	/** Host-owned system instructions for the delegate. */
	instructions: string;
	/** Tool ids the host is willing to request for this profile. */
	tools: readonly string[];
}

export interface MiniApprovedRun {
	prepared: PreparedRun;
	/** The sealed approval artifact: everything the host may inspect. */
	plan: SealedPlanSnapshot;
}

export class MiniHost {
	readonly #runtime: ExecutionRuntime;

	constructor(backends: readonly ExecutionBackend[]) {
		this.#runtime = createExecutionRuntime();
		for (const backend of backends) {
			this.#runtime.registerBackend(backend);
		}
	}

	backendIds(): string[] {
		return this.#runtime.listBackends().map((descriptor) => descriptor.id);
	}

	/** Host policy: every delegation is read-only on a shared-user boundary. */
	intentFor(profile: MiniProfile): ExecutionIntent {
		return {
			model: { provider: profile.model.provider, id: profile.model.id },
			thinkingLevel: profile.thinkingLevel,
			requestedTools: [...profile.tools],
			access: {
				level: "read-only",
				executionBoundary: "shared-user",
				workspaces: [{ handle: "project", mode: "read-only" }],
				workingDirectory: { workspaceHandle: "project", path: "." },
				network: "allow",
			},
			limits: { timeoutMs: { value: 30_000, enforcement: "best-effort" } },
		};
	}

	/**
	 * Compiles and seals a plan for approval. Nothing executes: the returned
	 * snapshot is the complete approval artifact (system prompt, ordered
	 * prepared messages, effective tools, model, and fingerprints).
	 */
	async prepare(
		profile: MiniProfile,
		task: string,
		backendId: string,
	): Promise<MiniApprovedRun> {
		const intent = this.intentFor(profile);
		const diagnostics = validateExecutionIntent(intent);
		if (diagnostics.length > 0) {
			throw new Error(
				`MiniHost produced an invalid intent: ${diagnostics.map((item) => item.code).join(", ")}`,
			);
		}
		const prepared = await this.#runtime.prepare({
			backendId,
			intent,
			compile: async (runtime) => this.#compile(profile, task, runtime),
		});
		return { prepared, plan: prepared.snapshot() };
	}

	/**
	 * Host-owned prompt compilation. The host builds the exact system prompt
	 * and ordered messages from its own profile format; the runtime's
	 * PromptRuntime only contributes the negotiated tool surface.
	 */
	#compile(
		profile: MiniProfile,
		task: string,
		runtime: PromptRuntime,
	): PreparedConversation {
		const toolLines = runtime.options.selectedTools.map(
			(id) => `- ${id}: ${runtime.options.toolSnippets[id] ?? "available"}`,
		);
		return {
			systemPrompt: [
				profile.instructions,
				"",
				"You may use only these tools:",
				...toolLines,
			].join("\n"),
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Host standing instruction: answer tersely." },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Understood. I will answer tersely." },
					],
				},
				{ role: "user", content: [{ type: "text", text: task }] },
			],
		};
	}

	/**
	 * Approval gate: the host re-derives the conversation fingerprint from
	 * the snapshot it is about to approve. A tampered snapshot fails here,
	 * before any execution can be requested.
	 */
	verifyApproval(plan: SealedPlanSnapshot): boolean {
		return conversationFingerprint(plan.conversation) === plan.conversationFingerprint;
	}

	/** Starts an approved run. Cancel through the returned handle. */
	start(approved: MiniApprovedRun): RunHandle {
		return this.#runtime.execute(approved.prepared);
	}

	/** Releases a prepared run the approver rejected. */
	async discard(approved: MiniApprovedRun): Promise<void> {
		await approved.prepared.discard();
	}

	/** Canonical receipt key: equal across backends for equal enforcement. */
	receiptKey(result: RunResult): string {
		return canonicalJson(result.enforcement);
	}

	/**
	 * Backend-neutral view of a sealed plan: the host-owned core (schema,
	 * intent, conversation, effective tools) with backend-bound values
	 * (ids, preflight receipt, prompt runtime, fingerprints) removed.
	 */
	planCoreKey(plan: SealedPlanSnapshot): string {
		const {
			backendId: _backendId,
			preflightId: _preflightId,
			preparedRunId: _preparedRunId,
			preflight: _preflight,
			promptRuntime: _promptRuntime,
			conversationFingerprint: _conversationFingerprint,
			executionFingerprint: _executionFingerprint,
			...core
		} = plan;
		return canonicalJson(core);
	}

	async dispose(): Promise<void> {
		await this.#runtime.dispose();
	}
}
