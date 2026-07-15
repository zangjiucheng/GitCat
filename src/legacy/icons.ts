// Shared inline-SVG icon strings — for the few icons built dynamically in
// TypeScript (armDanger's own `note` string, which ends up set via
// `el.innerHTML=` in legacy/main.ts, and reflog.svelte.ts's per-entry-kind
// icon map) rather than rendered as literal Svelte template markup.
//
// Every OTHER icon in this app lives directly in a .svelte template (or
// index.html's own static markup) as a real `<svg>`/`@lucide/svelte`
// component — these three are pulled out into constants purely because
// they're assembled from TS string logic, where a Svelte component can't be
// dropped in directly. Path data is copied verbatim from `@lucide/svelte`
// (RotateCcw/TriangleAlert/Cherry) so every icon in the app — component-
// rendered or string-rendered — comes from the same consistent icon set,
// rather than a hand-drawn one-off that would drift from it over time.
const ICON_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ico" aria-hidden="true"';

export const ICON_BACKUP =
  `<svg ${ICON_ATTRS}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
export const ICON_WARNING =
  `<svg ${ICON_ATTRS}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
export const ICON_CHERRY =
  `<svg ${ICON_ATTRS}><path d="M2 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"/><path d="M12 17a5 5 0 0 0 10 0c0-2.76-2.5-5-5-3-2.5-2-5 .24-5 3Z"/><path d="M7 14c3.22-2.91 4.29-8.75 5-12 1.66 2.38 4.94 9 5 12"/><path d="M22 9c-4.29 0-7.14-2.33-10-7 5.71 0 10 4.67 10 7Z"/></svg>`;
