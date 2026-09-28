import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type NotifyLevel = "info" | "warning" | "error";
export type Notify = (message: string, level?: NotifyLevel) => void;

/** Notify through the UI when there is one, else print. */
export function commandNotify(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): Notify {
	const hasUI = ctx.hasUI;
	const ui = ctx.ui;
	return (message, level = "info") => {
		if (hasUI && ui) ui.notify(message, level);
		else console.log(message);
	};
}
