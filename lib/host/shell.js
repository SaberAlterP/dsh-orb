// shell.js — Host half of the Orb floating ball for DeepSeek Harness 0.2.
//
// In Orb 0.1.7 the Electron main process owned the floating ball. Harness 0.2 has no such shell, so this plugin:
//  - serves Orb's renderer documents (unchanged files) from the Host web server under /.dsh/orb/, rewriting Orb's
//    `dsh-app://app` origin to the Host origin at serve time;
//  - answers the preference calls Orb's preload bridged to Electron (session id, overlay model, permission, ...)
//    under /.dsh/orb/api/<op>, reading/writing the same profile files Orb used;
//  - serves Orb's floating-ball NDJSON stream (/.dsh/remote-stream);
//  - starts the native companion (orb-shell.exe) with a one-time login URL and relays the Computer Use overlay
//    guard / observation frame over its stdin/stdout.
// Every route requires the Host's browser cookie (the same check /api uses); routes registered on the web server
// are otherwise unauthenticated.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { isOrbPermissionPreset, setOrbPermissionPreset } from "./computer-use-orb-permission.js";
import { clearOverlayGuardTransport, completeObservationFrameAck, completeOverlayGuardAck, completeSckCaptureAck, setOverlayGuardTransport } from "./computer-use-overlay-guard.js";
import { profileDir, readCoordinateMode, readModels, readPermission, MILLIFRACTION_COORDINATES_FILE, ORB_AGENT_MODELS_FILE, ORB_PERMISSION_FILE } from "./orb-prefs.js";

export const name = "dsh-orb-shell";
export const inject = ["webServer", "connection"];

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RENDERER_DIR = join(PACKAGE_ROOT, "renderer");
const SHELL_EXE = join(PACKAGE_ROOT, "orb-shell", "orb-shell.exe");
const ORB_PREFIX = "/.dsh/orb/";
const ORB_API_PREFIX = "/.dsh/orb/api/";
const REMOTE_STREAM_PATH = "/.dsh/remote-stream";
/** Orb 0.1.7 lib/main.js names. */
const FLOATING_SESSION_FILE = "floating-session.json";
const SELECTION_TOOLBAR_FILE = "selection-toolbar.json";
const ORB_WORKSPACE_NAME = "dsh_orb";
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".gif": "image/gif",
	".png": "image/png",
	".webp": "image/webp",
	".svg": "image/svg+xml"
};
const REWRITTEN = new Set([".html", ".js"]);
const LOCALE = JSON.parse(readFileSync(join(RENDERER_DIR, "orb-locale.json"), "utf8"));

function authorized(ctx, req, res) {
	const auth = ctx.connection?.browserAuth;
	if (auth !== void 0 && typeof auth.isAuthenticated === "function" && auth.isAuthenticated(req)) return true;
	res.writeHead(401, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
	res.end("dsh-orb: authentication required\n");
	return false;
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(value === void 0 ? "null" : JSON.stringify(value));
}

function readJsonFile(file) {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
	} catch {
		return void 0;
	}
}

function writeJsonFile(file, value) {
	writeFileSync(file, `${JSON.stringify(value, void 0, 2)}\n`);
}

function isSelection(value) {
	return typeof value === "object" && value !== null && typeof value.provider === "string" && value.provider !== "" && typeof value.model === "string" && value.model !== "" && (value.reasoningEffort === void 0 || typeof value.reasoningEffort === "string");
}

