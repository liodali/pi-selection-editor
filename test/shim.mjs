// Shim: only the host exports the extension uses (avoids loading the full CLI graph).
// PI_NM is injected by test.mjs via globalThis before jiti loads this file.
const NM = globalThis.__PI_NM;
export const CustomEditor = (await import(`${NM}/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js`)).CustomEditor;
export const copyToClipboard = (await import(`${NM}/@earendil-works/pi-coding-agent/dist/utils/clipboard.js`)).copyToClipboard;
