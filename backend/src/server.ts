import cors from 'cors';
import express from 'express';

import { config, localOsmFiles } from './config';
import { generateRoutesRouter } from './routes/generate-routes';
import { streetFitRouter } from './routes/street-fit';
import { diagnoseValhalla } from './routing/valhalla';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  const valhalla = await diagnoseValhalla();
  const available = valhalla.ready;
  res.status(available ? 200 : 503).json({
    ok: available,
    service: 'runshape-backend',
    developmentOnly: true,
    valhallaUrl: config.valhallaUrl,
    valhalla: {
      available,
      reachable: valhalla.reachable,
      tileDataAvailable: valhalla.tileDataAvailable,
      pedestrianRoutingAvailable: valhalla.pedestrianRoutingAvailable,
      cairoCovered: valhalla.cairoCovered,
      version: valhalla.version,
      tilesetLastModified: valhalla.tilesetLastModified,
      cairoSnapDistanceMeters: valhalla.cairoSnapDistanceMeters,
      cairoWayId: valhalla.cairoWayId,
      message: valhalla.message,
    },
    localFiles: localOsmFiles(),
  });
});

app.use(generateRoutesRouter);
app.use(streetFitRouter);

app.listen(config.port, () => {
  console.log(`RunShape backend (DEV) http://127.0.0.1:${config.port}`);
  console.log(`Valhalla ${config.valhallaUrl}`);
});
