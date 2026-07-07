import { Menu, Notice, Plugin } from "obsidian";
import { around } from "monkey-around";

type Point = { x: number; y: number };
type BranchState = { depth: number; color: number; order: number; dir?: Point };
type OverrideMap = Map<string, BranchState>;
type NativeNode = { raw: any; pos: Point };

type OverlayNodeMeta = {
	path: string;
	pos: Point;
	colors: number[];
	owners: string[];
	depth: number;
	radius: number;
};

type OverlayEdgeMeta = {
	source: string;
	target: string;
	colors: number[];
};

type RelativeOffset = {
	anchorPath: string;
	dx: number;
	dy: number;
};

type LayoutNode = {
	path: string;
	x: number;
	y: number;
	depth: number;
	radius: number;
	labelWidth: number;
	fixed: boolean;
};

type ChildPlacement = {
	node: LayoutNode;
	angle: number;
	radius: number;
};

export default class ExpansiveGraphPlugin extends Plugin {
	private rightClickPatched = new WeakSet<object>();
	private queueRenderPatched = new WeakSet<object>();
	private lastMenuPosition: { x: number; y: number } | null = null;
	private overridesByLeaf = new WeakMap<any, OverrideMap>();
	private overlayByLeaf = new WeakMap<any, any>();
	private offsetsByLeaf = new WeakMap<any, Map<string, RelativeOffset>>();
	private branchCounterByLeaf = new WeakMap<any, number>();

	private readonly ROOT_RADIUS = 130;
	private readonly CHILD_RADIUS = 110;
	private readonly MAX_RADIUS_MULT = 3.5;
	private readonly ROW_GAP = 48;
	private readonly RELAX_ITERS = 30;
	private readonly NODE_PADDING = 14;

	private readonly PALETTE = [
		0x6ea8fe, 0xff9f43, 0x4cd137, 0xe056fd,
		0xfeca57, 0x00d2d3, 0xff6b6b, 0x54a0ff,
	];

