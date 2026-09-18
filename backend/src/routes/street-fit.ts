/**
 * DEVELOPMENT ONLY diagnostic endpoints. Does not generate production routes.
 */
import { Router } from 'express';

import { runStreetFitDiagnostic } from '../diagnostics/street-fit-survey';
import { runGraphShapeExperiment } from '../generation/graph-shape-experiment';
import { runStreetFitSearchExperiment } from '../generation/street-fit-pipeline';
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
