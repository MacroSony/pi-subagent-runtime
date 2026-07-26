import assert from "node:assert/strict";
import test from "node:test";
import { PiSubprocessBackend } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { PiRpcBackend } from "@zihanw/pi-subagent-runtime/backends/rpc";
import { MiniHost, type MiniProfile } from "../examples/independent-host/mini-host.ts";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";

/**
 * Independence proof: a non-Forge host drives the shipped package surface
 * (imports resolve through the package name to dist/) through the full
 * compile → plan → approval → execute lifecycle on BOTH process backends,
 * with plan parity, receipt parity, rejection, and cancellation.
 */

const PROVIDER = "pi-independent-host-fixture";
const API = "pi-independent-host-api";
const MODEL_ID = "fixture-model";
const OUTPUT_TEXT = "Independent host fixture complete.";

const PROFILE: MiniProfile = {
	id: "mini-reviewer",
	model: { provider: PROVIDER, id: MODEL_ID },
	thinkingLevel: "high",
	instructions: "You are the MiniHost reviewer. Report only what the evidence shows.",
	tools: ["read", "grep", "find", "ls"],
};

test("independent host: one approved plan shape runs identically on both process backends", async () => {
	const { faux, modelRegistry } = await createFixturePiRuntime({
		provider: PROVIDER,
		api: API,
		modelId: MODEL_ID,
	});
	faux.setResponses([
		() => {
			throw new Error("dry preparation must not reach this provider");
		},
	]);

	const subprocess = new PiSubprocessBackend({
		modelRegistry,
		cwd: process.cwd(),
		invocationFactory: () => ({
			command: process.execPath,
			args: ["--input-type=module", "-e", scriptedSubprocessChild()],
		}),
	});
	const rpc = new PiRpcBackend({
		modelRegistry,
		cwd: process.cwd(),
		invocationFactory: () => ({
			command: process.execPath,
			args: ["--input-type=module", "-e", scriptedRpcChild()],
		}),
	});
	const host = new MiniHost([subprocess, rpc]);

	try {
		assert.deepEqual(host.backendIds().sort(), ["pi-rpc-readonly", "pi-subprocess-readonly"]);

		// Plan on both backends: the host-owned core must be identical.
		const approved = new Map<string, Awaited<ReturnType<MiniHost["prepare"]>>>();
		for (const backendId of host.backendIds()) {
			const candidate = await host.prepare(PROFILE, "Review the independence fixture.", backendId);
			assert.equal(host.verifyApproval(candidate.plan), true, backendId);
			assert.equal(candidate.plan.intent.model.provider, PROVIDER);
			assert.deepEqual(
				candidate.plan.effectiveTools.map((tool) => tool.requestedName),
				["read", "grep", "find", "ls"],
				backendId,
			);
			assert.deepEqual(
				candidate.plan.effectiveTools.map((tool) => tool.backendToolId),
				["pi.read", "pi.grep", "pi.find", "pi.ls"],
				backendId,
			);
			assert.match(candidate.plan.conversation.systemPrompt, /MiniHost reviewer/);
			assert.match(candidate.plan.conversation.systemPrompt, /- read:/);
			assert.equal(candidate.plan.conversation.messages.length, 3);
			approved.set(backendId, candidate);
		}
		const subprocessPlan = approved.get("pi-subprocess-readonly")!;
		const rpcPlan = approved.get("pi-rpc-readonly")!;
		assert.equal(host.planCoreKey(rpcPlan.plan), host.planCoreKey(subprocessPlan.plan));
		assert.equal(rpcPlan.prepared.conversationFingerprint, subprocessPlan.prepared.conversationFingerprint);
		assert.notEqual(rpcPlan.prepared.executionFingerprint, subprocessPlan.prepared.executionFingerprint);

		// Approval integrity: a tampered snapshot fails the host gate.
		const tampered = structuredClone(rpcPlan.plan);
		(tampered.conversation.messages[2]!.content[0] as { text: string }).text = "Approved behind the host's back.";
		assert.equal(host.verifyApproval(tampered), false);

		// Execute on both backends: identical output and equal receipts.
		const results = new Map<string, Awaited<ReturnType<MiniHost["start"]>["result"]>>();
		for (const [backendId, candidate] of approved) {
			const handle = host.start(candidate);
			const result = await handle.result;
			assert.equal(result.status, "completed", `${backendId}: ${JSON.stringify(result)}`);
			assert.equal(result.runId, handle.id);
			assert.equal(result.preparedRunId, candidate.prepared.id);
			results.set(backendId, result);
		}
		const subprocessResult = results.get("pi-subprocess-readonly")!;
		const rpcResult = results.get("pi-rpc-readonly")!;
		if (subprocessResult.status === "completed" && rpcResult.status === "completed") {
			assert.equal(rpcResult.output.text, subprocessResult.output.text);
			assert.equal(subprocessResult.output.text, OUTPUT_TEXT);
		}
		assert.equal(host.receiptKey(rpcResult), host.receiptKey(subprocessResult));
		assert.deepEqual(rpcResult.effectiveToolIds, subprocessResult.effectiveToolIds);

		// Backend-specific retained reports agree on the host-visible surface.
		const subprocessReport = subprocess.takeReport(subprocessPlan.prepared.id);
		const rpcReport = rpc.takeReport(rpcPlan.prepared.id);
		assert.ok(subprocessReport && rpcReport);
		assert.equal(subprocessReport.status, "completed");
		assert.equal(rpcReport.status, "completed");
		assert.equal(rpcReport.executionBoundary, subprocessReport.executionBoundary);
		assert.deepEqual(rpcReport.effectiveToolNames, subprocessReport.effectiveToolNames);
	} finally {
		await host.dispose();
		await subprocess.dispose();
		await rpc.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
	}
});

