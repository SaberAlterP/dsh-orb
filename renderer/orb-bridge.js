// orb-bridge.js — recreates Orb 0.1.7's `window.dshDesktop` preload bridge (lib/preload.cjs) inside WebView2.
// Same shape and semantics as the Electron preload: window/focus/selection operations go to the native companion
// over `chrome.webview` messages; preference operations go to the dsh-orb Host routes (/.dsh/orb/api/<op>).
;(() => {
	const native = window.chrome?.webview
	const pending = new Map()
	const listeners = new Map()
	let nextId = 1

	native?.addEventListener('message', (event) => {
		const message = event.data
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
	})

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
