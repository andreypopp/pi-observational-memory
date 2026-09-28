import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

export const PROMOTE_STATUS_WIDGET = "om-promote";

export type PromoteStatus = {
	/** Show `label` above the editor, replacing any label shown. */
	show(label: string): void;
	/** Remove the widget and stop its spinner; safe to call when nothing is shown. */
	hide(): void;
};

const NO_STATUS: PromoteStatus = { show() {}, hide() {} };

/**
 * A spinner widget like Pi's "Compacting context..." status: Pi's `Loader` with its colours, or a plain
 * line when the host's pi-tui has no `Loader`. Does nothing without an interactive UI.
 */
export function promoteStatus(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): PromoteStatus {
	const ui = ctx.ui as Partial<ExtensionCommandContext["ui"]> | undefined;
	if (!ctx.hasUI || typeof ui?.setWidget !== "function") return NO_STATUS;
	const setWidget = ui.setWidget.bind(ui);
	const Loader = (piTui as { Loader?: typeof piTui.Loader }).Loader;
	let stopLoader: (() => void) | undefined;
	let shown = false;

	const hide = () => {
		stopLoader?.();
		stopLoader = undefined;
		if (!shown) return;
		shown = false;
		setWidget(PROMOTE_STATUS_WIDGET, undefined);
	};
	return {
		show(label) {
			hide();
			shown = true;
			if (typeof Loader !== "function") {
				setWidget(PROMOTE_STATUS_WIDGET, [label], { placement: "aboveEditor" });
				return;
			}
			setWidget(PROMOTE_STATUS_WIDGET, (tui, theme) => {
				const loader = new Loader(tui, (spinner) => theme.fg("accent", spinner), (text) => theme.fg("muted", text), label);
				const stop = () => loader.stop();
				stopLoader = stop;
				return Object.assign(loader, { dispose: stop });
			}, { placement: "aboveEditor" });
		},
		hide,
	};
}
