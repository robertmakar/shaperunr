import { Router } from 'express';
import { z } from 'zod';

import { isValidCoordinate } from '@/lib/geo';

import { config } from '../config';
import { generateRealRoutes } from '../generation/candidate-generator';
import { checkValhallaStatus, ValhallaRequestError } from '../routing/valhalla';
import type { ApiErrorBody, GenerateRoutesRequest } from '../types';

const generateBodySchema = z.object({
  word: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  targetDistance: z.number(),
});

export const generateRoutesRouter = Router();

generateRoutesRouter.post('/generate-routes', async (req, res) => {
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(apiError('VALIDATION_ERROR', 'Request must include word, latitude, longitude, and targetDistance.'));
    return;
  }

  const validationError = validateGenerateRequest(parsed.data);
  if (validationError) {
    res.status(400).json(validationError);
    return;
  }

  const word = normalizeWord(parsed.data.word);
  const start = {
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
  };

  const status = await checkValhallaStatus();
  if (!status.ok) {
    res.status(503).json(apiError(status.error.code, status.error.message, [status.error]));
    return;
  }

  try {
    const result = await generateRealRoutes({
      word,
      start,
      targetDistanceMeters: parsed.data.targetDistance,
    });

    if (result.routes.length === 0) {
      if (result.status === 'no_viable_shape' || result.status === 'weak_candidates') {
        res.json(result);
        return;
      }
      res.status(422).json(
        apiError(
          result.failures[0]?.code ?? 'NO_ROUTE',
          'Real route generation failed. No Valhalla pedestrian candidate stayed within distance tolerance.',
          result.failures,
        ),
      );
      return;
    }

    res.json(result);
  } catch (error) {
    if (error instanceof ValhallaRequestError) {
      res.status(error.status).json(apiError(error.code, error.message));
      return;
    }
    res.status(500).json(
      apiError('MALFORMED_RESPONSE', error instanceof Error ? error.message : 'Unexpected generator failure.'),
    );
  }
});

function validateGenerateRequest(body: GenerateRoutesRequest): ApiErrorBody | null {
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  if (!word) {
    return apiError('VALIDATION_ERROR', 'word is required.');
  }
  const normalized = normalizeWord(word);
  if (!normalized) {
    return apiError('VALIDATION_ERROR', 'word must contain at least one A–Z letter.');
  }
  if (normalized.length > config.maxWordLength) {
    return apiError('VALIDATION_ERROR', `word must be ${config.maxWordLength} letters or fewer.`);
  }
  if (!isValidCoordinate({ latitude: body.latitude, longitude: body.longitude })) {
    return apiError('VALIDATION_ERROR', 'latitude/longitude must be a finite WGS84 coordinate.');
  }
  if (
    !Number.isFinite(body.targetDistance) ||
    body.targetDistance < config.minDistanceMeters ||
    body.targetDistance > config.maxDistanceMeters
  ) {
    return apiError(
      'VALIDATION_ERROR',
      `targetDistance must be between ${config.minDistanceMeters} and ${config.maxDistanceMeters} meters.`,
    );
  }
  return null;
}

function normalizeWord(word: string): string {
  return word.toUpperCase().replace(/[^A-Z]/g, '');
}

function apiError(
  code: ApiErrorBody['error']['code'],
  message: string,
  failures?: ApiErrorBody['error']['failures'],
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      ...(failures && failures.length > 0 ? { failures } : {}),
    },
  };
}