// ── avatar (Orb lib/main.js: orb-avatar bytes + orb-avatar.json in the profile, GIF/PNG/WebP up to 2 MiB) ──
const ORB_AVATAR_BYTES_FILE = "orb-avatar";
const ORB_AVATAR_META_FILE = "orb-avatar.json";
const AVATAR_MIME_BY_EXTENSION = { ".gif": "image/gif", ".png": "image/png", ".webp": "image/webp" };
function sniffAvatarMime(b) {
	if (b.length >= 6 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56 && (b[4] === 55 || b[4] === 57) && b[5] === 97) return "image/gif";
	if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) return "image/png";
	if (b.length >= 12 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) return "image/webp";
}
function customAvatar(dir) {
	try {
		const bytes = new Uint8Array(readFileSync(join(dir, ORB_AVATAR_BYTES_FILE)));
		const mime = sniffAvatarMime(bytes);
		const stored = readJsonFile(join(dir, ORB_AVATAR_META_FILE))?.mime;
		if (mime === void 0 || stored !== void 0 && stored !== mime) return void 0;
		return { bytes, mime, version: Math.trunc(statSync(join(dir, ORB_AVATAR_BYTES_FILE)).mtimeMs) };
	} catch {
		return void 0;
	}
}
function avatarPath(dir) {
	return `${ORB_PREFIX}avatar?v=${String(customAvatar(dir)?.version ?? 0)}`;
}
function snapshot(dir) {
	return {
		supported: true,
		avatarUrl: avatarPath(dir),
		overlay: readModels(dir).overlay,
		background: readModels(dir).background,
		selectionEnabled: readJsonFile(join(dir, SELECTION_TOOLBAR_FILE))?.enabled !== false,
		millifractionEnabled: readCoordinateMode(dir) === "millifraction",
		tcc: { applicable: false, appName: "DeepSeek Harness", screen: "granted", accessibility: "granted" }
	};
}

/** Locale the floating renderer expects from `dshDesktop.locale()` ({ id, messages }). */
function localeFor(req) {
	const lang = String(req.headers["accept-language"] ?? "").toLowerCase();
	return lang.startsWith("zh") ? { id: "zh-CN", messages: LOCALE.zh } : { id: "en", messages: LOCALE.en };
}

async function serveRenderer(req, res, pathname) {
	const rel = decodeURIComponent(pathname.slice(ORB_PREFIX.length)) || "floating.html";
	const target = normalize(join(RENDERER_DIR, rel));
	if (!target.startsWith(RENDERER_DIR + sep) || !existsSync(target)) {
		res.writeHead(404);
		res.end();
		return;
	}
	const ext = extname(target);
	let body = await readFile(target);
	if (REWRITTEN.has(ext)) {
		const origin = `http://${req.headers.host}`;
		let text = body.toString("utf8").replaceAll("dsh-app://app", origin).replaceAll("dsh-app://shell", origin).replaceAll(" dsh-app:", ` ${origin}`);
		// Orb's documents expect `window.dshDesktop` from the Electron preload; load the WebView2 bridge first.
		if (ext === ".html") text = text.replace("<script src=", "<script src=\"orb-bridge.js\"></script>\n    <script src=");
		body = Buffer.from(text);
	}
	res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(req.method === "HEAD" ? void 0 : body);
}

