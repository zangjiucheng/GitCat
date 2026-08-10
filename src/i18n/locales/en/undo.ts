// Tama's post-undo celebration line (emitted by the `undo.performed` event in
// legacy/main.ts's TamaMascot). Keys become `undo.<key>`.
export default {
  performed: "Rewound to {hash} — nothing lost, I sealed {ref} first. ♪",
};
