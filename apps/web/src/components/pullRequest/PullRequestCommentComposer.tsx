// FILE: PullRequestCommentComposer.tsx
// Purpose: Inline "Leave a comment" pill at the bottom of a GitHub item's Comments section. Posts
//          through the comment mutation its host passes in (pull request or issue), as the
//          authenticated GitHub user (hence the GitHub glyph in the leading slot); the mutation
//          owns revalidating the detail and the lists. Enter submits; Shift+Enter breaks a line
//          (comments accept markdown).
// Layer: Pull request presentation
// Exports: PullRequestCommentComposer, GitHubCommentTarget, GitHubCommentMutation

import type { PullRequestDetailInput } from "@synara/contracts";
import { useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { GitHubIcon } from "~/lib/icons";
import { PillComposerField } from "../PillComposerField";

/** The item a comment goes to. Pull requests and issues share one number space per repository. */
export type GitHubCommentTarget = Pick<
  PullRequestDetailInput,
  "projectId" | "repository" | "number"
>;

/** The slice of a React Query comment mutation the composer drives. */
export interface GitHubCommentMutation {
  mutateAsync: (input: GitHubCommentTarget & { body: string }) => Promise<unknown>;
  isPending: boolean;
}

export function PullRequestCommentComposer({
  target,
  mutation,
}: {
  target: GitHubCommentTarget;
  mutation: GitHubCommentMutation;
}) {
  const [body, setBody] = useState("");
  // Synchronous re-entrancy lock: mutation.isPending updates on React's schedule, which is
  // too late to stop a rapid double Enter from posting the comment twice.
  const submittingRef = useRef(false);
  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !mutation.isPending;

  // Promise chain instead of async/try-catch-finally: React Compiler does not
  // yet support try/finally, and it would skip optimizing this whole component.
  const submit = () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    void mutation
      .mutateAsync({
        projectId: target.projectId,
        repository: target.repository,
        number: target.number,
        body: trimmed,
      })
      .then(() => {
        setBody("");
      })
      .catch((error: unknown) => {
        // The draft stays in the field on failure — nothing to re-type.
        toastManager.add({
          type: "error",
          title: "Could not post comment",
          description: error instanceof Error ? error.message : "GitHub CLI comment failed.",
        });
      })
      .finally(() => {
        submittingRef.current = false;
      });
  };

  return (
    <PillComposerField
      value={body}
      onValueChange={setBody}
      onSubmit={submit}
      canSubmit={canSubmit}
      disabled={mutation.isPending}
      placeholder="Leave a comment"
      ariaLabel="Leave a comment"
      submitLabel="Post comment"
      leading={
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-muted-foreground"
          title="Commenting as your GitHub account"
        >
          <GitHubIcon className="size-3" />
        </span>
      }
    />
  );
}
