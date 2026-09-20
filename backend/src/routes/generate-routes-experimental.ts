/**
 * DEVELOPMENT ONLY. User-facing experimental route generation.
 * Does not change POST /generate-routes or ROUTE_GENERATION_MODE.
 */
import { Router } from 'express';
import { z } from 'zod';

import { isValidCoordinate } from '@/lib/geo';

import { config } from '../config';
import {
  attachExperimentalDiagnostics,
  buildExperimentalViabilityDiagnostics,
  getLastExperimentalDiagnostics,
  rememberExperimentalDiagnostics,
} from '../generation/experimental-diagnostics';
import { toExperimentalUserResponse } from '../generation/experimental-product';
import { runExperimentalPipeline } from '../generation/graph-constrained-pipeline';
import { checkValhallaStatus, ValhallaRequestError } from '../routing/valhalla';
import type { ApiErrorBody, GenerateRoutesRequest } from '../types';

const generateBodySchema = z.object({
  word: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  targetDistance: z.number(),
});

export const generateRoutesExperimentalRouter = Router();

generateRoutesExperimentalRouter.get('/diagnostics/generate-experimental-last.txt', (_req, res) => {
  const last = getLastExperimentalDiagnostics();
  if (!last.text) {
    res.status(404).type('text/plain').send('No experimental generate request has been recorded yet.\n');
    return;
  }
  res.type('text/plain').send(`${last.text}\n`);
});

generateRoutesExperimentalRouter.get('/diagnostics/generate-experimental-last.json', (_req, res) => {
  const last = getLastExperimentalDiagnostics();
  if (!last.json) {
    res.status(404).json({ error: 'No experimental generate request has been recorded yet.' });
    return;
  }
  res.json(last.json);
});

generateRoutesExperimentalRouter.post('/generate-routes-experimental', async (req, res) => {
  const incoming = req.body as {
    word?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    targetDistance?: unknown;
  };
  console.log('[find-my-route][backend-received]', {
    word: incoming.word,
    targetDistance: incoming.targetDistance,
    latitude: incoming.latitude,
    longitude: incoming.longitude,
    path: '/generate-routes-experimental',
  });
  console.log(
    `[generate-routes-experimental] received word=${String(incoming.word)} latitude=${String(incoming.latitude)} longitude=${String(incoming.longitude)} targetDistance=${String(incoming.targetDistance)}`,
  );
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    console.log('[find-my-route][backend-result]', {
      finalStatus: 'VALIDATION_ERROR',
      routesReturned: 0,
      rejectedBy: 'request_schema',
    });
    res.status(400).json(
      apiError('VALIDATION_ERROR', 'Request must include word, latitude, longitude, and targetDistance.'),
    );
    return;
  }

  const validationError = validateGenerateRequest(parsed.data);
  if (validationError) {
    console.log('[find-my-route][backend-result]', {
      finalStatus: validationError.error.code,
      routesReturned: 0,
      rejectedBy: validationError.error.message,
    });
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
    console.log('[find-my-route][backend-result]', {
      finalStatus: status.error.code,
      routesReturned: 0,
      rejectedBy: 'valhalla_unavailable',
    });
    res.status(503).json(apiError(status.error.code, status.error.message, [status.error]));
    return;
  }

  try {
    const report = await runExperimentalPipeline({
      word,
      start,
      targetDistanceMeters: parsed.data.targetDistance,
    });
    const request = {
      word,
      latitude: start.latitude,
      longitude: start.longitude,
      targetDistance: parsed.data.targetDistance,
    };
    const diagnostics = buildExperimentalViabilityDiagnostics(request, report);
    rememberExperimentalDiagnostics(diagnostics);
    const body = attachExperimentalDiagnostics(
      toExperimentalUserResponse(report, parsed.data.targetDistance),
      diagnostics,
    );
    const snap = diagnostics.search.originSnap;
    console.log('[find-my-route][backend-result]', {
      word,
      targetDistance: parsed.data.targetDistance,
      receivedLatitude: start.latitude,
      receivedLongitude: start.longitude,
      snappedLatitude: snap.snappedLatitude,
      snappedLongitude: snap.snappedLongitude,
      snapDistanceMeters: snap.snapDistanceMeters,
      wayId: snap.wayId ?? null,
      graphCandidates: diagnostics.stages.graphFeasibilityPool,
      graphFeasible: diagnostics.stages.graphFeasible,
      routed: diagnostics.stages.routedBeforeProduct,
      productValid: diagnostics.stages.productAccepted,
      finalStatus: body.status,
      routesReturned: body.routes.length,
      rejectedBy: diagnostics.rejectedBy,
    });
    res.json(body);
  } catch (error) {
    console.log('[find-my-route][backend-result]', {
      finalStatus: error instanceof ValhallaRequestError ? error.code : 'MALFORMED_RESPONSE',
      routesReturned: 0,
      rejectedBy: error instanceof Error ? error.message : 'Unexpected generator failure.',
    });
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
