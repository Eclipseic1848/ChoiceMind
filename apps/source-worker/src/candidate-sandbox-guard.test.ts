import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { startCandidateSupervisor } from "./candidate-sandbox-guard.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const id = "a".repeat(64);
let child: EventEmitter & {
	kill: ReturnType<typeof vi.fn>;
	unref: ReturnType<typeof vi.fn>;
	channel: { unref: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
	vi.useFakeTimers();
	child = Object.assign(new EventEmitter(), {
		kill: vi.fn(),
		unref: vi.fn(),
		channel: { unref: vi.fn() },
	});
	vi.mocked(spawn).mockReturnValue(
		child as unknown as ReturnType<typeof spawn>,
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

it("错误容器的心跳不能开门，未就绪超时拒绝并清理子进程", async () => {
	const pending = startCandidateSupervisor(id, Date.now() + 1000);
	const rejected = expect(pending).rejects.toThrow(
		"CANDIDATE_SUPERVISION_UNAVAILABLE",
	);
	child.emit("message", { type: "HEALTHY", containerId: "b".repeat(64) });
	await vi.advanceTimersByTimeAsync(1000);
	await rejected;
	expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it.each(["exit", "silence"])(
	"就绪后 %s 会撤销执行许可，健康心跳可续期",
	async (failure) => {
		const pending = startCandidateSupervisor(id, Date.now() + 30_000);
		child.emit("message", { type: "HEALTHY", containerId: id });
		const guard = await pending;
		expect(guard.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(4000);
		child.emit("message", { type: "HEALTHY", containerId: id });
		await vi.advanceTimersByTimeAsync(4000);
		expect(guard.signal.aborted).toBe(false);
		if (failure === "exit") child.emit("exit", 1);
		else await vi.advanceTimersByTimeAsync(1000);
		expect(guard.signal.aborted).toBe(true);
		guard.stop();
		expect(vi.getTimerCount()).toBe(0);
	},
);
