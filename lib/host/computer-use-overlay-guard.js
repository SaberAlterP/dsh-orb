import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.js";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
//#region lib/types/computer-use-overlay-guard.js
/**
* Desktop Host Cordis service that cloaks the Electron overlay around Computer Use capture and HID.
* @module @deepseek-ai/dsh-desktop-host/computer-use-overlay-guard
*/
var computer_use_overlay_guard_exports = /* @__PURE__ */ __exportAll({
	OVERLAY_GUARD_ACK_TIMEOUT_MS: () => OVERLAY_GUARD_ACK_TIMEOUT_MS,
	OVERLAY_GUARD_INPUT_DRAIN_MS: () => 80,
	SCK_CAPTURE_ACK_TIMEOUT_MS: () => SCK_CAPTURE_ACK_TIMEOUT_MS,
	apply: () => apply,
	clearOverlayGuardTransport: () => clearOverlayGuardTransport,
	completeObservationFrameAck: () => completeObservationFrameAck,
	completeOverlayGuardAck: () => completeOverlayGuardAck,
	completeSckCaptureAck: () => completeSckCaptureAck,
	createComputerUseOverlayGuard: () => createComputerUseOverlayGuard,
	name: () => name,
	setOverlayGuardTransport: () => setOverlayGuardTransport
});
/** Milliseconds to wait for Electron's overlay-guard ack before failing the Computer Use call. */
const OVERLAY_GUARD_ACK_TIMEOUT_MS = 1e3;
/** Milliseconds to wait for Electron's overlay-exclude capture ack. Screen Recording prompts can appear. */
const SCK_CAPTURE_ACK_TIMEOUT_MS = 3e4;
/** Milliseconds Host waits after HID returns before sending input end, so WindowServer finishes hit-testing posted CGEvents. */
const OVERLAY_GUARD_INPUT_DRAIN_MS = 80;
/** Cordis plugin name matching the Desktop overlay YAML id. */
const name = "computer-use-overlay-guard";
let nextRequestId = 1;
let transportSend;
const pendingExclude = /* @__PURE__ */ new Map();
const pendingFrame = /* @__PURE__ */ new Map();
const pendingSck = /* @__PURE__ */ new Map();
/** Nested withInput / withCapture share one Electron cloak; only depth 0 sends begin/end. */
let inputDepth = 0;
let captureDepth = 0;
let activeExcludeWindowIds = [];
/** Turn signals that already send observation-frame hide on abort; recapture reuses one controller. */
const armedObservationFrameAbort = /* @__PURE__ */ new WeakSet();
function resetOverlayGuardDepths() {
	inputDepth = 0;
	captureDepth = 0;
	activeExcludeWindowIds = [];
}
function errorOf(reason, fallback) {
	return reason instanceof Error ? reason : new Error(fallback);
}
/**
* Install the Host → Electron sender used by {@link apply}.
* `main` calls this before Cordis boot so Computer Use can cloak after `ready`.
* @param send - `process.send` wrapper that already handles a closed IPC channel.
*/
function setOverlayGuardTransport(send) {
	transportSend = send;
}
/**
* Drop the sender and fail every in-flight ack wait.
* @param error - rejection for pending Computer Use cloak calls.
*/
function clearOverlayGuardTransport(error) {
	transportSend = void 0;
	resetOverlayGuardDepths();
	for (const waiter of pendingExclude.values()) waiter.reject(error);
	pendingExclude.clear();
	for (const waiter of pendingFrame.values()) waiter.reject(error);
	pendingFrame.clear();
	for (const waiter of pendingSck.values()) waiter.reject(error);
	pendingSck.clear();
}
/**
* Complete one Electron overlay-guard acknowledgement.
* @param requestId - id from the matching Host `overlay-guard` event.
* @param excludeWindowIds - overlay window ids from the ack; empty when no overlay exists.
* @returns whether a waiter existed.
*/
function completeOverlayGuardAck(requestId, excludeWindowIds = []) {
	const waiter = pendingExclude.get(requestId);
	if (waiter === void 0) return false;
	pendingExclude.delete(requestId);
	waiter.resolve(excludeWindowIds);
	return true;
}
/**
* Complete one Electron observation-frame acknowledgement.
* @param requestId - id from the matching Host `observation-frame` event.
* @returns whether a waiter existed.
*/
function completeObservationFrameAck(requestId) {
	const waiter = pendingFrame.get(requestId);
	if (waiter === void 0) return false;
	pendingFrame.delete(requestId);
	waiter.resolve();
	return true;
}
/**
* Complete one Electron overlay-exclude capture acknowledgement.
* @param requestId - id from the matching Host `sck-capture` event.
* @param error - failure message; omit or pass empty on success.
* @returns whether a waiter existed.
*/
function completeSckCaptureAck(requestId, error) {
	const waiter = pendingSck.get(requestId);
	if (waiter === void 0) return false;
	pendingSck.delete(requestId);
	if (error !== void 0 && error !== "") waiter.reject(new Error(error));
	else waiter.resolve();
	return true;
}
function waitExcludeAck(requestId, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(errorOf(signal.reason, "dsh desktop: overlay-guard aborted"));
			return;
		}
		const timer = setTimeout(() => {
			settle(() => {
				reject(/* @__PURE__ */ new Error("dsh desktop: overlay-guard ack timed out"));
			});
		}, OVERLAY_GUARD_ACK_TIMEOUT_MS);
		timer.unref();
		const settle = (next) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			pendingExclude.delete(requestId);
			next();
		};
		const onAbort = () => {
			settle(() => {
				reject(errorOf(signal?.reason, "dsh desktop: overlay-guard aborted"));
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingExclude.set(requestId, {
			resolve: (excludeWindowIds) => {
				settle(() => {
					resolve(excludeWindowIds);
				});
			},
			reject: (error) => {
				settle(() => {
					reject(error);
				});
			}
		});
	});
}
function waitFrameAck(requestId, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(errorOf(signal.reason, "dsh desktop: observation-frame aborted"));
			return;
		}
		const timer = setTimeout(() => {
			settle(() => {
				reject(/* @__PURE__ */ new Error("dsh desktop: observation-frame ack timed out"));
			});
		}, OVERLAY_GUARD_ACK_TIMEOUT_MS);
		timer.unref();
		const settle = (next) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			pendingFrame.delete(requestId);
			next();
		};
		const onAbort = () => {
			settle(() => {
				reject(errorOf(signal?.reason, "dsh desktop: observation-frame aborted"));
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingFrame.set(requestId, {
			resolve: () => {
				settle(() => {
					resolve();
				});
			},
			reject: (error) => {
				settle(() => {
					reject(error);
				});
			}
		});
	});
}
function waitSckAck(requestId, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(errorOf(signal.reason, "dsh desktop: overlay-exclude capture aborted"));
			return;
		}
		const timer = setTimeout(() => {
			settle(() => {
				reject(/* @__PURE__ */ new Error("dsh desktop: sck-capture ack timed out"));
			});
		}, SCK_CAPTURE_ACK_TIMEOUT_MS);
		timer.unref();
		const settle = (next) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			pendingSck.delete(requestId);
			next();
		};
		const onAbort = () => {
			settle(() => {
				reject(errorOf(signal?.reason, "dsh desktop: overlay-exclude capture aborted"));
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingSck.set(requestId, {
			resolve: () => {
				settle(() => {
					resolve();
				});
			},
			reject: (error) => {
				settle(() => {
					reject(error);
				});
			}
		});
	});
}
async function withCaptureMode(send, run, signal) {
	const sendCaptureIpc = captureDepth === 0;
	captureDepth += 1;
	let sentBegin = false;
	try {
		if (sendCaptureIpc) {
			const beginId = nextRequestId++;
			send({
				type: "overlay-guard",
				requestId: beginId,
				action: "begin",
				mode: "capture"
			});
			sentBegin = true;
			activeExcludeWindowIds = await waitExcludeAck(beginId, signal);
		}
		return await run({ excludeWindowIds: activeExcludeWindowIds });
	} finally {
		captureDepth -= 1;
		if (sentBegin) {
			const endId = nextRequestId++;
			send({
				type: "overlay-guard",
				requestId: endId,
				action: "end",
				mode: "capture"
			});
			try {
				await waitExcludeAck(endId);
			} catch {}
			if (inputDepth === 0 && captureDepth === 0) activeExcludeWindowIds = [];
		}
	}
}
async function withInputMode(send, run, signal) {
	const outermost = inputDepth === 0;
	inputDepth += 1;
	let sentBegin = false;
	let hidBegan = false;
	try {
		if (outermost) {
			const beginId = nextRequestId++;
			send({
				type: "overlay-guard",
				requestId: beginId,
				action: "begin",
				mode: "input"
			});
			sentBegin = true;
			activeExcludeWindowIds = await waitExcludeAck(beginId, signal);
			hidBegan = true;
		}
		return await run();
	} finally {
		inputDepth -= 1;
		if (sentBegin) {
			if (hidBegan) await setTimeout$1(80);
			const endId = nextRequestId++;
			send({
				type: "overlay-guard",
				requestId: endId,
				action: "end",
				mode: "input"
			});
			try {
				await waitExcludeAck(endId);
			} catch {}
			if (captureDepth === 0) activeExcludeWindowIds = [];
		}
	}
}
async function sendObservationFrameHide(send) {
	const requestId = nextRequestId++;
	send({
		type: "observation-frame",
		requestId,
		bounds: null
	});
	await waitFrameAck(requestId);
}
function armObservationFrameAbortHide(send, signal) {
	if (armedObservationFrameAbort.has(signal)) return;
	armedObservationFrameAbort.add(signal);
	signal.addEventListener("abort", () => {
		sendObservationFrameHide(send).catch(() => {});
	}, { once: true });
}
async function setObservationFrameMode(send, bounds, signal) {
	if (bounds !== null && signal !== void 0) armObservationFrameAbortHide(send, signal);
	if (bounds !== null && signal?.aborted) {
		try {
			await sendObservationFrameHide(send);
		} catch {}
		throw errorOf(signal.reason, "dsh desktop: observation-frame aborted");
	}
	const requestId = nextRequestId++;
	send({
		type: "observation-frame",
		requestId,
		bounds
	});
	await waitFrameAck(requestId, signal);
}
async function captureExcludedRegionMode(send, input, signal) {
	const requestId = nextRequestId++;
	send({
		type: "sck-capture",
		requestId,
		region: input.region,
		excludeWindowIds: input.excludeWindowIds,
		output: input.output
	});
	await waitSckAck(requestId, signal);
}
function passThroughGuard() {
	return {
		withCapture: (run) => run({ excludeWindowIds: [] }),
		withInput: (run) => run(),
		setObservationFrame: () => Promise.resolve()
	};
}
/**
* Construct an overlay-guard that uses an explicit sender, or a pass-through when `send` is omitted.
* @param send - Host → Electron overlay-guard sender.
* @returns capture and HID cloak helpers.
*/
function createComputerUseOverlayGuard(send) {
	if (send === void 0) return passThroughGuard();
	return {
		withCapture: (run, signal) => withCaptureMode(send, run, signal),
		withInput: (run, signal) => withInputMode(send, run, signal),
		setObservationFrame: (bounds, signal) => setObservationFrameMode(send, bounds, signal),
		captureExcludedRegion: (input, signal) => captureExcludedRegionMode(send, input, signal)
	};
}
/**
* Publish the overlay-guard service. Cloak IPC runs only after {@link setOverlayGuardTransport}.
* @param ctx - Host context.
*/
function apply(ctx) {
	ctx.provide("computerUseOverlayGuard", {
		withCapture: (run, signal) => {
			const send = transportSend;
			return send === void 0 ? run({ excludeWindowIds: [] }) : withCaptureMode(send, run, signal);
		},
		withInput: (run, signal) => {
			const send = transportSend;
			return send === void 0 ? run() : withInputMode(send, run, signal);
		},
		setObservationFrame: (bounds, signal) => {
			const send = transportSend;
			return send === void 0 ? Promise.resolve() : setObservationFrameMode(send, bounds, signal);
		},
		captureExcludedRegion: (input, signal) => {
			const send = transportSend;
			if (send === void 0) return Promise.reject(/* @__PURE__ */ new Error("dsh desktop: overlay-exclude capture is not attached"));
			return captureExcludedRegionMode(send, input, signal);
		}
	});
}
//#endregion
export { OVERLAY_GUARD_ACK_TIMEOUT_MS, OVERLAY_GUARD_INPUT_DRAIN_MS, SCK_CAPTURE_ACK_TIMEOUT_MS, apply, clearOverlayGuardTransport, completeObservationFrameAck, completeOverlayGuardAck, completeSckCaptureAck, createComputerUseOverlayGuard, name, setOverlayGuardTransport, computer_use_overlay_guard_exports as t };
