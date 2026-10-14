import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
//#region lib/types/computer-use-preset-root.js
/**
* Desktop overlay locator: publishes the Computer Use extra agent-presets root
* from the runtime extra package without declaring that experimental package
* as a Desktop Host npm dependency.
* @module @deepseek-ai/dsh-desktop-host/computer-use-preset-root
*/
/** npm name of the experimental Computer Use package copied as a runtime extra. */
const COMPUTER_USE_PACKAGE = "@deepseek-ai/dsh-experimental-tool-computer-use";
/** Cordis plugin name matching the Web overlay locator. */
const name = "computer-use-preset-root";
/**
* Resolve the extra presets directory from a Desktop runtime tree.
* @param runtimeDir - immutable packages carried by the Electron application.
* @returns the absolute presets directory, or undefined when the extra is absent.
*/
function computerUsePresetRoot(runtimeDir) {
	const path = join(runtimeDir, "node_modules", ...COMPUTER_USE_PACKAGE.split("/"), "presets");
	return existsSync(path) ? path : void 0;
}
/**
* Publish the extra Computer Use presets root for Desktop `agent-presets` inject.
* @param ctx - Host context. The overlay injects this service on `agent-presets`.
* @throws when the experimental package is missing from the Desktop runtime.
*/
function apply(ctx) {
	const require = createRequire(import.meta.url);
	let fromPackage;
	try {
		fromPackage = join(dirname(require.resolve(`${COMPUTER_USE_PACKAGE}/package.json`)), "presets");
	} catch {
		fromPackage = void 0;
	}
	const presetRoot = [computerUsePresetRoot(process.cwd()), fromPackage].find((path) => path !== void 0 && existsSync(path));
	if (presetRoot === void 0) throw new Error("dsh desktop: Computer Use experimental package is missing from the Desktop runtime");
	ctx.provide("computerUsePresetRoot", presetRoot);
}
//#endregion
export { COMPUTER_USE_PACKAGE, apply, computerUsePresetRoot, name };
