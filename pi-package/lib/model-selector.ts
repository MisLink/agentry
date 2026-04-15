import { modelsAreEqual, type Api, type Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type Component,
	type TUI,
} from "@mariozechner/pi-tui";

export const MODEL_SELECTOR_VISIBLE_ITEMS = 10;

type SelectorTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export type ModelSelectorItem = {
	provider: string;
	id: string;
	label: string;
	searchText: string;
	model: Model<Api>;
	isCurrent: boolean;
};

export type ModelSelectorWindow = {
	items: ModelSelectorItem[];
	startIndex: number;
	endIndex: number;
	selectedIndex: number;
	hasScrollIndicator: boolean;
	total: number;
};

export type ModelSelectorContext = Pick<ExtensionContext, "hasUI" | "model" | "modelRegistry" | "ui">;

export type SelectModelOptions = {
	title?: string;
	noModelsMessage?: string;
};

export function formatModelSelectorLabel(item: ModelSelectorItem): string {
	return `${item.id} [${item.provider}]${item.isCurrent ? " ✓" : ""}`;
}

export function buildModelSelectorItems(
	availableModels: Model<Api>[],
	currentModel: Model<Api> | undefined,
): ModelSelectorItem[] {
	const seen = new Set<string>();
	const items: ModelSelectorItem[] = [];

	for (const model of availableModels) {
		const key = modelKey(model);
		if (seen.has(key)) continue;
		seen.add(key);

		const item: ModelSelectorItem = {
			provider: model.provider,
			id: model.id,
			label: "",
			searchText: [
				model.id,
				model.provider,
				`${model.provider}/${model.id}`,
				model.name,
			].join(" "),
			model,
			isCurrent: modelsAreEqual(currentModel, model),
		};
		item.label = formatModelSelectorLabel(item);
		items.push(item);
	}

	return items.sort((a, b) => {
		if (a.isCurrent && !b.isCurrent) return -1;
		if (!a.isCurrent && b.isCurrent) return 1;
		const providerOrder = a.provider.localeCompare(b.provider);
		if (providerOrder !== 0) return providerOrder;
		return a.id.localeCompare(b.id);
	});
}

export function filterModelSelectorItems(items: ModelSelectorItem[], query: string): ModelSelectorItem[] {
	const normalized = query.trim();
	if (!normalized) return items;
	return fuzzyFilter(items, normalized, (item) => item.searchText);
}

export function findModelSelectorItemByLabel(
	items: ModelSelectorItem[],
	selectedLabel: string | undefined,
): ModelSelectorItem | null {
	if (!selectedLabel) return null;
	return items.find((item) => item.label === selectedLabel) ?? null;
}

export function buildModelSelectorWindow(
	items: ModelSelectorItem[],
	selectedIndex: number,
	visibleItems = MODEL_SELECTOR_VISIBLE_ITEMS,
): ModelSelectorWindow {
	const total = items.length;
	const safeVisibleItems = Math.max(1, visibleItems);
	const normalizedSelectedIndex = total === 0
		? 0
		: Math.max(0, Math.min(selectedIndex, total - 1));
	const startIndex = Math.max(
		0,
		Math.min(
			normalizedSelectedIndex - Math.floor(safeVisibleItems / 2),
			total - safeVisibleItems,
		),
	);
	const endIndex = Math.min(startIndex + safeVisibleItems, total);
	return {
		items: items.slice(startIndex, endIndex),
		startIndex,
		endIndex,
		selectedIndex: normalizedSelectedIndex,
		hasScrollIndicator: startIndex > 0 || endIndex < total,
		total,
	};
}

export async function selectModelForExtension(
	ctx: ModelSelectorContext,
	options: SelectModelOptions = {},
): Promise<Model<Api> | null> {
	if (!ctx.hasUI) return (ctx.model as Model<Api> | undefined) ?? null;

	ctx.modelRegistry.refresh();
	const registryError = ctx.modelRegistry.getError();
	const items = buildModelSelectorItems(ctx.modelRegistry.getAvailable(), ctx.model as Model<Api> | undefined);
	if (items.length === 0) {
		ctx.ui.notify(options.noModelsMessage ?? "No configured models are available.", "error");
		return null;
	}

	const selected = await ctx.ui.custom<Model<Api> | undefined>((tui, theme, _keybindings, done) => (
		new ModelSelectorComponent(
			tui,
			theme,
			options.title ?? "Select model",
			items,
			(model) => done(model),
			() => done(undefined),
			registryError,
		)
	));

	return selected ?? null;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

class ModelSelectorComponent extends Container implements Component {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly theme: SelectorTheme;
	private readonly allItems: ModelSelectorItem[];
	private readonly onSelect: (model: Model<Api>) => void;
	private readonly onCancel: () => void;
	private readonly registryError: string | undefined;
	private filteredItems: ModelSelectorItem[];
	private selectedIndex = 0;
	private focusedValue = false;

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: SelectorTheme,
		title: string,
		allItems: ModelSelectorItem[],
		onSelect: (model: Model<Api>) => void,
		onCancel: () => void,
		registryError?: string,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allItems = allItems;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.registryError = registryError;
		this.filteredItems = allItems;
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.searchInput.onEscape = () => this.onCancel();

		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Only showing models from configured providers. Type to filter."), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "↑↓ navigate  Enter select  Esc cancel"), 1, 0));
		this.updateList();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.selectCurrent();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.applyFilter();
	}

	private applyFilter(): void {
		this.filteredItems = filterModelSelectorItems(this.allItems, this.searchInput.getValue());
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.tui.requestRender();
	}

	private moveSelection(delta: -1 | 1): void {
		if (this.filteredItems.length === 0) return;
		const nextIndex = this.selectedIndex + delta;
		this.selectedIndex = (nextIndex + this.filteredItems.length) % this.filteredItems.length;
		this.updateList();
		this.tui.requestRender();
	}

	private selectCurrent(): void {
		const selected = this.filteredItems[this.selectedIndex];
		if (selected) this.onSelect(selected.model);
	}

	private updateList(): void {
		this.listContainer.clear();
		const window = buildModelSelectorWindow(this.filteredItems, this.selectedIndex);

		for (let index = window.startIndex; index < window.endIndex; index += 1) {
			const item = this.filteredItems[index];
			if (!item) continue;
			this.listContainer.addChild(new Text(this.formatLine(item, index === window.selectedIndex), 1, 0));
		}

		if (window.hasScrollIndicator) {
			this.listContainer.addChild(new Text(
				this.theme.fg("muted", `  (${window.selectedIndex + 1}/${window.total})`),
				1,
				0,
			));
		}

		if (this.registryError) {
			this.listContainer.addChild(new Text(this.theme.fg("error", `  ${this.registryError}`), 1, 0));
		} else if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 1, 0));
		} else {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(this.theme.fg("muted", `  Model Name: ${selected.model.name}`), 1, 0));
			}
		}
	}

	private formatLine(item: ModelSelectorItem, selected: boolean): string {
		const checkmark = item.isCurrent ? this.theme.fg("success", " ✓") : "";
		const providerBadge = this.theme.fg("muted", `[${item.provider}]`);
		if (selected) {
			return `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", item.id)} ${providerBadge}${checkmark}`;
		}
		return `  ${this.theme.fg("text", item.id)} ${providerBadge}${checkmark}`;
	}
}
