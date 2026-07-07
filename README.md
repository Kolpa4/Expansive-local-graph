# Expansive local graph
Plugin for Obsidian which allow you to expand local graph branches beyond the native depth limit.

Expansive Local Graph is an Obsidian plugin that extends the Local Graph with manual branch expansion beyond the native depth limit. It lets you expand specific nodes on demand, render additional linked notes as overlay nodes, and keep expanded branches visually attached while the graph is redrawn.

## What it does
<img width="474" height="715" alt="image" src="https://github.com/user-attachments/assets/789ed835-7c01-426e-ade3-7a1fd4b5b405" />

Adds Expand here, Reduce here, and branch reset actions to the Local Graph node context menu.

Draws extra nodes and edges as an overlay instead of modifying Obsidian's native graph dataset.

Supports nested expansion, so an overlay node can become the root of another expanded branch.

Preserves relative positions of expanded overlay nodes during graph rerenders and node dragging.

Highlights expanded roots with colored rings and uses branch colors to distinguish overlapping expansions.

## How it works
The plugin reads note relationships from Obsidian's resolved links graph and builds additional neighborhoods around selected notes. It then renders those extra nodes in a PIXI overlay layer attached to the Local Graph renderer, which avoids needing direct mutation of the internal native graph structures.

## Installation
From Community Plugins
Open Settings → Community plugins in Obsidian.

Disable Restricted mode if it is enabled.

Search for Expansive Graph.

Install the plugin and enable it.

## Manual install
Download main.js, manifest.json, and styles.css if the release includes it.

Create a folder named expansive-graph inside your vault at .obsidian/plugins/.

Copy the release files into that folder.

Reload Obsidian.

Enable Expansive Graph in Settings → Community plugins.

Obsidian community plugin releases are distributed as main.js, manifest.json, and optionally styles.css attached to a GitHub Release.

## Usage
Open a note and switch to its Local Graph.

Right-click a visible node.

Choose Expand here (+1) to add one more overlay depth for that branch.

Repeat the action to expand deeper.

Use Reduce here (-1) or Reset this branch to collapse the expansion.

Use Reset ALL expansions to clear every overlay branch in the current graph view.

Expanded branches are local to the current graph leaf and are redrawn as the view rerenders.

## Notes
The plugin is designed for the Local Graph, not the global graph.

Overlay nodes are visual additions layered above the native graph.

Branch placement is based on note links and renderer coordinates, so exact layout may vary as the native graph changes.

If Obsidian changes internal Local Graph rendering APIs, the plugin may need updates.

## Development
This plugin is built as an Obsidian community plugin and uses the standard plugin manifest fields such as id, name, version, author, and minAppVersion.
