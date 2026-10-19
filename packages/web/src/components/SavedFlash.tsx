/**
 * "saved ✓" for a field that saves itself (on blur, on toggle): shows for a
 * beat and fades out on its own, or stays as the error when the save was
 * refused. Shared by the repo settings and the review summary.
 */
import { useEffect, useRef, useState } from "react";
import { errorText } from "../api/errors";
import { IconCheck } from "./icons";

export function useFlash(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    shown,
    () => {
      setShown(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), 1800);
    },
  ];
}

export function SavedFlash({ shown, error }: { shown: boolean; error: unknown }) {
  if (error) {
    return (
      <span className="text-2xs" style={{ color: "var(--risk)" }} role="alert" data-testid="save-error">
        {errorText(error)}
      </span>
    );
  }
  if (!shown) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs"
      style={{ color: "var(--ok)" }}
      data-testid="saved-flash"
    >
      <IconCheck width={10} height={10} />
      saved
    </span>
  );
}
