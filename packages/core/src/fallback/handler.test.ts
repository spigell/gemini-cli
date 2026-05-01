/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type Mock,
  type MockInstance,
  afterEach,
} from 'vitest';
import { handleFallback } from './handler.js';
import type { Config } from '../config/config.js';
import type { ModelAvailabilityService } from '../availability/modelAvailabilityService.js';
import { createAvailabilityServiceMock } from '../availability/testUtils.js';
import { AuthType } from '../core/contentGenerator.js';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
} from '../config/models.js';
import type { FallbackModelHandler } from './types.js';
import { openBrowserSecurely } from '../utils/secure-browser-launcher.js';
import { debugLogger } from '../utils/debugLogger.js';
import * as policyHelpers from '../availability/policyHelpers.js';
import { createDefaultPolicy } from '../availability/policyCatalog.js';
import {
  RetryableQuotaError,
  TerminalQuotaError,
} from '../utils/googleQuotaErrors.js';

// Mock the telemetry logger and event class
vi.mock('../telemetry/index.js', () => ({
  logFlashFallback: vi.fn(),
  FlashFallbackEvent: class {},
}));
vi.mock('../utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: vi.fn(),
  shouldLaunchBrowser: vi.fn().mockReturnValue(true),
}));

// Mock debugLogger to prevent console pollution and allow spying
vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  },
}));

const MOCK_PRO_MODEL = DEFAULT_GEMINI_MODEL;
const FALLBACK_MODEL = DEFAULT_GEMINI_FLASH_MODEL;
const AUTH_OAUTH = AuthType.LOGIN_WITH_GOOGLE;

const createProFlashChain = () => {
  const proPolicy = createDefaultPolicy(MOCK_PRO_MODEL);
  const flashPolicy = createDefaultPolicy(DEFAULT_GEMINI_FLASH_MODEL, {
    isLastResort: true,
  });
  return [proPolicy, flashPolicy];
};

const createMockConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    fallbackHandler: undefined,
    getFallbackModelHandler: vi.fn(),
    setActiveModel: vi.fn(),
    setModel: vi.fn(),
    activateFallbackMode: vi.fn(),
    getModelAvailabilityService: vi.fn(() =>
      createAvailabilityServiceMock({
        selectedModel: FALLBACK_MODEL,
        skipped: [],
      }),
    ),
    getActiveModel: vi.fn(() => MOCK_PRO_MODEL),
    getModel: vi.fn(() => MOCK_PRO_MODEL),
    getUserTier: vi.fn(() => undefined),
    isInteractive: vi.fn(() => false),
    ...overrides,
  }) as unknown as Config;

