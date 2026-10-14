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
		/** Captured at bundle load, before the app may rewrite the URL. */
		const INITIAL_SEARCH = typeof location === "undefined" ? "" : location.search;
		/** The floating shell document served by dsh-orb; Compact Chat is its iframe. */
		function embeddedInFloatingShell() {
			try {
				return window.parent !== window && window.parent.location.pathname === "/.dsh/orb/floating.html";
			} catch {
				return false;
			}
		}
		function overlayClientSurface(search) {
			const raw = search ?? INITIAL_SEARCH;
			const query = raw.startsWith("?") ? raw.slice(1) : raw;
			return new URLSearchParams(query).get("surface") === OVERLAY_CLIENT_SURFACE || search === void 0 && embeddedInFloatingShell();
		}
		/** Diagnostics into orb-shell's log through the shell's IPC (same origin). */
		function shellLog(text) {
			try {
				window.parent.ipc?.postMessage(JSON.stringify({ type: "log", level: "overlay", text: String(text), url: location.href }));
			} catch {}
		}

		// ── Compact Chat root (verbatim from Orb, CSS included) ──
		const css = "html,body{height:100%;margin:0;overflow:hidden}html{background:0 0}body{background:var(--dsw-alias-bg-base)}#root{height:100%}.p0qSPW_shell{box-sizing:border-box;--dsh-chat-content-width:100%;--dsh-composer-side-clearance:0px;height:100%;overflow:auto}.p0qSPW_shell [data-chat-turn-rail]{display:none}[data-overlay-chat] .p0qSPW_shell :is(.DYkZvW_toBottomSlot,.DYkZvW_toBottom){display:none}.p0qSPW_inputOverlay{width:0;height:0;overflow:visible}";
		/**
		 * Harness 0.2 keeps its layout inside the overlay iframe; reduce it to the transcript the way Orb's Compact
		 * Chat looked: no sidebars, conversation header, composer (the floating panel has its own input) or width
		 * handles, and the center column filling the panel. Selectors use the layout's stable data attributes.
		 */
		const COMPACT_LAYOUT_CSS = [
			'[data-slot="root"]>div{display:block!important;height:100%!important;width:100%!important}',
			'[data-slot="root"]>div>div:has(>[data-slot="sidebar"]),[data-rightbar-col],[data-slot="rightbar"]{display:none!important}',
			'[data-slot="root"]>div>div:has(>[data-slot="main"]){width:100%!important;height:100%!important;max-width:none!important}',
			'[data-slot="conversation.header"],[data-composer-seat],[data-width-handle]{display:none!important}',
			'[data-conversation-content]{--dsh-chat-content-width:100%;--dsh-composer-side-clearance:0px}',
			'[data-chat-turn-rail]{display:none!important}'
		].join("");
		const tagId = "dsh-orb/OverlayChatRoot.module.css";
		if (overlayClientSurface() && typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-orb";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css + COMPACT_LAYOUT_CSS;
			document.head.appendChild(tag);
		}
		const styles = { inputOverlay: "p0qSPW_inputOverlay", shell: "p0qSPW_shell" };
		function ignoreView(_view, _focus) {}
		function ignoreRequest() {}
		let renderedOnce = false;
		/**
		 * Compact Chat root for Harness 0.2: the same session conversation the main window shows under
		 * `main` -> `main.conversation`, without the sidebar, right bar and shell chrome (hidden further by CSS).
		 * The session comes from the shell's `dsh.overlay.session` message (retained as mainView below).
		 */
		function OverlayChatRoot(props) {
			if (!renderedOnce) {
				renderedOnce = true;
				shellLog("compact root render; props: " + Object.keys(props ?? {}).join(","));
			}
			return (0, react_jsx_runtime.jsx)("div", {
				className: styles.shell,
				"data-conversation-scroll": "",
				"data-overlay-chat": "",
				children: props.renderSlot("main", {}, { entryKey: "conversation" })
			});
		}

		const inject = ["slots", "sessions", "uiWorkspace"];
		function apply(ctx) {
			if (!overlayClientSurface()) return;
			shellLog("compact chat active; search=" + INITIAL_SEARCH);
			// The 0.2 layout always occupies `root`; a lower priority number shadows it (single slots elect the lowest).
			// Harness 0.2 forbids re-declaring the layout's child slots, so Compact Chat keeps the layout and
			// hides its chrome with the overlay stylesheet instead of replacing `root`.
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
						// Harness 0.2 shows the workspace's current session in `main`; switch it to the floating session.
						ctx.uiWorkspace.openSession(overlaySessionId(id));
						shellLog("open session " + id);
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