test("independent host: rejection discards and cancellation settles a running child", async () => {
	const { faux, modelRegistry } = await createFixturePiRuntime({
		provider: PROVIDER,
		api: API,
		modelId: MODEL_ID,
	});
	faux.setResponses([
		() => {
			throw new Error("dry preparation must not reach this provider");
		},
	]);

	const rpc = new PiRpcBackend({
		modelRegistry,
		cwd: process.cwd(),
		invocationFactory: () => ({
			command: process.execPath,
			args: ["--input-type=module", "-e", scriptedRpcChild({ hang: true })],
		}),
	});
	const host = new MiniHost([rpc]);

	try {
		// Rejection path: discard releases the prepared run; execution is then impossible.
		const rejected = await host.prepare(PROFILE, "This run is not approved.", rpc.descriptor.id);
		assert.equal(host.verifyApproval(rejected.plan), true);
		await host.discard(rejected);
		assert.throws(() => host.start(rejected), /unbound|discarded/i);

		// Cancellation path: the host cancels a running child through the handle.
		const approved = await host.prepare(PROFILE, "Hang until cancelled.", rpc.descriptor.id);
		const handle = host.start(approved);
		setTimeout(() => void handle.cancel("host changed its mind"), 50);
		const result = await handle.result;
		assert.equal(result.status, "cancelled", JSON.stringify(result));
		if (result.status === "cancelled") {
			assert.match(result.reason, /host changed its mind/);
		}
		assert.equal(result.preparedRunId, approved.prepared.id);
	} finally {
		await host.dispose();
		await rpc.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
	}
});

function scriptedSubprocessChild(): string {
	return `const { writeSync } = await import("node:fs");
for (const event of ${JSON.stringify(fixtureFd3Events())}) writeSync(3, JSON.stringify(event) + "\\n");
`;
}

function scriptedRpcChild(options: { hang?: boolean } = {}): string {
	const fd3Events = fixtureFd3Events();
	return `
const { writeSync } = await import("node:fs");
let buffer = "";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      send({ type: "response", command: "prompt", id: command.id, success: true });
      send({ type: "agent_start" });
      for (const event of ${JSON.stringify(fd3Events)}) writeSync(3, JSON.stringify(event) + "\\n");
      if (${options.hang === true}) {
        setInterval(() => undefined, 1_000);
      } else {
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_settled" });
      }
    } else if (command.type === "abort") {
      send({ type: "response", command: "abort", id: command.id, success: true });
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled" });
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
`;
}

function fixtureFd3Events(): unknown[] {
	return [
		{
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "fixture source" }],
				isError: false,
				timestamp: 1,
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: OUTPUT_TEXT }],
				api: API,
				provider: PROVIDER,
				model: MODEL_ID,
				usage: {
					input: 12,
					output: 6,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 18,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
}