/** Preference operations Orb's preload sent to Electron (lib/main.js ipcMain handlers). */
function apiOps(ctx, dir, shell) {
	return {
		locale: (_args, req) => localeFor(req),
		backendStatus: () => ({ phase: "ready" }),
		sessionGet: () => {
			const id = readJsonFile(join(dir, FLOATING_SESSION_FILE))?.sessionId;
			return typeof id === "string" && id !== "" ? id : null;
		},
		sessionSet: ([sessionId]) => {
			if (typeof sessionId !== "string" || sessionId === "") throw new Error("invalid floating session");
			writeJsonFile(join(dir, FLOATING_SESSION_FILE), { sessionId });
		},
		overlayModelGet: () => readModels(dir).overlay,
		overlayModelSet: ([selection]) => {
			if (!isSelection(selection)) throw new Error("invalid overlay model");
			const current = readModels(dir);
			writeJsonFile(join(dir, ORB_AGENT_MODELS_FILE), { overlay: selection, background: current.background });
		},
		backgroundModelGet: () => readModels(dir).background,
		backgroundModelSet: ([selection]) => {
			if (!isSelection(selection)) throw new Error("invalid background model");
			const current = readModels(dir);
			// orb-prefs watches this file and pushes the selection to the code_agent model service.
			writeJsonFile(join(dir, ORB_AGENT_MODELS_FILE), { overlay: current.overlay, background: selection });
		},
		selectionEnabledGet: () => readJsonFile(join(dir, SELECTION_TOOLBAR_FILE))?.enabled !== false,
		selectionEnabledSet: ([enabled]) => {
			if (typeof enabled !== "boolean") throw new Error("selection enablement requires a boolean");
			const current = readJsonFile(join(dir, SELECTION_TOOLBAR_FILE)) ?? {};
			writeJsonFile(join(dir, SELECTION_TOOLBAR_FILE), { ...current, enabled });
		},
		millifractionGet: () => readCoordinateMode(dir) === "millifraction",
		millifractionSet: ([enabled]) => {
			if (typeof enabled !== "boolean") throw new Error("millifraction enablement requires a boolean");
			writeJsonFile(join(dir, MILLIFRACTION_COORDINATES_FILE), { enabled });
		},
		permissionGet: () => readPermission(dir),
		permissionSet: ([preset, sessionId]) => {
			if (!isOrbPermissionPreset(preset)) throw new Error("overlay permission must be a known Access preset");
			writeJsonFile(join(dir, ORB_PERMISSION_FILE), { preset });
			setOrbPermissionPreset(preset, typeof sessionId === "string" && sessionId !== "" ? sessionId : void 0);
		},
		orbWorkspace: () => {
			const path = join(resolveDshHome(), ORB_WORKSPACE_NAME);
			mkdirSync(path, { recursive: true });
			return path;
		},
		avatarUrl: (_args, req) => `http://${req.headers.host}${avatarPath(dir)}`,
		// ── Orb settings page (lib/main.js orbSnapshotFor / orb* IPC handlers) ──
		orbSupported: () => true,
		orbSnapshot: () => snapshot(dir),
		avatarUpload: ([name, base64]) => {
			if (typeof name !== "string" || typeof base64 !== "string") throw new Error("invalid avatar upload");
			const bytes = new Uint8Array(Buffer.from(base64, "base64"));
			if (bytes.length > 2097152) return { ok: false, error: "too-large" };
			const mime = sniffAvatarMime(bytes);
			const fromName = AVATAR_MIME_BY_EXTENSION[extname(name).toLowerCase()];
			if (mime === void 0 || fromName !== void 0 && fromName !== mime) return { ok: false, error: "invalid-type" };
			writeFileSync(join(dir, ORB_AVATAR_BYTES_FILE), bytes);
			writeJsonFile(join(dir, ORB_AVATAR_META_FILE), { mime });
			shell.send({ type: "event", channel: "avatar", payload: avatarPath(dir) });
			return { ok: true, snapshot: snapshot(dir) };
		},
		avatarRestore: () => {
			for (const file of [ORB_AVATAR_BYTES_FILE, ORB_AVATAR_META_FILE]) rmSync(join(dir, file), { force: true });
			shell.send({ type: "event", channel: "avatar", payload: avatarPath(dir) });
			return snapshot(dir);
		},
		// Window, focus and selection operations belong to the native companion; the renderer shim sends them there.
		shellCommand: ([command]) => {
			shell.send(command);
		}
	};
}

