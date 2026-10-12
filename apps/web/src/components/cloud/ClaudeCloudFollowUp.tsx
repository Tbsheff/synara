import {
  CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH,
  type CloudCapabilities,
  type CloudFollowUpReceipt,
} from "@synara/contracts";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { cloudSendFollowUpMutationOptions } from "~/lib/cloudReactQuery";
import { ExternalLinkIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { PillComposerField } from "../PillComposerField";
import { PR_META_TEXT_CLASS_NAME } from "../pullRequest/pullRequestText";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { dialogFieldLabelClassName } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { CLAUDE_CLOUD_START_NOTE, cloudErrorMessage } from "./cloud.logic";

export function ClaudeCloudFollowUp({ capabilities }: { capabilities: CloudCapabilities }) {
  const mutation = useMutation(cloudSendFollowUpMutationOptions());
  const [sessionReference, setSessionReference] = useState("");
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<CloudFollowUpReceipt | null>(null);
  const submittingRef = useRef(false);
  const trimmedSession = sessionReference.trim();
  const trimmedMessage = message.trim();
  const canSubmit =
    capabilities.canFollowUp &&
    trimmedSession.length > 0 &&
    trimmedMessage.length > 0 &&
    !mutation.isPending;

  const submit = () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setReceipt(null);
    void mutation
      .mutateAsync({
        provider: "claude",
        sessionReference: trimmedSession,
        message: trimmedMessage,
      })
      .then((next) => {
        setReceipt(next);
        setMessage("");
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not send follow-up",
          description: cloudErrorMessage(error),
        });
      })
      .finally(() => {
        submittingRef.current = false;
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info">
        <AlertTitle>Start in a terminal</AlertTitle>
        <AlertDescription>{CLAUDE_CLOUD_START_NOTE}</AlertDescription>
      </Alert>
      {!capabilities.canFollowUp ? (
        <Alert variant="warning" size="sm">
          <AlertDescription>
            {capabilities.unavailableReason ?? "This Claude CLI cannot send follow-ups."}
          </AlertDescription>
        </Alert>
      ) : null}
      <label className="block space-y-1">
        <span className={dialogFieldLabelClassName}>Session ID or URL</span>
        <Input
          size="sm"
          className="font-mono"
          value={sessionReference}
          disabled={!capabilities.canFollowUp}
          onChange={(event) => setSessionReference(event.target.value)}
          placeholder="https://claude.ai/code/…"
          spellCheck={false}
        />
      </label>
      <PillComposerField
        value={message}
        onValueChange={setMessage}
        onSubmit={submit}
        canSubmit={canSubmit}
        disabled={mutation.isPending || !capabilities.canFollowUp}
        placeholder="Send a follow-up"
        ariaLabel="Follow-up message"
        submitLabel="Send follow-up"
        maxLength={CLOUD_FOLLOW_UP_MESSAGE_MAX_LENGTH}
      />
      {receipt ? (
        <div className={cn(PR_META_TEXT_CLASS_NAME, "flex items-center gap-2 text-foreground")}>
          <span>Queued for session {receipt.sessionId}.</span>
          {receipt.url ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                if (receipt.url) void ensureNativeApi().shell.openExternal(receipt.url);
              }}
            >
              <ExternalLinkIcon />
              Open session
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
