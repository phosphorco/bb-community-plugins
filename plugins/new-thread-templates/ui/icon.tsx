import { experimental_Icon as NativeIcon } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";

function LineIcon({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Layered starting points; distinct from the workflow runner and task checkboxes. */
export function TemplatesIcon({ className }: { className?: string }) {
  return (
    <LineIcon className={className}>
      <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />
    </LineIcon>
  );
}

/** All names are supported by the installed public host icon catalog. */
export function TemplatePurposeIcon({ templateId }: { templateId: string }) {
  const name =
    templateId === "feedback-session"
      ? "MessageSquare"
      : /(?:review-pr|pr-review)/.test(templateId)
        ? "GitPullRequest"
        : templateId === "fix-bug"
          ? "Bug"
          : templateId === "explore-idea"
            ? "Explore"
            : templateId === "start-project"
              ? "FolderPlus"
              : "Edit";
  return (
    <NativeIcon name={name} className="ntt-purpose-icon" aria-hidden="true" />
  );
}
