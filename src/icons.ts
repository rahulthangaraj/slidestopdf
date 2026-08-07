// Lucide icons (ISC), inlined verbatim from the lucide-static package.
// They must be inlined rather than fetched: the plugin declares
// networkAccess "none", so no remote asset can load at runtime.
//
// Generated — do not hand-edit. Inner path data only; the wrapper <svg>
// is built by icon() so size and colour come from CSS.

const PATHS: { [name: string]: string } = {
  'mouse-pointer-click': '<path d="M14 4.1 12 6" /> <path d="m5.1 8-2.9-.8" /> <path d="m6 12-1.9 2" /> <path d="M7.2 2.2 8 5.1" /> <path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" />',
  'refresh-ccw': '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /> <path d="M3 3v5h5" /> <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /> <path d="M16 16h5v5" />',
  'x': '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
  'grip-vertical': '<circle cx="9" cy="12" r="1" /> <circle cx="9" cy="5" r="1" /> <circle cx="9" cy="19" r="1" /> <circle cx="15" cy="12" r="1" /> <circle cx="15" cy="5" r="1" /> <circle cx="15" cy="19" r="1" />',
  'frame': '<line x1="22" x2="2" y1="6" y2="6" /> <line x1="22" x2="2" y1="18" y2="18" /> <line x1="6" x2="6" y1="2" y2="22" /> <line x1="18" x2="18" y1="2" y2="22" />',
  'check': '<path d="M20 6 9 17l-5-5" />',
  'minus': '<path d="M5 12h14" />',
  'arrow-left': '<path d="m12 19-7-7 7-7" /> <path d="M19 12H5" />',
};

export type IconName = keyof typeof PATHS;

export function icon(name: string, size: number): string {
  return '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' + PATHS[name] + '</svg>';
}
