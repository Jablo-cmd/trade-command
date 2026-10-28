import { useId } from 'react';

/** The Trade Command mark: an emerald tile, an ivory "T", and a gold price line breaking out. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 512 512" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14c38c" />
          <stop offset="1" stopColor="#054a35" />
        </linearGradient>
        <linearGradient id={`${id}g`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#d9b66a" />
          <stop offset="1" stopColor="#f3dc9c" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}t)`} />
      <rect x="6" y="6" width="500" height="500" rx="110" fill="none" stroke="#f3dc9c" strokeOpacity=".28" strokeWidth="4" />
      <path d="M150 156h212M256 156v222" fill="none" stroke="#f6f3e8" strokeWidth="46" strokeLinecap="round" />
      <path d="M140 360l92-92 56 40 104-128" fill="none" stroke="#0a5239" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M140 360l92-92 56 40 104-128M352 178h42v42" fill="none" stroke={`url(#${id}g)`} strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
