import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.js";
//#region lib/types/computer-use-orb-coordinate-mode.js
var computer_use_orb_coordinate_mode_exports = /* @__PURE__ */ __exportAll({
	ORB_COORDINATE_MODES: () => ORB_COORDINATE_MODES,
	apply: () => apply,
	clearOrbCoordinateMode: () => clearOrbCoordinateMode,
	defaultOrbCoordinateMode: () => defaultOrbCoordinateMode,
	isOrbCoordinateMode: () => isOrbCoordinateMode,
	name: () => name,
	setOrbCoordinateMode: () => setOrbCoordinateMode
});
/**
* Desktop Host plugin that holds the floating-ball Computer Use click encoding.
* @module @deepseek-ai/dsh-desktop-host/computer-use-orb-coordinate-mode
*/
/** Click encoding Electron may push for new overlay Computer Use sessions. */
const ORB_COORDINATE_MODES = ["millifraction", "pixel"];
/**
* Shipped encoding until Electron pushes a stored preference.
* Windows starts in millifraction. macOS and Linux start in pixels.
* @param platform - Node `process.platform`. Defaults to this process.
* @returns the encoding for a new overlay chat before a profile value arrives.
*/
function defaultOrbCoordinateMode(platform = process.platform) {
	return platform === "win32" ? "millifraction" : "pixel";
}
/** Cordis plugin name matching the Desktop overlay YAML id. */
const name = "computer-use-orb-coordinate-mode";
let mode = defaultOrbCoordinateMode();
/**
* True when `value` is one of {@link ORB_COORDINATE_MODES}.
* @param value - Host IPC payload.
* @returns whether `value` may replace the live overlay encoding.
*/
function isOrbCoordinateMode(value) {
	return typeof value === "string" && ORB_COORDINATE_MODES.includes(value);
}
/**
* Replace the stored overlay Computer Use click encoding.
* @param next - Electron-pushed encoding.
*/
function setOrbCoordinateMode(next) {
	mode = next;
}
/**
* Restore the platform shipped default. Tests reset module state between cases.
* @returns nothing; module state is {@link defaultOrbCoordinateMode} afterwards.
*/
function clearOrbCoordinateMode() {
	mode = defaultOrbCoordinateMode();
}
/**
* Publish the overlay Computer Use click encoding for blank session creates.
* @param ctx - Host context.
*/
function apply(ctx) {
	ctx.provide("orbCoordinateMode", { currentMode: () => mode });
}
//#endregion
export { ORB_COORDINATE_MODES, apply, clearOrbCoordinateMode, defaultOrbCoordinateMode, isOrbCoordinateMode, name, setOrbCoordinateMode, computer_use_orb_coordinate_mode_exports as t };
