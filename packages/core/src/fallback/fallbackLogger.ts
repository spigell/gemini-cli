/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';

/**
 * A logger for fallback events.
 *
 * This is a singleton class that provides a consistent logging format for
 * fallback events across the application.
 */
class FallbackLogger {
  private static instance: FallbackLogger;

  private constructor() {}

  static getInstance(): FallbackLogger {
    if (!FallbackLogger.instance) {
      FallbackLogger.instance = new FallbackLogger();
    }
    return FallbackLogger.instance;
  }

  startSession(failedModel: string) {
    this.log(`Handling fallback for failedModel=${failedModel}`);
  }

  log(message: string) {
    debugLogger.warn(`[fallback] ${message}`);
  }

  group(title: string, messages: Array<[string, unknown]>) {
    this.log(title);
    for (const [key, value] of messages) {
      debugLogger.warn(`  [fallback] ${key}: ${value}`);
    }
  }
}

export const fallbackLogger = FallbackLogger.getInstance();
