// orb-prefs.js — feed the stored Orb preferences into the Host services.
//
// In DeepSeek Orb 0.1.7 the Electron main process read these profile files and pushed them to the Desktop Host
// over IPC ("orb-permission", "orb-coordinate-mode", "orb-code-agent-model"). Harness 0.2 has no such shell, so
// this plugin reads the same files itself, applies them on start, and re-applies when a file changes.
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { isOrbPermissionPreset, setOrbPermissionPreset } from "./computer-use-orb-permission.js";
import { setOrbCoordinateMode } from "./computer-use-orb-coordinate-mode.js";
import { setOrbCodeAgentModelSelection } from "./computer-use-orb-code-agent-model.js";

export const name = "dsh-orb-prefs";

/** Same file names as Orb 0.1.7 lib/main.js. */
export const ORB_PERMISSION_FILE = "orb-permission.json";
export const ORB_AGENT_MODELS_FILE = "orb-agent-models.json";
export const MILLIFRACTION_COORDINATES_FILE = "millifraction-coordinates.json";

/** Orb's shipped defaults (lib/main.js: DEFAULT_ORB_AGENT_MODEL, DEFAULT_ORB_PERMISSION, defaultMillifractionEnabled). */
const DEFAULT_MODEL = { provider: "deepseek-official", model: "deepseek-flash" };
const DEFAULT_PERMISSION = "danger-full-access";

export function profileDir(config = {}) {
	return config.profileDir ?? join(resolveDshHome(), "profiles", config.profile ?? "desktop");
}

function readJson(file) {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
	} catch {
		return void 0;
	}
}

function isSelection(value) {
	return typeof value === "object" && value !== null && typeof value.provider === "string" && value.provider !== "" && typeof value.model === "string" && value.model !== "" && (value.reasoningEffort === void 0 || typeof value.reasoningEffort === "string");
}

export function readPermission(dir) {
	const preset = readJson(join(dir, ORB_PERMISSION_FILE))?.preset;
	return isOrbPermissionPreset(preset) ? preset : DEFAULT_PERMISSION;
}

export function readModels(dir) {
	const value = readJson(join(dir, ORB_AGENT_MODELS_FILE)) ?? {};
	return {
		overlay: isSelection(value.overlay) ? value.overlay : DEFAULT_MODEL,
		background: isSelection(value.background) ? value.background : DEFAULT_MODEL
	};
}

export function readCoordinateMode(dir) {
	const enabled = readJson(join(dir, MILLIFRACTION_COORDINATES_FILE))?.enabled;
	return (typeof enabled === "boolean" ? enabled : process.platform === "win32") ? "millifraction" : "pixel";
}

export function applyStoredPreferences(dir) {
	setOrbPermissionPreset(readPermission(dir));
	setOrbCoordinateMode(readCoordinateMode(dir));
	const { background } = readModels(dir);
	setOrbCodeAgentModelSelection({
		provider: background.provider,
		model: background.model,
		...background.reasoningEffort === void 0 ? {} : { reasoningEffort: background.reasoningEffort }
	});
}

export function apply(ctx, config = {}) {
	const dir = profileDir(config);
	applyStoredPreferences(dir);
	const watched = new Set([ORB_PERMISSION_FILE, ORB_AGENT_MODELS_FILE, MILLIFRACTION_COORDINATES_FILE]);
	let timer;
	let watcher;
	try {
		watcher = watch(dir, (_event, file) => {
			if (file === null || !watched.has(String(file))) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				try {
					applyStoredPreferences(dir);
				} catch (error) {
					console.error("dsh-orb: reapplying preferences failed", error);
				}
			}, 150);
		});
	} catch (error) {
		console.error("dsh-orb: cannot watch profile preferences", error);
	}
	ctx.effect(() => () => {
		clearTimeout(timer);
		watcher?.close();
	});
}
