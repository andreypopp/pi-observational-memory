import { describe, expect, it, vi } from "vitest";

import { statusWidget } from "../src/commands/status-widget.js";

function fakeUI() {
	const rendered: { key: string; lines?: string[]; loader?: any }[] = [];
	const setWidget = vi.fn((key: string, content: unknown) => {
		if (content === undefined) return void rendered.push({ key });
		if (Array.isArray(content)) return void rendered.push({ key, lines: content });
		const loader = (content as any)({ requestRender() {} }, { fg: (_color: string, text: string) => text });
		rendered.push({ key, loader });
	});
	return { ctx: { hasUI: true, ui: { setWidget } } as any, setWidget, rendered };
}

const text = (loader: any) => loader.render(200).join("").trim();

describe("statusWidget", () => {
	it("keeps one spinner and only changes its message", () => {
		const { ctx, setWidget, rendered } = fakeUI();
		const status = statusWidget(ctx, "om-ground");

		status.show("Grounding: observing…");
		status.show("Grounding: reflecting…");

		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(text(rendered[0].loader)).toContain("Grounding: reflecting…");
		const stop = vi.spyOn(rendered[0].loader, "stop");
		status.hide();
		expect(stop).toHaveBeenCalled();
		expect(setWidget).toHaveBeenLastCalledWith("om-ground", undefined);
	});

	it("shows a plain line when asked, and switches between plain and spinner", () => {
		const { ctx, setWidget, rendered } = fakeUI();
		const status = statusWidget(ctx, "om-ground");

		status.show("Grounding: checking… 2 tool calls, 5s", { spinner: false });
		status.show("Grounding: checking… 3 tool calls, 6s", { spinner: false });
		expect(rendered.map((item) => item.lines)).toEqual([["Grounding: checking… 2 tool calls, 5s"], ["Grounding: checking… 3 tool calls, 6s"]]);

		status.show("Grounding: observing…");
		expect(setWidget).toHaveBeenNthCalledWith(3, "om-ground", undefined);
		expect(text(rendered[3].loader)).toContain("observing…");
		status.hide();
		status.hide();
		expect(setWidget).toHaveBeenCalledTimes(5);
	});

	it("does nothing without an interactive UI", () => {
		const { setWidget } = fakeUI();
		const status = statusWidget({ hasUI: false, ui: { setWidget } } as any, "om-ground");

		status.show("x");
		status.hide();

		expect(setWidget).not.toHaveBeenCalled();
	});
});
