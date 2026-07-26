import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiSubprocessBackend } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { PiRpcBackend } from "@zihanw/pi-subagent-runtime/backends/rpc";
import { MiniHost, type MiniProfile } from "../examples/independent-host/mini-host.ts";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";
import {
	createPiInvocationFactory,
	normalizeProviderPayload,
	resolvePiCli,
	startMockProvider,
	writeFixtureModelsJson,
} from "./helpers/pi-e2e-fixture.ts";

/**
 * Independence proof against a REAL pi CLI: the MiniHost example drives
 * both process backends through its own compile → approval → execute flow,
 * and the provider-visible payloads, enforcement receipts, and retained
 * reports agree across backends. Skipped when no pi CLI is available.
 */

const PROVIDER = "pi-independent-host-e2e";
const MODEL_ID = "fixture-model";
const RESPONSE_TEXT = "Independent E2E complete.";

const PI_CLI = resolvePiCli();

const PROFILE: MiniProfile = {
	id: "mini-reviewer",
	model: { provider: PROVIDER, id: MODEL_ID },
	thinkingLevel: "high",
	instructions: "You are the MiniHost reviewer. Report only what the evidence shows.",
	tools: ["read", "grep", "find", "ls"],
};

test(
	"independent host prepares, approves, and executes the same plan on real pi children in both modes",
	{ skip: PI_CLI === undefined ? "pi CLI is not available" : false, timeout: 120_000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-host-e2e-"));
		const agentDir = join(root, "agent");
		const workDir = join(root, "work");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workDir, { recursive: true });

		const providerPayloads: Record<string, unknown>[] = [];
		const server = await startMockProvider(providerPayloads, {
			responseText: RESPONSE_TEXT,
			modelId: MODEL_ID,
		});
		const port = (server.address() as { port: number }).port;
		writeFixtureModelsJson(agentDir, { provider: PROVIDER, modelId: MODEL_ID, port });

		const invocationFactory = createPiInvocationFactory(PI_CLI!);
		const env = { PI_CODING_AGENT_DIR: agentDir };

		const { faux, modelRegistry } = await createFixturePiRuntime({
			provider: PROVIDER,
			api: "pi-independent-host-e2e-api",
			modelId: MODEL_ID,
			modelName: "Fixture E2E model",
		});
		faux.setResponses([
			() => {
				throw new Error("dry preparation must not reach this provider");
			},
		]);

		const subprocess = new PiSubprocessBackend({
			modelRegistry,
			cwd: workDir,
			invocationFactory,
			env,
		});
		const rpc = new PiRpcBackend({
			modelRegistry,
			cwd: workDir,
			invocationFactory,
			env,
		});
		const host = new MiniHost([subprocess, rpc]);

		try {
			// Host-owned plan parity across backends.
			const subprocessApproved = await host.prepare(
				PROFILE,
				"Review the independence fixture end to end.",
				subprocess.descriptor.id,
			);
			const rpcApproved = await host.prepare(
				PROFILE,
				"Review the independence fixture end to end.",
				rpc.descriptor.id,
			);
			assert.equal(host.verifyApproval(subprocessApproved.plan), true);
			assert.equal(host.verifyApproval(rpcApproved.plan), true);
			assert.equal(
				host.planCoreKey(rpcApproved.plan),
				host.planCoreKey(subprocessApproved.plan),
			);
			assert.equal(
				rpcApproved.prepared.conversationFingerprint,
				subprocessApproved.prepared.conversationFingerprint,
			);

			// Execute the approved plans on real pi children.
			const subprocessResult = await host.start(subprocessApproved).result;
			assert.equal(subprocessResult.status, "completed", JSON.stringify(subprocessResult));
			const rpcResult = await host.start(rpcApproved).result;
			assert.equal(rpcResult.status, "completed", JSON.stringify(rpcResult));

			// The sealed conversation reached the provider identically in both modes.
			assert.equal(providerPayloads.length, 2, "both children must reach the mock provider");
			const [subprocessPayload, rpcPayload] = providerPayloads.map(normalizeProviderPayload);
			assert.ok(subprocessPayload && rpcPayload);
			assert.deepEqual(rpcPayload, subprocessPayload);
			const sealed = subprocessApproved.plan.conversation;
			assert.equal(subprocessPayload.system, sealed.systemPrompt);
			assert.deepEqual(
				subprocessPayload.orderedContents,
				sealed.messages.map((message) =>
					message.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join(""),
				),
			);
			assert.deepEqual(subprocessPayload.tools, ["read", "grep", "find", "ls"]);
			assert.ok(
				!JSON.stringify(providerPayloads).includes("PI_SUBAGENT_RUNTIME_MARKER_"),
				"the unique marker must never reach the provider",
			);

			// Receipt and report parity.
			assert.equal(host.receiptKey(rpcResult), host.receiptKey(subprocessResult));
			if (subprocessResult.status === "completed" && rpcResult.status === "completed") {
				assert.equal(subprocessResult.output.text, RESPONSE_TEXT);
				assert.equal(rpcResult.output.text, RESPONSE_TEXT);
			}
			assert.equal(
				subprocess.takeReport(subprocessApproved.prepared.id)?.status,
				"completed",
			);
			assert.equal(rpc.takeReport(rpcApproved.prepared.id)?.status, "completed");
		} finally {
			await host.dispose();
			await subprocess.dispose();
			await rpc.dispose();
			modelRegistry.unregisterProvider(PROVIDER);
			server.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
