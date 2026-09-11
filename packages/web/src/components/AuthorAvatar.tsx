import { useState } from "react";

/**
 * The PR author's GitHub avatar, falling back to an initial-letter disc when
 * the image can't load (offline PWA, GHE without avatars, blocked CDN). The
 * fallback keeps the exact footprint so rows don't shift as images resolve.
 */
export function AuthorAvatar({
  author,
  url,
  size = 14,
}: {
  author: string;
  url?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span
        aria-hidden
        className="inline-flex flex-none select-none items-center justify-center rounded-full font-medium uppercase"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.55),
          background: "var(--accent-soft)",
          color: "var(--accent)",
        }}
      >
        {author.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="flex-none rounded-full"
      onError={() => setFailed(true)}
    />
  );
}