	async onload() {
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.patchAllLocalGraphs())
		);
		new Notice("Expansive Graph loaded");
		this.patchAllLocalGraphs();
	}

	// ─── PATCHING ────────────────────────────────────────────────────────────

	private patchAllLocalGraphs() {
		for (const leaf of this.app.workspace.getLeavesOfType("localgraph")) {
			const view = (leaf as any)?.view;
			if (!view) continue;
			this.patchRightClick(leaf, view);
			const renderer = view?.renderer;
			if (renderer && typeof renderer.queueRender === "function" && !this.queueRenderPatched.has(renderer)) {
				this.patchQueueRender(leaf, renderer);
			}
		}
	}

	private patchRightClick(leaf: any, view: any) {
		const targets = [view, view?.engine, view?.renderer].filter(Boolean);

		for (const target of targets) {
			if (!target || this.rightClickPatched.has(target) || typeof target.onNodeRightClick !== "function") continue;
			this.rightClickPatched.add(target);

			this.register(
				around(target, {
					onNodeRightClick: (orig: Function) => {
						const plugin = this;

						return function (...args: any[]) {
							const event = plugin.findMouseEvent(args);
							const nodePath = plugin.extractPathFromArgs(args);
							const result = orig?.apply(this, args);

							if (!event || !nodePath) return result;

							plugin.lastMenuPosition = { x: event.clientX, y: event.clientY };

							const menu = new Menu();
							plugin.buildBranchMenu(menu, leaf, view, nodePath, true);
							setTimeout(() => {
								const pos = plugin.lastMenuPosition ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
								menu.showAtPosition(pos);
							}, 0);

							return result;
						};
					},
				})
			);
		}
	}

	private patchQueueRender(leaf: any, renderer: any) {
		this.queueRenderPatched.add(renderer);
		this.register(
			around(renderer, {
				queueRender: (orig: Function) => {
					const plugin = this;
					return function (...args: any[]) {
						const result = orig?.apply(this, args);
						try { plugin.drawOverlay(leaf, renderer); } catch (e) { console.warn("[ExpGraph] drawOverlay error", e); }
						return result;
					};
				},
			})
		);
	}

	// ─── MENU ─────────────────────────────────────────────────────────────────

	private buildBranchMenu(menu: Menu, leaf: any, view: any, nodePath: string, isRootMenu = false) {
		const overrides = this.getOverrides(leaf);
		const branch = overrides.get(nodePath);
		const depth = branch?.depth ?? 0;
		const label = this.basename(nodePath).replace(/\.md$/i, "");

		menu.addItem((item) =>
			item
				.setTitle(`Expand ${isRootMenu ? "here" : label} (+1) [depth=${depth}]`)
				.setIcon("plus-circle")
				.onClick(() => {
					this.ensureBranch(leaf, nodePath, 1);
					this.safeRefresh(view);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle(isRootMenu ? "Reduce here (-1)" : `Reduce ${label} (-1)`)
				.setIcon("minus-circle")
				.setDisabled(depth <= 0)
				.onClick(() => {
					this.reduceBranch(leaf, nodePath);
					this.safeRefresh(view);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle(isRootMenu ? "Reset this branch" : `Reset ${label}`)
				.setIcon("rotate-ccw")
				.setDisabled(depth <= 0)
				.onClick(() => {
					this.getOverrides(leaf).delete(nodePath);
					this.safeRefresh(view);
				})
		);

		const expandedChildren = this.getExpandedOverlayChildrenForBranch(leaf, view, nodePath);

		if (expandedChildren.length) {
			menu.addSeparator();

			menu.addItem((item) =>
				item
					.setTitle(`Expanded children (${expandedChildren.length})`)
					.setIcon("list-tree")
					.onClick(() => {
						const childListMenu = new Menu();

						for (const childPath of expandedChildren) {
							const childDepth = overrides.get(childPath)?.depth ?? 0;
							const childLabel = this.basename(childPath).replace(/\.md$/i, "");

							childListMenu.addItem((childItem) =>
								childItem
									.setTitle(`${childLabel}${childDepth > 0 ? ` [${childDepth}]` : ""}`)
									.setIcon("dot-network")
									.onClick(() => {
										const childMenu = new Menu();
										this.buildBranchMenu(childMenu, leaf, view, childPath, false);

										setTimeout(() => {
											const pos = this.bumpMenuPosition();
											childMenu.showAtPosition(pos);
										}, 0);
									})
							);
						}

						setTimeout(() => {
							const pos = this.bumpMenuPosition();
							childListMenu.showAtPosition(pos);
						}, 0);
					})
			);
		}

		if (isRootMenu) {
			menu.addSeparator();

			menu.addItem((item) =>
				item
					.setTitle("Reset ALL expansions")
					.setIcon("rotate-ccw")
					.onClick(() => {
						this.overridesByLeaf.set(leaf, new Map());
						this.offsetsByLeaf.set(leaf, new Map());
						this.branchCounterByLeaf.set(leaf, 0);
						this.clearOverlay(leaf);
						this.safeRefresh(view);
					})
			);
		}
	}

	private getExpandedOverlayChildrenForBranch(leaf: any, view: any, rootPath: string): string[] {
		const branchDepth = this.getOverrides(leaf).get(rootPath)?.depth ?? 0;
		if (branchDepth <= 0) return [];

		const renderer = view?.renderer;
		if (!renderer) return [];

		const nativeNodes = this.collectRenderedNodes(renderer);
		const nativePaths = new Set<string>();

		for (const node of nativeNodes) {
			const path = this.extractNodeId(node);
			if (path) nativePaths.add(path);
		}

		const offsets = this.getOffsets(leaf);
		const directNeighbors = this.getNeighbors(rootPath);

		return directNeighbors
			.filter((path) => {
				if (path === rootPath) return false;
				if (nativePaths.has(path)) return false;
				return offsets.has(path) || this.getOverrides(leaf).has(path);
			})
			.sort((a, b) => this.basename(a).localeCompare(this.basename(b)));
	}

	private bumpMenuPosition() {
		const base = this.lastMenuPosition ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
		const next = {
			x: Math.min(base.x + 28, window.innerWidth - 260),
			y: Math.min(base.y + 18, window.innerHeight - 80),
		};
		this.lastMenuPosition = next;
		return next;
	}
	// ─── BRANCH STATE ─────────────────────────────────────────────────────────

	private getOverrides(leaf: any): OverrideMap {
		let m = this.overridesByLeaf.get(leaf);
		if (!m) { m = new Map(); this.overridesByLeaf.set(leaf, m); }
		return m;
	}

	private getOffsets(leaf: any): Map<string, RelativeOffset> {
		let m = this.offsetsByLeaf.get(leaf);
		if (!m) { m = new Map(); this.offsetsByLeaf.set(leaf, m); }
		return m;
	}

	private ensureBranch(leaf: any, path: string, delta = 1): BranchState {
		const overrides = this.getOverrides(leaf);
		const existing = overrides.get(path);
		if (existing) {
			const next = { ...existing, depth: existing.depth + delta };
			overrides.set(path, next);
			return next;
		}
		const counter = this.branchCounterByLeaf.get(leaf) ?? 0;
		this.branchCounterByLeaf.set(leaf, counter + 1);
		const created: BranchState = {
			depth: Math.max(1, delta),
			color: this.PALETTE[counter % this.PALETTE.length],
			order: counter,
		};
		overrides.set(path, created);
		return created;
	}

	private reduceBranch(leaf: any, path: string) {
		const overrides = this.getOverrides(leaf);
		const existing = overrides.get(path);
		if (!existing) return;
		const next = existing.depth - 1;
		if (next <= 0) overrides.delete(path);
		else overrides.set(path, { ...existing, depth: next });
	}

	// ─── OFFSETS ──────────────────────────────────────────────────────────────

	private saveOffset(leaf: any, nodePath: string, anchorPath: string, nodePos: Point, anchorPos: Point) {
		this.getOffsets(leaf).set(nodePath, {
			anchorPath,
			dx: nodePos.x - anchorPos.x,
			dy: nodePos.y - anchorPos.y,
		});
	}

	private resolvePos(leaf: any, nodePath: string, nativeByPath: Map<string, NativeNode>): Point | null {
		const rel = this.getOffsets(leaf).get(nodePath);
		if (!rel) return null;
		const anchor = nativeByPath.get(rel.anchorPath);
		if (!anchor) return null;
		return { x: anchor.pos.x + rel.dx, y: anchor.pos.y + rel.dy };
	}

	private resolveAnyPos(
		leaf: any,
		nodePath: string,
		nativeByPath: Map<string, NativeNode>,
		overlayByPath: Map<string, Point>
	): Point | null {
		const native = nativeByPath.get(nodePath)?.pos;
		if (native) return native;

		const overlay = overlayByPath.get(nodePath);
		if (overlay) return overlay;

		const rel = this.getOffsets(leaf).get(nodePath);
		if (!rel) return null;

		const nativeAnchor = nativeByPath.get(rel.anchorPath)?.pos;
		if (nativeAnchor) {
			return {
				x: nativeAnchor.x + rel.dx,
				y: nativeAnchor.y + rel.dy,
			};
		}

		const overlayAnchor = overlayByPath.get(rel.anchorPath);
		if (overlayAnchor) {
			return {
				x: overlayAnchor.x + rel.dx,
				y: overlayAnchor.y + rel.dy,
			};
		}

		return null;
	}
	private nativeAnchorOf(leaf: any, nodePath: string): string {
		return this.getOffsets(leaf).get(nodePath)?.anchorPath ?? nodePath;
	}

	// ─── DRAW ─────────────────────────────────────────────────────────────────

	private drawOverlay(leaf: any, renderer: any) {
		const overrides = this.getOverrides(leaf);
		if (!overrides.size) { this.clearOverlay(leaf); return; }

		const PIXI = (window as any).PIXI;
		if (!PIXI?.Container || !PIXI?.Graphics || !PIXI?.Text) return;

		const host = this.findPixiHost(renderer);
		if (!host) return;

		let overlay = this.overlayByLeaf.get(leaf);
		if (!overlay) {
			overlay = new PIXI.Container();
			overlay.sortableChildren = true;
			overlay.eventMode = "none";
			host.addChild(overlay);
			this.overlayByLeaf.set(leaf, overlay);
		} else if (overlay.parent !== host) {
			overlay.parent?.removeChild?.(overlay);
			host.addChild(overlay);
		}

		while (overlay.children.length) {
			const c = overlay.children[0];
			overlay.removeChild(c);
			c.destroy?.();
		}

		const nativeNodes = this.collectRenderedNodes(renderer);
		const nativeByPath = new Map<string, NativeNode>();
		for (const n of nativeNodes) {
			const p = this.extractNodeId(n);
			const pos = this.extractRenderedPosition(n);
			if (p && pos) nativeByPath.set(p, { raw: n, pos });
		}
		const overlayResolved = new Map<string, Point>();

		const mergedNodes = new Map<string, OverlayNodeMeta>();
		const mergedEdges = new Map<string, OverlayEdgeMeta>();

		const sortedBranches = Array.from(overrides.entries()).sort((a, b) => a[1].order - b[1].order);

		for (const [rootPath, branch] of sortedBranches) {
			const anchorPos = this.resolveAnyPos(leaf, rootPath, nativeByPath, overlayResolved);
			if (!anchorPos) continue;

			const neighborhood = this.collectNeighborhood(rootPath, branch.depth);
			const rootDir = branch.dir ?? this.computeRootDirection(rootPath, anchorPos, nativeByPath, branch.order);

			if (!branch.dir) {
				this.getOverrides(leaf).set(rootPath, { ...branch, dir: rootDir });
			}

			const coords = this.layoutBranch(leaf, rootPath, anchorPos, neighborhood, nativeByPath, rootDir);

			for (const edge of neighborhood.links) {
				const a = coords.get(edge.source);
				const b = coords.get(edge.target);
				if (!a || !b) continue;
				if (nativeByPath.has(edge.source) && nativeByPath.has(edge.target)) continue;
				const key = this.edgeKey(edge.source, edge.target);
				const ex = mergedEdges.get(key);
				if (ex) { if (!ex.colors.includes(branch.color)) ex.colors.push(branch.color); }
				else mergedEdges.set(key, { source: edge.source, target: edge.target, colors: [branch.color] });
			}

			for (const nodePath of neighborhood.nodes) {
				if (nodePath === rootPath || nativeByPath.has(nodePath)) continue;
				const p = coords.get(nodePath);
				if (!p) continue;

				const existingResolved = this.resolvePos(leaf, nodePath, nativeByPath);

				if (!existingResolved) {
					this.saveOffset(leaf, nodePath, rootPath, p, anchorPos);
				}

				const finalPos = this.resolvePos(leaf, nodePath, nativeByPath) ?? p;
				overlayResolved.set(nodePath, finalPos);
				
				const ex = mergedNodes.get(nodePath);
				if (ex) {
					if (!ex.colors.includes(branch.color)) ex.colors.push(branch.color);
					if (!ex.owners.includes(rootPath)) ex.owners.push(rootPath);
					ex.depth = Math.min(ex.depth, branch.depth);
				} else {
					mergedNodes.set(nodePath, {
						path: nodePath,
						pos: finalPos,
						colors: [branch.color],
						owners: [rootPath],
						depth: branch.depth,
						radius: this.estimateRadius(nodePath),
					});
				}
			}
		}

		// Draw edges
		for (const edge of mergedEdges.values()) {
			const a =
				nativeByPath.get(edge.source)?.pos ??
				mergedNodes.get(edge.source)?.pos ??
				this.resolveAnyPos(leaf, edge.source, nativeByPath, overlayResolved);

			const b =
				nativeByPath.get(edge.target)?.pos ??
				mergedNodes.get(edge.target)?.pos ??
				this.resolveAnyPos(leaf, edge.target, nativeByPath, overlayResolved);

			if (!a || !b) continue;

			const line = new PIXI.Graphics();
			line.zIndex = 1;
			line.eventMode = "none";

			if (edge.colors.length === 1) {
				line.lineStyle(1.8, edge.colors[0], 0.7);
				line.moveTo(a.x, a.y);
				line.lineTo(b.x, b.y);
			} else {
				edge.colors.forEach((color, i) => {
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const len = Math.max(1, Math.hypot(dx, dy));
					const nx = -dy / len;
					const ny = dx / len;
					const shift = (i - (edge.colors.length - 1) / 2) * 2;

					line.lineStyle(1.5, color, 0.8);
					line.moveTo(a.x + nx * shift, a.y + ny * shift);
					line.lineTo(b.x + nx * shift, b.y + ny * shift);
				});
			}

			overlay.addChild(line);
		}

		// Draw overlay nodes
		for (const node of mergedNodes.values()) {
			node.radius = Math.max(node.radius, node.colors.length > 1 ? 8 : 7);

			if (node.colors.length === 1) {
				const dot = new PIXI.Graphics();
				dot.zIndex = 2; dot.eventMode = "none";
				dot.beginFill(node.colors[0], 0.95);
				dot.lineStyle(1, 0xffffff, 0.95);
				dot.drawCircle(node.pos.x, node.pos.y, node.radius);
				dot.endFill();
				overlay.addChild(dot);
			} else {
				const sliceAngle = (Math.PI * 2) / node.colors.length;
				node.colors.forEach((color, i) => {
					const wedge = new PIXI.Graphics();
					wedge.zIndex = 2; wedge.eventMode = "none";
					wedge.beginFill(color, 0.95);
					wedge.moveTo(node.pos.x, node.pos.y);
					wedge.arc(node.pos.x, node.pos.y, node.radius, -Math.PI / 2 + i * sliceAngle, -Math.PI / 2 + (i + 1) * sliceAngle);
					wedge.lineTo(node.pos.x, node.pos.y);
					wedge.endFill();
					overlay.addChild(wedge);
				});
				const border = new PIXI.Graphics();
				border.zIndex = 3; border.eventMode = "none";
				border.lineStyle(1, 0xffffff, 0.98);
				border.drawCircle(node.pos.x, node.pos.y, node.radius);
				overlay.addChild(border);
			}

			const lbl = new PIXI.Text(this.basename(node.path).replace(/\.md$/i, ""), { fontSize: 11, fill: node.colors[0] });
			lbl.zIndex = 4; lbl.resolution = 2; lbl.eventMode = "none";
			lbl.x = node.pos.x + node.radius + 4;
			lbl.y = node.pos.y - 7;
			overlay.addChild(lbl);
		}

		// Draw root rings only where the root is actually visible
		for (const [rootPath, branch] of sortedBranches) {
			const nativeRoot = nativeByPath.get(rootPath)?.pos;
			const overlayRoot = mergedNodes.get(rootPath)?.pos;

			const ringPos = nativeRoot ?? overlayRoot;
			if (!ringPos) continue;

			const ring = new PIXI.Graphics();
			ring.zIndex = 5;
			ring.eventMode = "none";
			ring.lineStyle(2.2, branch.color, 0.95);
			ring.drawCircle(ringPos.x, ringPos.y, 11);
			overlay.addChild(ring);
		}
	}

	// ─── LAYOUT ───────────────────────────────────────────────────────────────

	private layoutBranch(
		leaf: any,
		rootPath: string,
		anchorPos: Point,
		neighborhood: { nodes: string[]; links: Array<{ source: string; target: string }> },
		nativeByPath: Map<string, NativeNode>,
		rootDir: Point
	): Map<string, Point> {
		const coords = new Map<string, Point>();
		coords.set(rootPath, anchorPos);

		const adj = new Map<string, string[]>();
		for (const n of neighborhood.nodes) adj.set(n, []);
		for (const { source, target } of neighborhood.links) {
			adj.get(source)?.push(target);
			adj.get(target)?.push(source);
		}

		const parent = new Map<string, string | null>();
		const depth = new Map<string, number>();
		const bfsQueue: string[] = [rootPath];
		parent.set(rootPath, null);
		depth.set(rootPath, 0);

		while (bfsQueue.length) {
			const cur = bfsQueue.shift()!;
			for (const next of adj.get(cur) ?? []) {
				if (parent.has(next)) continue;
				parent.set(next, cur);
				depth.set(next, (depth.get(cur) ?? 0) + 1);
				bfsQueue.push(next);
			}
		}

		const children = new Map<string, string[]>();
		for (const n of neighborhood.nodes) children.set(n, []);
		for (const n of neighborhood.nodes) {
			const p = parent.get(n);
			if (p) children.get(p)?.push(n);
		}
		for (const arr of children.values()) {
			arr.sort((a, b) => this.basename(a).localeCompare(this.basename(b)));
		}

		for (const [p, native] of nativeByPath) {
			if (neighborhood.nodes.includes(p)) coords.set(p, native.pos);
		}

		for (const n of neighborhood.nodes) {
			if (n === rootPath) continue;
			if (coords.has(n)) continue;

			const saved = this.resolvePos(leaf, n, nativeByPath);
			if (saved) coords.set(n, saved);
		}

		const layoutNodes = new Map<string, LayoutNode>();
		for (const n of neighborhood.nodes) {
			if (n === rootPath || nativeByPath.has(n)) continue;

			const saved = this.resolvePos(leaf, n, nativeByPath);
			layoutNodes.set(n, {
				path: n,
				x: saved?.x ?? 0,
				y: saved?.y ?? 0,
				depth: depth.get(n) ?? 1,
				radius: this.estimateRadius(n),
				labelWidth: this.estimateLabelWidth(n),
				fixed: !!saved,
			});
		}

		const place = (node: string) => {
			const nodePos = coords.get(node);
			if (!nodePos) return;

			const kids = (children.get(node) ?? []).filter((k) => !nativeByPath.has(k));
			if (!kids.length) return;

			const d = depth.get(node) ?? 0;
			const baseR = d === 0 ? this.ROOT_RADIUS : this.CHILD_RADIUS;
			const maxR = baseR * this.MAX_RADIUS_MULT;

			const dir =
				node === rootPath
					? rootDir
					: this.computeChildDirection(leaf, node, nodePos, nativeByPath, coords, parent, rootDir);

			const dirAngle = Math.atan2(dir.y, dir.x);
			const sectorAngle = d === 0 ? Math.PI * 0.9 : Math.PI * 0.58;

			const newKids = kids
				.map((k) => layoutNodes.get(k))
				.filter((ln): ln is LayoutNode => !!ln && !ln.fixed);

			const fixedKids = kids
				.map((k) => layoutNodes.get(k))
				.filter((ln): ln is LayoutNode => !!ln && ln.fixed);

			for (const ln of fixedKids) {
				coords.set(ln.path, { x: ln.x, y: ln.y });
			}

			if (newKids.length) {
				const placements = this.planPlacements(dirAngle, sectorAngle, baseR, maxR, newKids);

				for (const pl of placements) {
					pl.node.x = nodePos.x + Math.cos(pl.angle) * pl.radius;
					pl.node.y = nodePos.y + Math.sin(pl.angle) * pl.radius;
				}

				this.relax(nodePos, dirAngle, sectorAngle, placements, maxR);

				for (const pl of placements) {
					coords.set(pl.node.path, { x: pl.node.x, y: pl.node.y });
				}
			}

			for (const k of kids) {
				place(k);
			}
		};

		place(rootPath);

		for (const [p, ln] of layoutNodes) {
			if (!coords.has(p)) {
				coords.set(p, { x: ln.x, y: ln.y });
			}
		}

		return coords;
	}

	private planPlacements(
		dirAngle: number,
		sectorAngle: number,
		baseR: number,
		maxR: number,
		nodes: LayoutNode[]
	): ChildPlacement[] {
		if (!nodes.length) return [];

		const half = sectorAngle / 2;
		const offsets = this.centeredOffsets(nodes.length);
		const maxOff = Math.max(...offsets.map(Math.abs), 0);

		const maxDiam = Math.max(...nodes.map((n) => n.radius * 2 + Math.min(30, n.labelWidth * 0.2)));
		const minChord = maxDiam + this.NODE_PADDING * 2;

		// Determine angle step so all nodes fit within sector
		const baseStep = maxOff === 0 ? 0.01 : (half - 0.05) / maxOff;
		const angleStep = Math.max(0.12, baseStep);

		// Radius needed for chord spacing
		let r = Math.max(baseR, angleStep > 0 ? minChord / (2 * Math.sin(angleStep / 2)) : baseR);
		r = Math.max(r, 80 + Math.max(...nodes.map((n) => n.radius + n.labelWidth * 0.15)));

		if (r <= maxR) {
			return nodes.map((n, i) => ({
				node: n,
				angle: dirAngle + offsets[i] * angleStep,
				radius: r,
			}));
		}

		// Multi-row when nodes don't fit in single arc
		const rowCount = Math.max(2, Math.ceil(r / maxR));
		const rows = this.buildRows(nodes.length, rowCount);
		const result: ChildPlacement[] = [];

		for (let ri = 0; ri < rows.length; ri++) {
			const row = rows[ri];
			const rowNodes = row.map((i) => nodes[i]);
			const rowOff = this.centeredOffsets(row.length);
			const rowMaxOff = Math.max(...rowOff.map(Math.abs), 0);
			const rowStep = rowMaxOff === 0 ? 0.01 : Math.max(0.12, (half - 0.05) / rowMaxOff);
			const rowDiam = Math.max(...rowNodes.map((n) => n.radius * 2 + Math.min(30, n.labelWidth * 0.2)));
			let rowR = Math.max(baseR + ri * this.ROW_GAP, rowDiam / (2 * Math.sin(rowStep / 2)));
			rowR = Math.min(rowR, maxR);

			for (let i = 0; i < row.length; i++) {
				result.push({
					node: nodes[row[i]],
					angle: dirAngle + rowOff[i] * rowStep,
					radius: rowR,
				});
			}
		}

		return result;
	}

	private relax(
		anchor: Point,
		dirAngle: number,
		sectorAngle: number,
		placements: ChildPlacement[],
		maxR: number
	) {
		if (placements.length < 2) return;

		const minA = dirAngle - sectorAngle / 2 + 0.04;
		const maxA = dirAngle + sectorAngle / 2 - 0.04;

		for (let iter = 0; iter < this.RELAX_ITERS; iter++) {
			// Push overlapping nodes apart
			for (let i = 0; i < placements.length; i++) {
				for (let j = i + 1; j < placements.length; j++) {
					const a = placements[i].node;
					const b = placements[j].node;
					if (a.fixed || b.fixed) continue;

					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const dist = Math.hypot(dx, dy);
					const minD = a.radius + b.radius + this.NODE_PADDING +
						Math.min(20, (a.labelWidth + b.labelWidth) * 0.07);

					if (dist >= minD || dist < 0.001) continue;

					const push = (minD - dist) * 0.55;
					const nx = dx / dist;
					const ny = dy / dist;

					// Push radially outward (increase radius), not just angularly
					const aMid = Math.atan2(a.y - anchor.y, a.x - anchor.x);
					const bMid = Math.atan2(b.y - anchor.y, b.x - anchor.x);
					a.x -= nx * push * 0.5; a.y -= ny * push * 0.5;
					b.x += nx * push * 0.5; b.y += ny * push * 0.5;
				}
			}

			// Re-project onto valid sector + expand radius if needed
			for (const pl of placements) {
				const n = pl.node;
				if (n.fixed) continue;

				const dx = n.x - anchor.x;
				const dy = n.y - anchor.y;
				let angle = Math.atan2(dy, dx);
				let radius = Math.hypot(dx, dy);

				angle = Math.max(minA, Math.min(maxA, angle));

				const minR = pl.radius + Math.min(20, n.labelWidth * 0.1);
				radius = Math.max(minR, radius);
				radius = Math.min(maxR, radius);

				n.x = anchor.x + Math.cos(angle) * radius;
				n.y = anchor.y + Math.sin(angle) * radius;
			}
		}
	}

	// ─── DIRECTION ────────────────────────────────────────────────────────────

	/** For root: away from centroid of native neighbors */
	private computeRootDirection(
		rootPath: string,
		anchorPos: Point,
		nativeByPath: Map<string, NativeNode>,
		branchOrder: number
	): Point {
		const neighbors = this.getNeighbors(rootPath)
			.filter((p) => p !== rootPath && nativeByPath.has(p))
			.map((p) => nativeByPath.get(p)!.pos);

		if (neighbors.length) {
			// Away from centroid of native neighbors
			const cx = neighbors.reduce((s, p) => s + p.x, 0) / neighbors.length;
			const cy = neighbors.reduce((s, p) => s + p.y, 0) / neighbors.length;
			return this.normalize({ x: anchorPos.x - cx, y: anchorPos.y - cy });
		}

		const angle = -Math.PI / 2 + branchOrder * 0.65;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	}

	/** For child overlay node: away from the native anchor that "owns" it */
	private computeChildDirection(
		leaf: any,
		nodePath: string,
		nodePos: Point,
		nativeByPath: Map<string, NativeNode>,
		coords: Map<string, Point>,
		parentMap: Map<string, string | null>,
		fallback: Point
	): Point {
		const anchorPath = this.nativeAnchorOf(leaf, nodePath);
		const anchorPos = nativeByPath.get(anchorPath)?.pos;
		if (anchorPos) {
			const v = { x: nodePos.x - anchorPos.x, y: nodePos.y - anchorPos.y };
			const len = Math.hypot(v.x, v.y);
			if (len > 0.5) return { x: v.x / len, y: v.y / len };
		}

		const parentPath = parentMap.get(nodePath);
		if (parentPath) {
			const parentPos = coords.get(parentPath);
			if (parentPos) {
				const v = { x: nodePos.x - parentPos.x, y: nodePos.y - parentPos.y };
				const len = Math.hypot(v.x, v.y);
				if (len > 0.5) return { x: v.x / len, y: v.y / len };
			}
		}

		return this.normalize(fallback);
	}

	// ─── HELPERS ──────────────────────────────────────────────────────────────

	private centeredOffsets(count: number): number[] {
		if (count <= 0) return [];
		if (count === 1) return [0];
		const out: number[] = [0];
		let s = 1;
		while (out.length < count) {
			out.push(-s);
			if (out.length < count) out.push(s);
			s++;
		}
		return out;
	}

	private buildRows(count: number, rowCount: number): number[][] {
		const rows: number[][] = Array.from({ length: rowCount }, () => []);
		for (let i = 0; i < count; i++) rows[i % rowCount].push(i);
		return rows.filter((r) => r.length > 0);
	}

	private collectNeighborhood(startPath: string, maxDepth: number) {
		const nodes = new Set<string>();
		const links = new Set<string>();
		const visited = new Set<string>();
		const queue: Array<{ path: string; d: number }> = [{ path: startPath, d: 0 }];

		while (queue.length) {
			const { path, d } = queue.shift()!;
			if (visited.has(path)) continue;
			visited.add(path);
			nodes.add(path);
			if (d >= maxDepth) continue;
			for (const nb of this.getNeighbors(path)) {
				nodes.add(nb);
				links.add(this.edgeKey(path, nb));
				if (!visited.has(nb)) queue.push({ path: nb, d: d + 1 });
			}
		}

		return {
			nodes: Array.from(nodes),
			links: Array.from(links).map((e) => {
				const [s, t] = e.split("→");
				return { source: s, target: t };
			}),
		};
	}

	private getNeighbors(path: string): string[] {
		const out = new Set<string>();
		const resolved = this.app.metadataCache.resolvedLinks ?? {};
		if (resolved[path]) for (const d of Object.keys(resolved[path])) out.add(d);
		for (const [src, dests] of Object.entries(resolved)) {
			if (dests && path in (dests as Record<string, number>)) out.add(src);
		}
		return Array.from(out);
	}

	private estimateRadius(path: string): number {
		const l = this.basename(path).replace(/\.md$/i, "").length;
		return 8 + Math.min(7, Math.ceil(l / 6) * 0.6);
	}

	private estimateLabelWidth(path: string): number {
		return Math.max(24, this.basename(path).replace(/\.md$/i, "").length * 6.5);
	}

	private normalize(v: Point): Point {
		const len = Math.hypot(v.x, v.y) || 1;
		return { x: v.x / len, y: v.y / len };
	}

	private distance(a: Point, b: Point): number {
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	private edgeKey(a: string, b: string): string {
		return [a, b].sort().join("→");
	}

	private safeRefresh(view: any) {
		try { if (typeof view?.renderer?.queueRender === "function") { view.renderer.queueRender(); return; } } catch {}
		try { if (typeof view?.update === "function") { view.update(); return; } } catch {}
		try { if (typeof view?.engine?.updateSearch === "function") { view.engine.updateSearch(); } } catch {}
	}

	private clearOverlay(leaf: any) {
		const overlay = this.overlayByLeaf.get(leaf);
		if (overlay) {
			try {
				while (overlay.children.length) { const c = overlay.children[0]; overlay.removeChild(c); c.destroy?.(); }
				overlay.parent?.removeChild?.(overlay);
				overlay.destroy?.({ children: true });
			} catch {}
		}
		this.overlayByLeaf.delete(leaf);
		this.offsetsByLeaf.delete(leaf);
	}

	private findPixiHost(renderer: any): any | null {
		for (const key of ["stage", "container", "viewport", "app"]) {
			const v = key === "app" ? renderer?.app?.stage : renderer?.[key];
			if (this.isPixiContainer(v)) return v;
		}
		for (const key of Object.keys(renderer ?? {})) {
			try { const v = renderer[key]; if (this.isPixiContainer(v)) return v; } catch {}
		}
		return null;
	}

	private isPixiContainer(v: any): boolean {
		return !!v && typeof v.addChild === "function" && Array.isArray(v.children);
	}

	private collectRenderedNodes(renderer: any): any[] {
		const found: any[] = [];
		const seen = new WeakSet<object>();
		const walk = (v: any, d: number) => {
			if (d > 4 || !v || typeof v !== "object" || seen.has(v)) return;
			seen.add(v);
			if (Array.isArray(v)) { for (const i of v) walk(i, d + 1); return; }
			if (this.extractNodeId(v) && this.extractRenderedPosition(v)) found.push(v);
			for (const k of Object.keys(v)) { try { walk(v[k], d + 1); } catch {} }
		};
		walk(renderer, 0);
		const dedup = new Map<string, any>();
		for (const item of found) {
			const id = this.extractNodeId(item);
			if (id && !dedup.has(id)) dedup.set(id, item);
		}
		return Array.from(dedup.values());
	}

	private extractRenderedPosition(obj: any): Point | null {
		const variants: [any, any][] = [
			[obj?.x, obj?.y],
			[obj?.position?.x, obj?.position?.y],
			[obj?.node?.x, obj?.node?.y],
			[obj?.node?.position?.x, obj?.node?.position?.y],
			[obj?.graphics?.x, obj?.graphics?.y],
			[obj?.circle?.x, obj?.circle?.y],
		];
		for (const [x, y] of variants) {
			if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
		}
		return null;
	}

	private extractNodeId(v: any): string | null {
		if (!v) return null;
		if (typeof v === "string") return v;
		return v.id ?? v.path ?? v.file?.path ?? v.node?.id ?? v.node?.path ?? null;
	}

	private extractPathFromArgs(args: any[]): string | null {
		for (const arg of args) {
			if (typeof arg === "string" && arg.endsWith(".md")) return arg;
			if (arg && typeof arg === "object") {
				const id = this.extractNodeId(arg);
				if (id?.endsWith?.(".md")) return id;
			}
		}
		return null;
	}

	private findMouseEvent(args: any[]): MouseEvent | null {
		for (const arg of args) {
			if (typeof PointerEvent !== "undefined" && arg instanceof PointerEvent) return arg;
			if (typeof MouseEvent !== "undefined" && arg instanceof MouseEvent) return arg;
		}
		return null;
	}

	private basename(path: string): string {
		const parts = path.split(/[\\/]/);
		return parts[parts.length - 1] || path;
	}
}