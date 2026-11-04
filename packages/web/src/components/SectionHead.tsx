import { UiText } from "./UiText";
/** An overview section's heading, with its actions on the right. */
export function SectionHead({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      <h2 className="text-base font-semibold" style={{ color: "var(--fg)" }}>
        {typeof title === "string" ? <UiText>{title}</UiText> : title}
      </h2>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
