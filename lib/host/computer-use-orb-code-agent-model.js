import { t as __exportAll } from "./rolldown-runtime-D7D4PA-g.js";
//#region lib/types/computer-use-orb-code-agent-model.js
var computer_use_orb_code_agent_model_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply,
	clearOrbCodeAgentModelSelection: () => clearOrbCodeAgentModelSelection,
	name: () => name,
	setOrbCodeAgentModelSelection: () => setOrbCodeAgentModelSelection
});
/**
* Desktop Host plugin that holds the floating-ball background Code-agent model selection.
* @module @deepseek-ai/dsh-desktop-host/computer-use-orb-code-agent-model
*/
/** Cordis plugin name matching the Desktop overlay YAML id. */
const name = "computer-use-orb-code-agent-model";
let selection;
/**
* Replace the stored background Code-agent selection.
* @param next - Electron-pushed route.
*/
function setOrbCodeAgentModelSelection(next) {
	selection = {
		provider: next.provider,
		model: next.model,
		...next.reasoningEffort === void 0 ? {} : { reasoningEffort: next.reasoningEffort }
	};
}
/**
* Drop the stored selection. Tests reset module state between cases.
* @returns nothing; module state is undefined afterwards.
*/
function clearOrbCodeAgentModelSelection() {
	selection = void 0;
}
/**
* Publish the background Code-agent model selection for `code_agent` create.
* @param ctx - Host context.
*/
function apply(ctx) {
	ctx.provide("orbCodeAgentModel", { currentSelection: () => selection });
}
//#endregion
export { apply, clearOrbCodeAgentModelSelection, name, setOrbCodeAgentModelSelection, computer_use_orb_code_agent_model_exports as t };
