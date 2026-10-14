import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region lib/types/computer-use-orb-permission.js
/**
* Desktop Host plugin that pins the overlay Access preset on floating-orb sessions.
* @module @deepseek-ai/dsh-desktop-host/computer-use-orb-permission
*/
/** Directory name of the overlay workspace under the Harness home. */
const ORB_WORKSPACE_NAME = "dsh_orb";
/** Access presets Electron may push for overlay Computer Use and background `code_agent`. */
const ORB_PERMISSION_PRESETS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
/** Shipped overlay Access until Electron pushes a stored preference. */
const DEFAULT_ORB_PERMISSION_PRESET = "danger-full-access";
/** Cordis plugin name matching the Desktop overlay YAML id. */
const name = "computer-use-orb-permission";
const inject = ["permissionPresets", "sessions"];
let preset = DEFAULT_ORB_PERMISSION_PRESET;
let live;
/**
* True when `value` is one of {@link ORB_PERMISSION_PRESETS}.
* @param value - Host IPC payload.
* @returns whether `value` may replace the live overlay Access preset.
*/
function isOrbPermissionPreset(value) {
	return typeof value === "string" && ORB_PERMISSION_PRESETS.includes(value);
}
/**
* Absolute overlay workspace path.
* @param dshHome - Harness home; omitted, {@link resolveDshHome} is used.
* @returns `dshHome` joined with {@link ORB_WORKSPACE_NAME}.
*/
function orbWorkspacePath(dshHome = resolveDshHome()) {
	return join(dshHome, ORB_WORKSPACE_NAME);
}
/**
* Replace the live overlay Access preset used on later matching creates.
* When `sessionId` names an attached orb session, pin that session immediately.
* @param next - Electron-pushed preset.
* @param sessionId - overlay session to pin; omitted, only later creates use `next`.
*/
function setOrbPermissionPreset(next, sessionId) {
	preset = next;
	if (live === void 0 || sessionId === void 0) return;
	const session = live.sessions.get(SessionId(sessionId));
	if (session === void 0) return;
	pinOrbWorkspacePermission(live.presets, session, next);
}
/**
* Live overlay Access preset.
* @returns the Electron-pushed value, or {@link DEFAULT_ORB_PERMISSION_PRESET} before the first push.
*/
function currentOrbPermissionPreset() {
	return preset;
}
/**
* Restore the shipped Full access default. Tests reset module state between cases.
* @returns nothing; module state is {@link DEFAULT_ORB_PERMISSION_PRESET} afterwards.
*/
function clearOrbPermissionPreset() {
	preset = DEFAULT_ORB_PERMISSION_PRESET;
	live = void 0;
}
/**
* True when `cwd` is the overlay workspace or a real subdirectory of it.
* @param cwd - session cwd.
* @param orbCwd - overlay workspace path.
* @returns whether overlay Access applies.
*/
function isOrbWorkspaceDirectory(cwd, orbCwd) {
	const resolved = resolve(cwd);
	const orb = resolve(orbCwd);
	if (resolved === orb) return true;
	const rel = relative(orb, resolved);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function isOrbWorkspaceSession(session, orbCwd) {
	const agentPreset = session.header.agentPreset;
	return (agentPreset === "computer-use" || agentPreset === "standard") && session.header.cwd !== void 0 && isOrbWorkspaceDirectory(session.header.cwd, orbCwd);
}
/**
* Pin the live overlay Access preset when the session is Computer Use or standard on the orb workspace.
* `set` appends nothing when that preset is already current.
* @param presets - permission preset service.
* @param session - newly created session.
* @param next - preset to pin; omitted, {@link currentOrbPermissionPreset}.
* @param orbCwd - orb workspace path; omitted, {@link orbWorkspacePath}.
*/
function pinOrbWorkspacePermission(presets, session, next = currentOrbPermissionPreset(), orbCwd = orbWorkspacePath()) {
	if (!isOrbWorkspaceSession(session, orbCwd)) return;
	presets.set(session, next);
}
/**
* Pin matching sessions on create. Already-listed sessions keep their last logged preset until overlay work reapplies.
* @param ctx - Host context with `permissionPresets` and `sessions` (from {@link inject}).
*/
function apply(ctx) {
	live = {
		presets: ctx.permissionPresets,
		sessions: ctx.sessions
	};
	ctx.on("session/created", (session) => {
		pinOrbWorkspacePermission(ctx.permissionPresets, session);
	});
}
//#endregion
export { DEFAULT_ORB_PERMISSION_PRESET, ORB_PERMISSION_PRESETS, ORB_WORKSPACE_NAME, apply, clearOrbPermissionPreset, currentOrbPermissionPreset, inject, isOrbPermissionPreset, name, orbWorkspacePath, pinOrbWorkspacePermission, setOrbPermissionPreset };
