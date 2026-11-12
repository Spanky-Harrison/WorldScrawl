// The one plugin version: what the extension checks before it uses anything it loads from the plugin (every module in
// plugin/shared/, and plugin/ui/card.mjs and cardedit.mjs). Bump it together with PLUGIN_API in extension/shared.mjs
// whenever any of them changes in a way the extension relies on (a new export, a new descriptor field). A plugin
// without this file, or with another number, gets the "update the plugin" line instead of cards.
export const PLUGIN_VERSION = 2;
