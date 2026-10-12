import { PROVIDER_CLOUD_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Layer } from "effect";

import { isServerBetaFeatureEnabled } from "../betaFeatureGate.ts";
import { CloudSubmissionRepositoryLive } from "../persistence/Layers/CloudSubmissionRepository.ts";
import { makeCloudAgentsGatewayLayer } from "./CloudAgentsGateway.ts";
import { CloudCliRunnerLive } from "./CloudCliRunner.ts";

export const makeCloudAgentsServerLayer = () =>
  isServerBetaFeatureEnabled(PROVIDER_CLOUD_BETA_FEATURE)
    ? makeCloudAgentsGatewayLayer().pipe(
        Layer.provide(CloudSubmissionRepositoryLive),
        Layer.provide(CloudCliRunnerLive),
      )
    : Layer.empty;
