/**
 * DEVELOPMENT ONLY diagnostic endpoints. Does not generate production routes.
 */
import { Router } from 'express';

import { runStreetFitDiagnostic } from '../diagnostics/street-fit-survey';
import {
  GRAPH_SHAPE_DEFAULT_DISTANCE,
  GRAPH_SHAPE_DEFAULT_START,
  GRAPH_SHAPE_SECOND_START,
  runGraphShapeExperiment,
  type GraphShapeExperimentInput,
} from '../generation/graph-shape-experiment';
import type { ShapeKind } from '../generation/graph-shape';
import { runExperimentalPipeline } from '../generation/graph-constrained-pipeline';
import { runShapeDiscovery } from '../generation/shape-discovery';
import { runStreetFitSearchExperiment } from '../generation/street-fit-pipeline';
import { getLastLetterCoverageReport } from '../diagnostics/letter-coverage';
import { ValhallaRequestError } from '../routing/valhalla';

export const streetFitRouter = Router();

streetFitRouter.get('/diagnostics/street-fit', async (_req, res) => {
  try {
    const report = await runStreetFitDiagnostic();
    res.type('json').send({
      ...report,
      textReport: report.textReport,
    });
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/street-fit.svg', async (_req, res) => {
  try {
    const report = await runStreetFitDiagnostic();
    res.type('image/svg+xml').send(report.svg);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/street-fit.txt', async (_req, res) => {
  try {
    const report = await runStreetFitDiagnostic();
    res.type('text/plain').send(`${report.textReport}\n\nverdict: ${report.verdict}\n`);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/street-fit-search.txt', async (_req, res) => {
  try {
    const report = await runStreetFitSearchExperiment({
      word: 'ROBZ',
      start: { latitude: 30.0444, longitude: 31.2357 },
      targetDistanceMeters: 4000,
    });
    res.type('text/plain').send(`${report.textReport}\n`);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/street-fit-search.svg', async (_req, res) => {
  try {
    const report = await runStreetFitSearchExperiment({
      word: 'ROBZ',
      start: { latitude: 30.0444, longitude: 31.2357 },
      targetDistanceMeters: 4000,
    });
    res.type('image/svg+xml').send(report.svg);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/street-fit-search', async (_req, res) => {
  try {
    const report = await runStreetFitSearchExperiment({
      word: 'ROBZ',
      start: { latitude: 30.0444, longitude: 31.2357 },
      targetDistanceMeters: 4000,
    });
    res.type('json').send({
      developmentOnly: true,
      evaluated: report.evaluated,
      passed: report.passed,
      graphWayCount: report.graphWayCount,
      ranked: report.ranked.map((item) => ({
        ...item.placement,
        score: item.score,
        maxGapMeters: item.maxGapMeters,
        forwardProgress: item.forwardProgress,
        usableEdgeCount: item.usableEdgeCount,
        connectedPathFeasible: item.connectedPathFeasible,
        letters: item.letters,
      })),
      routed: report.routed,
      textReport: report.textReport,
    });
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/graph-shape-test.txt', async (req, res) => {
  try {
    const report = await runGraphShapeExperiment(parseGraphShapeQuery(req.query as Record<string, unknown>));
    res.type('text/plain').send(`${report.textReport}\n`);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/graph-shape-test.svg', async (req, res) => {
  try {
    const report = await runGraphShapeExperiment(parseGraphShapeQuery(req.query as Record<string, unknown>));
    res.type('image/svg+xml').send(report.svg);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/graph-shape-test', async (req, res) => {
  try {
    const report = await runGraphShapeExperiment(parseGraphShapeQuery(req.query as Record<string, unknown>));
    res.type('json').send({
      developmentOnly: true,
      experiment: report.experiment,
      start: report.start,
      targetDistanceMeters: report.targetDistanceMeters,
      rotationDegrees: report.rotationDegrees,
      scale: report.scale,
      elapsedMs: report.elapsedMs,
      valhallaCalls: report.valhallaCalls,
      letters: report.letters.map((item) => ({
        letter: item.letter,
        failure: item.result.failure,
        failureReason: item.result.failureReason,
        metrics: item.result.metrics,
        search: item.result.search,
        graphEdgeCount: item.graphEdgeCount,
        connectorMeters: item.connector.lengthMeters,
        recognizableHint: item.recognizableHint,
      })),
      textReport: report.textReport,
    });
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/shape-discovery.txt', async (_req, res) => {
  try {
    const report = await runShapeDiscovery();
    res.type('text/plain').send(`${report.textReport}\n`);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/shape-discovery.svg', async (_req, res) => {
  try {
    const report = await runShapeDiscovery();
    res.type('image/svg+xml').send(report.svg);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/letter-coverage.txt', (_req, res) => {
  const report = getLastLetterCoverageReport();
  if (!report) {
    res
      .status(404)
      .type('text/plain')
      .send(
        'No letter-coverage report has been recorded yet.\nRun: npm run letter-coverage --prefix backend -- --label=before\n',
      );
    return;
  }
  res.type('text/plain').send(`${report.textReport}\n`);
});

streetFitRouter.get('/diagnostics/letter-coverage.json', (_req, res) => {
  const report = getLastLetterCoverageReport();
  if (!report) {
    res.status(404).json({
      developmentOnly: true,
      error: 'No letter-coverage report has been recorded yet.',
    });
    return;
  }
  res.json(report);
});

streetFitRouter.get('/diagnostics/generate-experimental.txt', async (req, res) => {
  try {
    const report = await runExperimentalPipeline(parseExperimentalQuery(req.query as Record<string, unknown>));
    res.type('text/plain').send(`${report.textReport}\n`);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

streetFitRouter.get('/diagnostics/generate-experimental.svg', async (req, res) => {
  try {
    const report = await runExperimentalPipeline(parseExperimentalQuery(req.query as Record<string, unknown>));
    res.type('image/svg+xml').send(report.svg);
  } catch (error) {
    sendDiagnosticError(res, error);
  }
});

function parseGraphShapeQuery(query: Record<string, unknown>): GraphShapeExperimentInput {
  const letterValue = firstQuery(query.letter) ?? firstQuery(query.letters);
  const letters = letterValue
    ?.split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is ShapeKind => item === 'O' || item === 'Z' || item === 'L');
  const second = firstQuery(query.second) === '1' || firstQuery(query.location) === 'second';
  const latitude = Number(firstQuery(query.latitude) ?? firstQuery(query.lat));
  const longitude = Number(firstQuery(query.longitude) ?? firstQuery(query.lng) ?? firstQuery(query.lon));
  const start = second
    ? GRAPH_SHAPE_SECOND_START
    : {
        latitude: Number.isFinite(latitude) ? latitude : GRAPH_SHAPE_DEFAULT_START.latitude,
        longitude: Number.isFinite(longitude) ? longitude : GRAPH_SHAPE_DEFAULT_START.longitude,
      };
  const distance = Number(firstQuery(query.targetDistance) ?? firstQuery(query.distance));
  const rotation = Number(firstQuery(query.rotation));
  const scale = Number(firstQuery(query.scale));
  return {
    start,
    letters: letters?.length ? letters : undefined,
    targetDistanceMeters: Number.isFinite(distance) ? distance : GRAPH_SHAPE_DEFAULT_DISTANCE,
    rotationDegrees: Number.isFinite(rotation) ? rotation : 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

function parseExperimentalQuery(query: Record<string, unknown>): {
  word: string;
  start: { latitude: number; longitude: number };
  targetDistanceMeters: number;
} {
  const word = (firstQuery(query.word) ?? 'L').toUpperCase().replace(/[^A-Z]/g, '') || 'L';
  const latitude = Number(firstQuery(query.latitude) ?? firstQuery(query.lat) ?? 30.0619);
  const longitude = Number(firstQuery(query.longitude) ?? firstQuery(query.lng) ?? 31.2195);
  const distance = Number(firstQuery(query.targetDistance) ?? firstQuery(query.distance) ?? 2500);
  return {
    word,
    start: {
      latitude: Number.isFinite(latitude) ? latitude : 30.0619,
      longitude: Number.isFinite(longitude) ? longitude : 31.2195,
    },
    targetDistanceMeters: Number.isFinite(distance) ? distance : 2500,
  };
}

function firstQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function sendDiagnosticError(res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) {
  if (error instanceof ValhallaRequestError) {
    res.status(error.status).json({
      developmentOnly: true,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  res.status(500).json({
    developmentOnly: true,
    error: {
      code: 'MALFORMED_RESPONSE',
      message: error instanceof Error ? error.message : 'Street-fit diagnostic failed.',
    },
  });
}
