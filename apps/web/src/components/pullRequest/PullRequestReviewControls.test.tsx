import { ProjectId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PullRequestCommentComposer } from "./PullRequestCommentComposer";

it("offers formal review from the shared comment composer", () => {
  const html = renderToStaticMarkup(
    <PullRequestCommentComposer
      target={{ projectId: ProjectId.makeUnsafe("project"), repository: "acme/app", number: 1 }}
      mutation={{ isPending: false, mutateAsync: async () => undefined }}
      onReview={async () => undefined}
    />,
  );
  expect(html).toContain("Review");
});