// ── floating-ball NDJSON stream (verbatim from Orb's Desktop Host, plus the cookie check) ─────────────────
async function* emptyUplink() {}
function isStreamRequest(value) {
	if (typeof value !== "object" || value === null) return false;
	return typeof Reflect.get(value, "endpoint") === "string" && Object.hasOwn(value, "payload");
}
async function serveRemoteStream(gateway, req, res) {
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(await readBody(req));
	} catch {
		res.writeHead(400);
		res.end();
		return;
	}
	if (!isStreamRequest(parsed)) {
		res.writeHead(400);
		res.end();
		return;
	}
	if (gateway === void 0) {
		res.writeHead(503);
		res.end();
		return;
	}
	const abort = new AbortController();
	const stop = () => abort.abort();
	req.on?.("aborted", stop);
	res.on("close", stop);
	try {
		const values = await gateway.wireStream.open(parsed.endpoint, parsed.payload, emptyUplink(), void 0, abort.signal);
		res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-transform" });
		for await (const value of values) {
			if (abort.signal.aborted || res.writableEnded) break;
			res.write(`${JSON.stringify(value)}\n`);
		}
		if (!res.writableEnded) res.end();
	} catch (error) {
		if (res.headersSent) {
			res.destroy(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		res.writeHead(502);
		res.end();
	} finally {
		req.off?.("aborted", stop);
		res.off("close", stop);
	}
}

// ── native companion ─────────────────────────────────────────────────────────────────────────────────
class Companion {
	child;
	buffer = "";
	stopped = false;
	constructor(launchUrl, profile) {
		this.launchUrl = launchUrl;
		this.profile = profile;
	}
	start() {
		if (!existsSync(SHELL_EXE) || process.env.DSH_ORB_NO_SHELL === "1") return false;
		const child = spawn(SHELL_EXE, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: false });
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.receive(chunk));
		child.on("exit", (code) => {
			this.child = void 0;
			clearOverlayGuardTransport(new Error(`dsh-orb: orb-shell exited (${String(code)})`));
			if (!this.stopped) console.error(`dsh-orb: orb-shell exited with ${String(code)}`);
		});
		child.on("error", (error) => console.error("dsh-orb: cannot start orb-shell", error));
		this.send({ type: "hello", launchUrl: this.launchUrl, page: `${ORB_PREFIX}floating.html`, profile: this.profile });
		setOverlayGuardTransport((event) => this.send(event));
		return true;
	}
	send(message) {
		const child = this.child;
		if (child === void 0 || child.stdin.destroyed) return;
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	receive(chunk) {
		this.buffer += chunk;
		let at;
		while ((at = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, at).trim();
			this.buffer = this.buffer.slice(at + 1);
			if (line === "") continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			// Same acks Orb's Electron main sent back to the Desktop Host.
			if (message.type === "overlay-guard-ack" && Number.isSafeInteger(message.requestId)) completeOverlayGuardAck(message.requestId, Array.isArray(message.excludeWindowIds) ? message.excludeWindowIds.filter((id) => typeof id === "number") : []);
			else if (message.type === "observation-frame-ack" && Number.isSafeInteger(message.requestId)) completeObservationFrameAck(message.requestId);
			else if (message.type === "sck-capture-ack" && Number.isSafeInteger(message.requestId)) completeSckCaptureAck(message.requestId, typeof message.error === "string" ? message.error : void 0);
		}
	}
	stop() {
		this.stopped = true;
		clearOverlayGuardTransport(new Error("dsh-orb: Host is stopping"));
		this.send({ type: "quit" });
		const child = this.child;
		if (child !== void 0) setTimeout(() => child.kill(), 2000).unref();
	}
}

export function apply(ctx, config = {}) {
	const dir = profileDir(config);
	const launchUrl = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`);
	const companion = new Companion(launchUrl, dir);
	const ops = apiOps(ctx, dir, companion);
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		// The web server matches a prefix as `path` or `path/...`, so it is registered without the trailing slash.
		path: ORB_PREFIX.slice(0, -1),
		handler: async (req, res) => {
			if (!authorized(ctx, req, res)) return;
			const pathname = new URL(req.url ?? "/", "http://x").pathname;
			if (pathname === `${ORB_PREFIX}avatar`) {
				const custom = customAvatar(dir);
				res.writeHead(200, { "content-type": custom?.mime ?? "image/gif", "cache-control": "no-store" });
				return res.end(req.method === "HEAD" ? void 0 : custom !== void 0 ? Buffer.from(custom.bytes) : await readFile(join(RENDERER_DIR, "deepseek-avatar-square.gif")));
			}
			if (!pathname.startsWith(ORB_API_PREFIX)) return serveRenderer(req, res, pathname);
			const op = ops[pathname.slice(ORB_API_PREFIX.length)];
			if (op === void 0 || req.method !== "POST") return sendJson(res, 404, { error: "unknown operation" });
			try {
				const body = await readBody(req);
				const args = body === "" ? [] : JSON.parse(body);
				sendJson(res, 200, await op(Array.isArray(args) ? args : [args], req));
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}));
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: REMOTE_STREAM_PATH,
		handler: (req, res) => authorized(ctx, req, res) ? serveRemoteStream(ctx.get("typertGateway"), req, res) : void 0
	}));
	ctx.effect(() => {
		companion.start();
		return () => companion.stop();
	});
}
