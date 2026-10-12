import { createFileRoute, redirect } from "@tanstack/react-router";

import { CLOUD_ON } from "~/betaFeatures";
import CloudView from "~/components/cloud/CloudView";

export const Route = createFileRoute("/_chat/cloud")({
  beforeLoad: () => {
    if (!CLOUD_ON) throw redirect({ to: "/", replace: true });
  },
  component: CloudView,
});
