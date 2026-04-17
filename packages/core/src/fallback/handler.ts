/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  openBrowserSecurely,
  shouldLaunchBrowser,
} from '../utils/secure-browser-launcher.js';
import { debugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import type { FallbackIntent, FallbackRecommendation } from './types.js';
import { classifyFailureKind } from '../availability/errorClassification.js';
import {
  buildFallbackPolicyContext,
  resolvePolicyChain,
  resolvePolicyAction,
  applyAvailabilityTransition,
} from '../availability/policyHelpers.js';

export const UPGRADE_URL_PAGE = 'https://goo.gle/set-up-gemini-code-assist';

export async function handleFallback(
  config: Config,
  failedModel: string,
  authType?: string,
  error?: unknown,
): Promise<string | boolean | null> {
  // Keep fallback within a model family chain (flash/pro) and allow wrap-around.
  // This avoids collapsing to a single concrete model chain after fallback mode
  // switches active model (e.g. only retrying 2.5 forever).
  const chainHint = failedModel.includes('flash')
    ? 'flash'
    : failedModel.includes('pro')
      ? 'pro'
      : failedModel;
  const chain = resolvePolicyChain(config, chainHint, true);
  const { failedPolicy, candidates } = buildFallbackPolicyContext(
    chain,
    failedModel,
    config.isInteractive(),
  );

  const failureKind = classifyFailureKind(error);
  const availability = config.getModelAvailabilityService();
  const getAvailabilityContext = () => {
    if (!failedPolicy) return undefined;
    return { service: availability, policy: failedPolicy };
  };

  let fallbackModel: string;
  if (!candidates.length) {
    return null;
  } else {
    let selection = availability.selectFirstAvailable(
      candidates.map((policy) => policy.model),
    );

    let lastResortPolicy = candidates.find((policy) => policy.isLastResort);
    let selectedFallbackModel = selection.selectedModel ?? lastResortPolicy?.model;
    let selectedPolicy = candidates.find(
      (policy) => policy.model === selectedFallbackModel,
    );

    // Interactive mode only: when the chain is exhausted, restart from the
    // beginning by clearing availability state and selecting again.
    if (
      config.isInteractive() &&
      (!selectedFallbackModel ||
        selectedFallbackModel === failedModel ||
        !selectedPolicy)
    ) {
      availability.reset();
      selection = availability.selectFirstAvailable(
        candidates.map((policy) => policy.model),
      );
      lastResortPolicy = candidates.find((policy) => policy.isLastResort);
      selectedFallbackModel = selection.selectedModel ?? lastResortPolicy?.model;
      selectedPolicy = candidates.find(
        (policy) => policy.model === selectedFallbackModel,
      );
    }

    if (
      !selectedFallbackModel ||
      selectedFallbackModel === failedModel ||
      !selectedPolicy
    ) {
      return null;
    }

    fallbackModel = selectedFallbackModel;

    // failureKind is already declared and calculated above
    const action = resolvePolicyAction(failureKind, selectedPolicy);

    if (action === 'silent') {
      applyAvailabilityTransition(getAvailabilityContext, failureKind);
      return processIntent(config, 'retry_once_silent', fallbackModel);
    }

    // This will be used in the future when FallbackRecommendation is passed through UI
    const recommendation: FallbackRecommendation = {
      ...selection,
      selectedModel: fallbackModel,
      action,
      failureKind,
      failedPolicy,
      selectedPolicy,
    };
    void recommendation;
  }

  const handler = config.getFallbackModelHandler();
  if (typeof handler !== 'function') {
    return null;
  }

  try {
    const intent = await handler(failedModel, fallbackModel, error);

    // If the user chose to switch/retry, we apply the availability transition
    // to the failed model (e.g. marking it terminal if it had a quota error).
    // We DO NOT apply it if the user chose 'stop' or 'retry_later', allowing
    // them to try again later with the same model state.
    if (
      intent === 'retry_always' ||
      intent === 'retry_once' ||
      intent === 'retry_once_silent'
    ) {
      applyAvailabilityTransition(getAvailabilityContext, failureKind);
    }

    return await processIntent(config, intent, fallbackModel);
  } catch (handlerError) {
    debugLogger.error('Fallback handler failed:', handlerError);
    return null;
  }
}

async function handleUpgrade() {
  if (!shouldLaunchBrowser()) {
    debugLogger.log(
      `Cannot open browser in this environment. Please visit: ${UPGRADE_URL_PAGE}`,
    );
    return;
  }
  try {
    await openBrowserSecurely(UPGRADE_URL_PAGE);
  } catch (error) {
    debugLogger.warn(
      'Failed to open browser automatically:',
      getErrorMessage(error),
    );
  }
}

async function processIntent(
  config: Config,
  intent: FallbackIntent | null,
  fallbackModel: string,
): Promise<boolean> {
  switch (intent) {
    case 'retry_always':
      // TODO(telemetry): Implement generic fallback event logging. Existing
      // logFlashFallback is specific to a single Model.
      config.activateFallbackMode(fallbackModel);
      return true;

    case 'retry_once':
      // For distinct retry (retry_once), we do NOT set the active model permanently.
      // The FallbackStrategy will handle routing to the available model for this turn
      // based on the availability service state (which is updated before this).
      return true;

    case 'retry_once_silent':
      // Silent one-shot fallback should apply immediately without changing the
      // configured model for subsequent turns.
      config.setActiveModel(fallbackModel);
      return true;

    case 'retry_with_credits':
      return true;

    case 'stop':
      // Do not switch model on stop. User wants to stay on current model (and stop).
      return false;

    case 'retry_later':
      return false;

    case 'upgrade':
      await handleUpgrade();
      return false;

    default:
      throw new Error(
        `Unexpected fallback intent received from fallbackModelHandler: "${intent}"`,
      );
  }
}
