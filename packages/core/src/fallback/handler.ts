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
  const errorSummary = summarizeError(error);
  debugLogger.warn(
    `[fallback] Handling fallback for failedModel=${failedModel}, chainHint=${chainHint}, authType=${authType ?? 'unknown'}, interactive=${config.isInteractive()}, error=${errorSummary}`,
  );
  const chain = resolvePolicyChain(config, chainHint, true);
  debugLogger.warn(
    `[fallback] Resolved policy chain for hint=${chainHint}: ${chain.map((policy) => policy.model).join(' -> ')}`,
  );
  const { failedPolicy, candidates } = buildFallbackPolicyContext(
    chain,
    failedModel,
    config.isInteractive(),
  );
  debugLogger.warn(
    `[fallback] Failed policy=${failedPolicy?.model ?? 'none'}, candidates=${candidates.map((policy) => policy.model).join(', ') || 'none'}`,
  );

  const failureKind = classifyFailureKind(error);
  const availability = config.getModelAvailabilityService();
  debugLogger.warn(
    `[fallback] Classified failure for model=${failedModel} as kind=${failureKind}`,
  );
  const getAvailabilityContext = () => {
    if (!failedPolicy) return undefined;
    return { service: availability, policy: failedPolicy };
  };

  let fallbackModel: string;
  {
    const candidatePolicies = candidates.length ? candidates : chain;
    const candidateModels = candidatePolicies.map((policy) => policy.model);
    debugLogger.warn(
      `[fallback] Selecting from candidate policies for failedModel=${failedModel}: ${candidateModels.join(', ') || 'none'}`,
    );
    let selection = availability.selectFirstAvailable(candidateModels);
    debugLogger.warn(
      `[fallback] Initial selection result for failedModel=${failedModel}: selected=${selection.selectedModel ?? 'none'}, skipped=${formatSkippedModels(selection.skipped)}`,
    );

    let lastResortPolicy = candidatePolicies.find((policy) => policy.isLastResort);
    let selectedFallbackModel = selection.selectedModel ?? lastResortPolicy?.model;
    let selectedPolicy = candidatePolicies.find(
      (policy) => policy.model === selectedFallbackModel,
    );

    // Interactive mode only: when selection is exhausted, clear availability
    // state and reselect from the full chain to restart the cycle.
    if (
      config.isInteractive() &&
      (!selectedFallbackModel ||
        selectedFallbackModel === failedModel ||
        !selectedPolicy)
    ) {
      const restartCandidates = chain
        .filter((p) => p.model !== failedModel)
        .map((p) => p.model);
      debugLogger.warn(
        `[fallback] Selection exhausted for failedModel=${failedModel}; resetting availability and restarting from chain candidates=${restartCandidates.join(', ') || 'none'}`,
      );
      availability.reset();
      selection = availability.selectFirstAvailable(
        restartCandidates,
      );
      debugLogger.warn(
        `[fallback] Restart selection result for failedModel=${failedModel}: selected=${selection.selectedModel ?? 'none'}, skipped=${formatSkippedModels(selection.skipped)}`,
      );
      lastResortPolicy = chain.find((policy) => policy.isLastResort);
      selectedFallbackModel = selection.selectedModel ?? lastResortPolicy?.model;
      selectedPolicy = chain.find(
        (policy) => policy.model === selectedFallbackModel,
      );
    }

    if (
      !selectedFallbackModel ||
      selectedFallbackModel === failedModel ||
      !selectedPolicy
    ) {
      debugLogger.warn(
        `[fallback] No valid fallback for failedModel=${failedModel}: selected=${selectedFallbackModel ?? 'none'}, failedPolicy=${failedPolicy?.model ?? 'none'}, lastResort=${lastResortPolicy?.model ?? 'none'}`,
      );
      return null;
    }

    fallbackModel = selectedFallbackModel;
    debugLogger.warn(
      `[fallback] Chosen fallback model for failedModel=${failedModel}: fallbackModel=${fallbackModel}, selectedPolicy=${selectedPolicy.model}, lastResort=${selectedPolicy.isLastResort === true}`,
    );

    // failureKind is already declared and calculated above
    const action = resolvePolicyAction(failureKind, selectedPolicy);
    debugLogger.warn(
      `[fallback] Resolved action for failedModel=${failedModel} -> fallbackModel=${fallbackModel}: action=${action}, failureKind=${failureKind}`,
    );

    if (action === 'silent') {
      debugLogger.warn(
        `[fallback] Applying silent fallback for failedModel=${failedModel} -> fallbackModel=${fallbackModel}`,
      );
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
    debugLogger.warn(
      `[fallback] No fallback handler registered for failedModel=${failedModel}; returning null after selecting fallbackModel=${fallbackModel}`,
    );
    return null;
  }

  try {
    const intent = await handler(failedModel, fallbackModel, error);
    debugLogger.warn(
      `[fallback] Handler returned intent for failedModel=${failedModel} -> fallbackModel=${fallbackModel}: intent=${intent ?? 'null'}`,
    );

    // If the user chose to switch/retry, we apply the availability transition
    // to the failed model (e.g. marking it terminal if it had a quota error).
    // We DO NOT apply it if the user chose 'stop' or 'retry_later', allowing
    // them to try again later with the same model state.
    if (
      intent === 'retry_always' ||
      intent === 'retry_once' ||
      intent === 'retry_once_silent'
    ) {
      debugLogger.warn(
        `[fallback] Applying availability transition for failedModel=${failedModel} after intent=${intent}`,
      );
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
  debugLogger.warn(
    `[fallback] Processing intent=${intent ?? 'null'} with fallbackModel=${fallbackModel}`,
  );
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

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatSkippedModels(
  skipped: Array<{ model: string; reason: string }> | undefined,
): string {
  if (!skipped?.length) {
    return 'none';
  }
  return skipped
    .map(({ model, reason }) => `${model}:${reason}`)
    .join(', ');
}