describe('handleFallback', () => {
  let mockConfig: Config;
  let mockHandler: Mock<FallbackModelHandler>;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHandler = vi.fn();
    // Default setup: OAuth user, Pro model failed, handler injected
    mockConfig = createMockConfig({
      fallbackModelHandler: mockHandler,
    });
    // Explicitly set the property to ensure it's present for legacy checks
    mockConfig.fallbackModelHandler = mockHandler;

    // We mocked debugLogger, so we don't need to spy on console.error for handler failures
    // But tests might check console.error usage in legacy code if any?
    // The handler uses console.error in legacyHandleFallback.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('policy-driven flow', () => {
    let policyConfig: Config;
    let availability: ModelAvailabilityService;
    let policyHandler: Mock<FallbackModelHandler>;

    beforeEach(() => {
      vi.clearAllMocks();
      availability = createAvailabilityServiceMock({
        selectedModel: DEFAULT_GEMINI_FLASH_MODEL,
        skipped: [],
      });
      policyHandler = vi.fn().mockResolvedValue('retry_once');
      policyConfig = createMockConfig();

      // Ensure we test the availability path
      vi.mocked(policyConfig.getModelAvailabilityService).mockReturnValue(
        availability,
      );
      vi.mocked(policyConfig.getFallbackModelHandler).mockReturnValue(
        policyHandler,
      );
    });

    it('uses availability selection with correct candidates when enabled', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());

      try {
        await handleFallback(policyConfig, DEFAULT_GEMINI_MODEL, AUTH_OAUTH);

        expect(availability.selectFirstAvailable).toHaveBeenCalledWith([
          DEFAULT_GEMINI_FLASH_MODEL,
        ]);
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('returns null when availability is exhausted in non-interactive mode', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      availability.selectFirstAvailable = vi
        .fn()
        .mockReturnValue({ selectedModel: null, skipped: [] });

      try {
        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBeNull();
        expect(policyHandler).not.toHaveBeenCalled();
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('executes silent policy action without invoking UI handler', async () => {
      const proPolicy = createDefaultPolicy(MOCK_PRO_MODEL);
      const flashPolicy = createDefaultPolicy(DEFAULT_GEMINI_FLASH_MODEL);
      flashPolicy.actions = {
        ...flashPolicy.actions,
        terminal: 'silent',
        unknown: 'silent',
      };
      flashPolicy.isLastResort = true;

      const silentChain = [proPolicy, flashPolicy];
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(silentChain);

      try {
        availability.selectFirstAvailable = vi.fn().mockReturnValue({
          selectedModel: DEFAULT_GEMINI_FLASH_MODEL,
          skipped: [],
        });

        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBe(true);
        expect(policyConfig.getFallbackModelHandler).not.toHaveBeenCalled();
        expect(policyConfig.setActiveModel).toHaveBeenCalledWith(
          DEFAULT_GEMINI_FLASH_MODEL,
        );
        expect(policyConfig.activateFallbackMode).not.toHaveBeenCalled();
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('wraps around to earlier chain candidates when the failed model is last in the chain', async () => {
      const previewFlash = createDefaultPolicy(PREVIEW_GEMINI_FLASH_MODEL);
      const previewPro = createDefaultPolicy(PREVIEW_GEMINI_MODEL);
      const failedFlash = createDefaultPolicy(DEFAULT_GEMINI_FLASH_MODEL, {
        isLastResort: true,
      });
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue([previewFlash, previewPro, failedFlash]);
      availability.selectFirstAvailable = vi.fn().mockReturnValue({
        selectedModel: PREVIEW_GEMINI_FLASH_MODEL,
        skipped: [],
      });
      policyHandler.mockResolvedValue('retry_once');

      try {
        await handleFallback(
          policyConfig,
          DEFAULT_GEMINI_FLASH_MODEL,
          AUTH_OAUTH,
        );

        expect(availability.selectFirstAvailable).toHaveBeenCalledWith([
          PREVIEW_GEMINI_FLASH_MODEL,
          PREVIEW_GEMINI_MODEL,
          DEFAULT_GEMINI_FLASH_MODEL,
        ]);
        expect(policyHandler).toHaveBeenCalledWith(
          DEFAULT_GEMINI_FLASH_MODEL,
          PREVIEW_GEMINI_FLASH_MODEL,
          undefined,
        );
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('successfully follows expected availability response for Preview Chain', async () => {
      availability.selectFirstAvailable = vi.fn().mockReturnValue({
        selectedModel: PREVIEW_GEMINI_FLASH_MODEL,
        skipped: [],
      });
      policyHandler.mockResolvedValue('retry_once');
      vi.mocked(policyConfig.getActiveModel).mockReturnValue(
        PREVIEW_GEMINI_MODEL,
      );
      vi.mocked(policyConfig.getModel).mockReturnValue(
        PREVIEW_GEMINI_MODEL_AUTO,
      );

      const result = await handleFallback(
        policyConfig,
        PREVIEW_GEMINI_MODEL,
        AUTH_OAUTH,
      );

      expect(result).toBe(true);
      expect(availability.selectFirstAvailable).toHaveBeenCalledWith([
        PREVIEW_GEMINI_FLASH_MODEL,
      ]);
    });

    it('should launch upgrade flow and avoid fallback mode when handler returns "upgrade"', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      policyHandler.mockResolvedValue('upgrade');
      vi.mocked(openBrowserSecurely).mockResolvedValue(undefined);

      try {
        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBe(false);
        expect(openBrowserSecurely).toHaveBeenCalledWith(
          'https://goo.gle/set-up-gemini-code-assist',
        );
        expect(policyConfig.activateFallbackMode).not.toHaveBeenCalled();
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('should catch errors from the handler, log an error, and return null', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      const handlerError = new Error('UI interaction failed');
      policyHandler.mockRejectedValue(handlerError);

      try {
        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBeNull();
        expect(debugLogger.error).toHaveBeenCalledWith(
          'Fallback handler failed:',
          handlerError,
        );
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('should pass TerminalQuotaError (429) correctly to the handler', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      const mockGoogleApiError = {
        code: 429,
        message: 'mock error',
        details: [],
      };
      const terminalError = new TerminalQuotaError(
        'Quota error',
        mockGoogleApiError,
        5,
      );
      policyHandler.mockResolvedValue('retry_always');

      try {
        await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
          terminalError,
        );

        expect(policyHandler).toHaveBeenCalledWith(
          MOCK_PRO_MODEL,
          DEFAULT_GEMINI_FLASH_MODEL,
          terminalError,
        );
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('should pass RetryableQuotaError correctly to the handler', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      const mockGoogleApiError = {
        code: 503,
        message: 'mock error',
        details: [],
      };
      const retryableError = new RetryableQuotaError(
        'Service unavailable',
        mockGoogleApiError,
        1000,
      );
      policyHandler.mockResolvedValue('retry_once');

      try {
        await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
          retryableError,
        );

        expect(policyHandler).toHaveBeenCalledWith(
          MOCK_PRO_MODEL,
          DEFAULT_GEMINI_FLASH_MODEL,
          retryableError,
        );
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('resets availability and reselects on interactive exhaustion instead of forcing an unavailable last-resort model', async () => {
      const previewPro = createDefaultPolicy('gemini-3.1-pro-preview');
      previewPro.actions = {
        ...previewPro.actions,
        terminal: 'silent',
      };
      const fallbackPro = createDefaultPolicy('gemini-2.5-pro', {
        isLastResort: true,
      });
      fallbackPro.actions = {
        ...fallbackPro.actions,
        terminal: 'silent',
      };
      const proChain = [previewPro, fallbackPro];
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(proChain);

      vi.mocked(policyConfig.isInteractive).mockReturnValue(true);
      availability.selectFirstAvailable = vi
        .fn()
        .mockReturnValueOnce({
          selectedModel: null,
          skipped: [{ model: 'gemini-2.5-pro', reason: 'quota' }],
        })
        .mockReturnValueOnce({
          selectedModel: 'gemini-2.5-pro',
          skipped: [],
        });

      try {
        const result = await handleFallback(
          policyConfig,
          'gemini-3.1-pro-preview',
          AUTH_OAUTH,
          new TerminalQuotaError('Quota exhausted', {
            code: 429,
            message: 'quota',
            details: [],
          }),
        );

        expect(result).toBe(true);
        expect(availability.reset).toHaveBeenCalledTimes(1);
        expect(availability.selectFirstAvailable).toHaveBeenNthCalledWith(1, [
          'gemini-2.5-pro',
        ]);
        expect(availability.selectFirstAvailable).toHaveBeenNthCalledWith(2, [
          'gemini-2.5-pro',
        ]);
        expect(policyConfig.setActiveModel).toHaveBeenCalledWith(
          'gemini-2.5-pro',
        );
        expect(policyHandler).not.toHaveBeenCalled();
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('calls activateFallbackMode when handler returns "retry_always"', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      policyHandler.mockResolvedValue('retry_always');

      try {
        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBe(true);
        expect(policyConfig.activateFallbackMode).toHaveBeenCalledWith(
          FALLBACK_MODEL,
        );
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('does NOT call activateFallbackMode when handler returns "stop"', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      policyHandler.mockResolvedValue('stop');

      try {
        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBe(false);
        expect(policyConfig.activateFallbackMode).not.toHaveBeenCalled();
      } finally {
        chainSpy.mockRestore();
      }
    });

    it('does NOT call activateFallbackMode when handler returns "retry_once"', async () => {
      const chainSpy = vi
        .spyOn(policyHelpers, 'resolvePolicyChain')
        .mockReturnValue(createProFlashChain());
      policyHandler.mockResolvedValue('retry_once');

      try {
        const result = await handleFallback(
          policyConfig,
          MOCK_PRO_MODEL,
          AUTH_OAUTH,
        );

        expect(result).toBe(true);
        expect(policyConfig.activateFallbackMode).not.toHaveBeenCalled();
      } finally {
        chainSpy.mockRestore();
      }
    });
  });
});
