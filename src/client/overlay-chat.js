// Overlay Compact Chat (see header of lib/client.js). Factory body; `require` is the client module loader.
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");

		// ── overlay protocol (Orb 0.1.7 dsh-api-session-controller/client, types/client/overlay-surface) ──
		const OVERLAY_CLIENT_SURFACE = "overlay";
		const OVERLAY_SESSION_MESSAGE_TYPE = "dsh.overlay.session";
		const OVERLAY_READY_MESSAGE_TYPE = "dsh.overlay.ready";
		const OVERLAY_THEME_MESSAGE_TYPE = "dsh.overlay.theme";
		/** The floating shell is now served by dsh-orb from the same Host origin as this iframe. */
		const OVERLAY_SHELL_ORIGIN = typeof location === "undefined" ? "" : location.origin;
		const DARK_ATTRIBUTE = "data-ds-dark-theme";
		function overlaySessionId(value) {
			return value;
		}
		function overlaySessionMessage(data) {
			if (typeof data !== "object" || data === null) return void 0;
			if (data.type !== OVERLAY_SESSION_MESSAGE_TYPE || typeof data.sessionId !== "string") return void 0;
			return { type: OVERLAY_SESSION_MESSAGE_TYPE, sessionId: data.sessionId };
		}
		function overlayClientSurface(search) {
			const raw = search ?? (typeof location === "undefined" ? "" : location.search);
			const query = raw.startsWith("?") ? raw.slice(1) : raw;
			return new URLSearchParams(query).get("surface") === OVERLAY_CLIENT_SURFACE;
		}

		// ── Compact Chat root (verbatim from Orb, CSS included) ──
		const css = "html,body{height:100%;margin:0;overflow:hidden}html{background:0 0}body{background:var(--dsw-alias-bg-base)}#root{height:100%}.p0qSPW_shell{box-sizing:border-box;--dsh-chat-content-width:100%;--dsh-composer-side-clearance:0px;height:100%;overflow:auto}.p0qSPW_shell [data-chat-turn-rail]{display:none}[data-overlay-chat] .p0qSPW_shell :is(.DYkZvW_toBottomSlot,.DYkZvW_toBottom){display:none}.p0qSPW_inputOverlay{width:0;height:0;overflow:visible}";
		const tagId = "dsh-orb/OverlayChatRoot.module.css";
		if (overlayClientSurface() && typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-orb";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = { inputOverlay: "p0qSPW_inputOverlay", shell: "p0qSPW_shell" };
		function ignoreView(_view, _focus) {}
		function ignoreRequest() {}
		function OverlayChatRoot({ renderSlot, SessionProvider, useSessions }) {
			const sessionId = useSessions((state) => state.ids.find((id) => (state.byId[id]?.retainedBy.mainView ?? 0) > 0));
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.shell,
				"data-conversation-scroll": "",
				"data-overlay-chat": "",
				children: (0, react_jsx_runtime.jsx)(SessionProvider, {
					empty: () => null,
					children: sessionId === void 0 ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [renderSlot("conversation.view", {
						inspectCall: void 0,
						viewRequest: null,
						openView: ignoreView,
						completeViewRequest: ignoreRequest
					}, { only: "chat" }), (0, react_jsx_runtime.jsx)("div", {
						className: styles.inputOverlay,
						children: renderSlot("conversation.input.overlay", {})
					})] })
				})
			});
		}

		const inject = ["slots", "sessions"];
		function apply(ctx) {
			if (!overlayClientSurface()) return;
			// The 0.2 layout always occupies `root`; a lower priority number shadows it (single slots elect the lowest).
			ctx.effect(() => ctx.slots.register({
				name: "root",
				priority: -100,
				children: {
					"conversation.view": { kind: "list", scope: "session" },
					"conversation.input.overlay": { kind: "list", scope: "session" }
				}
			}, OverlayChatRoot), "dsh-orb: compact root");
			ctx.effect(() => {
				let pending;
				let held;
				let opening = false;
				const tryOpen = (id) => {
					if (opening) return;
					opening = true;
					pending = id;
					try {
						const next = ctx.sessions.retain(overlaySessionId(id), { source: "mainView" });
						held?.release();
						held = next;
						pending = void 0;
					} catch (error) {
						if (!(error instanceof Error) || !/unknown session/.test(error.message)) throw error;
					} finally {
						opening = false;
					}
				};
				const onMessage = (event) => {
					if (event.origin !== OVERLAY_SHELL_ORIGIN) return;
					const message = overlaySessionMessage(event.data);
					if (message === void 0) return;
					tryOpen(message.sessionId);
				};
				window.addEventListener("message", onMessage);
				const offList = ctx.sessions.list.subscribe(() => {
					if (pending !== void 0) tryOpen(pending);
				});
				window.parent.postMessage({ type: OVERLAY_READY_MESSAGE_TYPE }, OVERLAY_SHELL_ORIGIN);
				return () => {
					held?.release();
					window.removeEventListener("message", onMessage);
					offList();
				};
			}, "dsh-orb: session bridge");
			// Orb's layout posted the effective color scheme to the shell so the panel chrome matches the transcript.
			ctx.effect(() => {
				const root = document.documentElement;
				let last;
				const post = () => {
					const colorScheme = root.hasAttribute(DARK_ATTRIBUTE) ? "dark" : "light";
					if (colorScheme === last) return;
					last = colorScheme;
					window.parent.postMessage({ type: OVERLAY_THEME_MESSAGE_TYPE, colorScheme }, OVERLAY_SHELL_ORIGIN);
				};
				const observer = new MutationObserver(post);
				observer.observe(root, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] });
				post();
				return () => observer.disconnect();
			}, "dsh-orb: theme bridge");
		}

		exports.OverlayChatRoot = OverlayChatRoot;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
