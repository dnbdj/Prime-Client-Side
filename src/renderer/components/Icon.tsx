type IconProps = { size?: number };

function frame(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function HomeIcon({ size = 19 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M3 10.6 12 3l9 7.6" />
      <path d="M5.5 9.4V21h13V9.4" />
      <path d="M9.8 21v-6.2h4.4V21" />
    </svg>
  );
}

export function VersionsIcon({ size = 19 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.6" />
      <rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.6" />
      <rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.6" />
      <rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.6" />
    </svg>
  );
}

export function SettingsIcon({ size = 19 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M3.5 7h9.5" />
      <path d="M18.5 7h2" />
      <path d="M3.5 17h2" />
      <path d="M11 17h9.5" />
      <circle cx="15.6" cy="7" r="2.4" />
      <circle cx="8.4" cy="17" r="2.4" />
    </svg>
  );
}

export function MoreIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <circle cx="5.2" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <circle cx="11" cy="11" r="6.8" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}
