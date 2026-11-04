/** The Ariadne icon (assets/icon.svg): navy tile, a square labyrinth drawn as one ochre thread from the entrance ring to the knot. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#1c2b4a" />
      <path d="M14 20 V50 H50 V14 H26 V38 H38 V26" fill="none" stroke="#e8b43a" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="14" cy="14" r="4.5" fill="none" stroke="#e8b43a" strokeWidth="3.5" />
      <circle cx="38" cy="26" r="5" fill="#e8b43a" />
    </svg>
  );
}
