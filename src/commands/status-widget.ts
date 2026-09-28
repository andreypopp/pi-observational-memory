import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

export type StatusWidget = {
	/**
	 * Show `label` above the editor, replacing any label shown. A shown spinner is kept and only its
	 * message changes; `spinner: false` shows a plain line instead (for use under Pi's own spinner).
	 */
	show(label: string, options?: { spinner?: boolean }): void;
	/** Remove the widget and stop its spinner; safe to call when nothing is shown. */
	hide(): void;
};

const NO_STATUS: StatusWidget = { show() {}, hide() {} };

type LoaderLike = { setMessage?: (message: string) => void; stop: () => void };

/**
 * A status line like Pi's "Compacting context..." one, keyed so commands do not clear each other's:
 * Pi's `Loader` with its colours, or a plain line when asked for one or when the host's pi-tui has no
 * `Loader`. Does nothing without an interactive UI.
 */
export function statusWidget(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, key: string): StatusWidget {
	const ui = ctx.ui as Partial<ExtensionCommandContext["ui"]> | undefined;
	if (!ctx.hasUI || typeof ui?.setWidget !== "function") return NO_STATUS;
	const setWidget = ui.setWidget.bind(ui);
	const Loader = (piTui as { Loader?: typeof piTui.Loader }).Loader;
	let loader: LoaderLike | undefined;
	let shown: "spinner" | "plain" | undefined;
	let pendingLabel = "";

	const hide = () => {
		loader?.stop();
		loader = undefined;
		if (!shown) return;
		shown = undefined;
		setWidget(key, undefined);
	};
	const show = (label: string, options?: { spinner?: boolean }) => {
		const spinner = options?.spinner !== false && typeof Loader === "function";
		// The factory may not have run yet (no loader); it then picks up the latest label.
		if (spinner && shown === "spinner" && (!loader || loader.setMessage)) {
			pendingLabel = label;
			loader?.setMessage?.(label);
			return;
		}
		// Replacing a plain line needs no clear first.
		if (!(shown === "plain" && !spinner)) hide();
		if (!spinner) {
			shown = "plain";
			setWidget(key, [label], { placement: "aboveEditor" });
			return;
		}
		shown = "spinner";
		pendingLabel = label;
		setWidget(key, (tui, theme) => {
			const component = new Loader!(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), pendingLabel);
			const stop = () => component.stop();
			loader = { setMessage: typeof component.setMessage === "function" ? (message) => component.setMessage(message) : undefined, stop };
			return Object.assign(component, { dispose: stop });
		}, { placement: "aboveEditor" });
	};
	return { show, hide };
}
