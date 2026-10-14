// orb-bridge.js — recreates Orb 0.1.7's `window.dshDesktop` preload bridge (lib/preload.cjs) inside WebView2.
// Same shape and semantics as the Electron preload: window/focus/selection operations go to the native companion
// over `chrome.webview` messages; preference operations go to the dsh-orb Host routes (/.dsh/orb/api/<op>).
;(() => {
	// orb-shell (wry) exposes window.ipc.postMessage(string) and calls window.__orbBridgeReceive(message) back.
	const native = window.ipc?.postMessage === undefined ? undefined : { postMessage: (message) => window.ipc.postMessage(JSON.stringify(message)) }
	const pending = new Map()
	const listeners = new Map()
	let nextId = 1

	window.__orbBridgeReceive = (message) => {
		if (typeof message !== 'object' || message === null) return
		if (message.type === 'reply') {
			const entry = pending.get(message.id)
			if (entry === undefined) return
			pending.delete(message.id)
			if (message.error !== undefined) entry.reject(new Error(message.error))
			else entry.resolve(message.value)
			return
		}
		if (message.type === 'event') for (const listener of listeners.get(message.channel) ?? []) listener(message.payload)
	}

	/** Invoke a native companion operation (the Electron `ipcRenderer.invoke` equivalent). */
	function invoke(op, ...args) {
		if (native === undefined) return Promise.reject(new Error('orb-shell bridge is unavailable'))
		const id = nextId++
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			native.postMessage({ type: 'invoke', id, op, args })
		})
	}

	/** Subscribe to a companion-pushed channel (the Electron `ipcRenderer.on` equivalent). */
	function on(channel, listener) {
		const set = listeners.get(channel) ?? new Set()
		set.add(listener)
		listeners.set(channel, set)
		return () => set.delete(listener)
	}

	async function host(op, ...args) {
		const response = await fetch(`/.dsh/orb/api/${op}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(args),
		})
		const value = await response.json()
		if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
		return value
	}

	/** Host-side writes that Orb's main process echoed back to the floating window. */
	async function setOverlayModel(selection) {
		await host('overlayModelSet', selection)
		for (const listener of listeners.get('overlay-model') ?? []) listener(selection)
	}


	// ── context menu: Orb lib/main.js floatingContextMenuTemplate / floatingAgentModelItems, shown natively ──
	const CURRENT_MODEL_MARK = '✓ '
	async function modelCatalog() {
		const rpcId = crypto.randomUUID()
		const response = await fetch('/api/session/modelCatalog', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/modelCatalog', payload: { args: {} } }),
		})
		if (!response.ok) return undefined
		const envelope = await response.json()
		if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) return undefined
		const value = envelope.result.value
		return Array.isArray(value?.groups) ? value : undefined
	}
	function agentModelItems(catalog, current, onSelect, labels, actions) {
		const groups = catalog?.groups ?? []
		if (groups.length === 0) return [{ label: labels.empty, enabled: false }]
		const items = []
		for (const group of groups) {
			items.push({ label: group.name, enabled: false })
			for (const model of group.models) {
				const selected = current.provider === group.id && current.model === model.id
				const reasoning = model.reasoning
				if (reasoning === undefined) {
					items.push({ label: model.name, checked: selected, id: actions.add(() => onSelect({ provider: group.id, model: model.id })) })
					continue
				}
				const effective = selected ? current.reasoningEffort ?? reasoning.defaultEffort : undefined
				const efforts = []
				if (reasoning.defaultEffort === undefined) efforts.push({ label: labels.defaultEffort, checked: selected && current.reasoningEffort === undefined, id: actions.add(() => onSelect({ provider: group.id, model: model.id })) })
				for (const effort of reasoning.efforts) efforts.push({ label: effort.name, checked: effective === effort.id, id: actions.add(() => onSelect({ provider: group.id, model: model.id, reasoningEffort: effort.id })) })
				items.push(efforts.length === 0
					? { label: model.name, checked: selected, id: actions.add(() => onSelect({ provider: group.id, model: model.id })) }
					: { label: selected ? CURRENT_MODEL_MARK + model.name : model.name, submenu: efforts })
			}
		}
		return items
	}
	async function showContextMenu(event) {
		const { messages } = await host('locale')
		const actions = { list: [], add(fn) { this.list.push(fn); return this.list.length } }
		const [catalog, overlay, background, selectionEnabled, millifraction] = await Promise.all([
			modelCatalog().catch(() => undefined), host('overlayModelGet'), host('backgroundModelGet'), host('selectionEnabledGet'), host('millifractionGet'),
		])
		const labels = { empty: messages.floatingNoModels, defaultEffort: messages.floatingEffortDefault }
		const items = [
			{ label: messages.floatingOpenMain, id: actions.add(() => invoke('floatingFocusMain')) },
			{ separator: true },
			{ label: messages.floatingAgentSettings, submenu: agentModelItems(catalog, overlay, setOverlayModel, labels, actions) },
			{ label: messages.floatingBackgroundAgentSettings, submenu: agentModelItems(catalog, background, (next) => host('backgroundModelSet', next), labels, actions) },
			{ separator: true },
			{ label: selectionEnabled ? messages.selectionToolbarDisable : messages.selectionToolbarEnable, id: actions.add(() => host('selectionEnabledSet', !selectionEnabled).then(() => invoke('selectionReload').catch(() => {}))) },
			{ label: millifraction ? messages.millifractionDisable : messages.millifractionEnable, id: actions.add(() => toggleMillifraction(!millifraction, messages)) },
			{ separator: true },
			{ label: messages.floatingQuit, id: actions.add(() => invoke('floatingQuit')) },
		]
		const target = event.target
		const editable = target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea'))
		const edit = editable ? [
			{ label: 'Cut', id: actions.add(() => document.execCommand('cut')) },
			{ label: 'Copy', id: actions.add(() => document.execCommand('copy')) },
			{ label: 'Paste', id: actions.add(() => navigator.clipboard.readText().then((text) => document.execCommand('insertText', false, text))) },
			{ separator: true },
		] : []
		const chosen = await invoke('contextMenu', [...edit, ...items])
		if (typeof chosen === 'number') await actions.list[chosen - 1]?.()
	}
	/** Orb's applyMillifractionCoordinates: confirm, persist, push to the Host, then start a fresh overlay chat. */
	async function toggleMillifraction(enabled, messages) {
		const text = [messages.millifractionConfirmTitle, messages.millifractionConfirmMessage, messages.millifractionConfirmDetail].filter(Boolean).join('\n\n')
		if (!window.confirm(text)) return
		await host('millifractionSet', enabled)
		for (const listener of listeners.get('create-session') ?? []) listener()
	}
	document.addEventListener('contextmenu', (event) => {
		event.preventDefault()
		void showContextMenu(event)
	})

	// ── panel resize (dsh-orb addition; Orb's panel was a fixed 320x420) ──
	// Drag the panel's outer edges away from the ball (the panel grows away from it), like a window border.
	// Handles live on <body> so they are positioned against the window; CSP is style-src 'self', so CSSOM only.
	function installResizeHandles() {
		if (document.querySelector('[data-orb-resize]') !== null) return
		const make = (kind) => {
			const el = document.createElement('div')
			el.dataset.orbResize = kind
			Object.assign(el.style, { position: 'fixed', zIndex: '2147483647', touchAction: 'none', background: 'transparent' })
			document.body.append(el)
			return el
		}
		const handles = { x: make('x'), y: make('y'), xy: make('xy') }
		const layout = () => {
			const left = document.body.classList.contains('expand-left')
			const up = document.body.classList.contains('expand-up')
			const show = document.body.classList.contains('expanded') && document.querySelector('#panel')?.hidden !== true
			// Window = 12px margin + panel card; the strips straddle the card's border (6px .. 18px from the edge).
			Object.assign(handles.x.style, { display: show ? '' : 'none', width: '12px', top: '48px', bottom: '48px', left: left ? '6px' : '', right: left ? '' : '6px', cursor: 'ew-resize' })
			Object.assign(handles.y.style, { display: show ? '' : 'none', height: '12px', left: '48px', right: '48px', top: up ? '6px' : '', bottom: up ? '' : '6px', cursor: 'ns-resize' })
			Object.assign(handles.xy.style, { display: show ? '' : 'none', width: '22px', height: '22px', left: left ? '4px' : '', right: left ? '' : '4px', top: up ? '4px' : '', bottom: up ? '' : '4px', cursor: left === up ? 'nwse-resize' : 'nesw-resize' })
			return { left, up }
		}
		new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: false })
		const panel = document.querySelector('#panel')
		if (panel !== null) new MutationObserver(layout).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
		layout()
		let drag
		for (const [kind, el] of Object.entries(handles)) {
			el.addEventListener('pointerdown', async (event) => {
				event.preventDefault()
				event.stopPropagation()
				el.setPointerCapture(event.pointerId)
				const size = await invoke('floatingPanelSize')
				drag = { ...layout(), kind, x: event.screenX, y: event.screenY, width: size.width, height: size.height, pending: false }
			})
			el.addEventListener('pointermove', (event) => {
				if (drag === undefined || drag.pending) return
				const dx = event.screenX - drag.x, dy = event.screenY - drag.y
				const width = drag.kind === 'y' ? drag.width : drag.width + (drag.left ? -dx : dx)
				const height = drag.kind === 'x' ? drag.height : drag.height + (drag.up ? -dy : dy)
				drag.pending = true
				void invoke('floatingResize', width, height).finally(() => { if (drag !== undefined) drag.pending = false })
			})
			const end = () => { drag = undefined }
			el.addEventListener('pointerup', end)
			el.addEventListener('pointercancel', end)
		}
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installResizeHandles)
	else installResizeHandles()

	window.dshDesktop = {
		protocolVersion: 1,
		locale: () => host('locale'),
		backend: {
			status: () => host('backendStatus'),
			subscribe: (listener) => on('backend-state', listener),
		},
		floating: {
			move: (x, y, canDock) => invoke('floatingMove', x, y, canDock),
			clamp: (canDock) => invoke('floatingClamp', canDock),
			unsnap: () => invoke('floatingUnsnap'),
			setExpanded: (expanded) => invoke('floatingSetExpanded', expanded),
			sessionId: () => host('sessionGet'),
			setSessionId: (sessionId) => host('sessionSet', sessionId),
			overlayModel: () => host('overlayModelGet'),
			setOverlayModel,
			onOverlayModel: (listener) => on('overlay-model', listener),
			overlayPermission: () => host('permissionGet'),
			setOverlayPermission: (preset, sessionId) => host('permissionSet', preset, sessionId),
			orbWorkspacePath: () => host('orbWorkspace'),
			focusMain: () => invoke('floatingFocusMain'),
			quit: () => invoke('floatingQuit'),
			setSessionRunning: (running) => invoke('floatingRunning', running),
			setTextEditing: (editing) => invoke('floatingEditing', editing),
			restoreFrontApp: () => invoke('floatingRestoreFront'),
			avatarUrl: () => host('avatarUrl'),
			onAvatar: (listener) => on('avatar', listener),
			onSelectionPrompt: (listener) => on('selection-prompt', listener),
			onSelectionAttach: (listener) => on('selection-attach', listener),
			onCreateSession: (listener) => on('create-session', () => listener()),
			// macOS privacy (TCC) rights do not apply on Windows; Orb's TccController reported this shape.
			tccStatus: async () => ({ applicable: false, appName: 'DeepSeek Harness', screen: 'granted', accessibility: 'granted' }),
			openTcc: async () => ({ applicable: false, appName: 'DeepSeek Harness', screen: 'granted', accessibility: 'granted' }),
			relaunch: async () => {},
			onTccStatus: (listener) => on('tcc', listener),
		},
		selection: {
			search: () => invoke('selectionSearch'),
			translate: () => invoke('selectionTranslate'),
			sendToAgent: () => invoke('selectionAttach'),
			setLanguage: (language) => invoke('selectionSetLanguage', language),
			interact: () => invoke('selectionInteract'),
			setContentSize: (size) => invoke('selectionSetContentSize', size),
			onState: (listener) => on('selection-state', listener),
		},
	}
})()
