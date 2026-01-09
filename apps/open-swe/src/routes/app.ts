import { Hono } from "hono";
import { registerRunRoute } from "../server/routes/run.js";
import { registerFeatureGraphRoute } from "../server/routes/feature-graph.js";
import { registerDevServerRoute } from "../server/routes/dev-server.js";

export const app = new Hono();

registerRunRoute(app);
registerFeatureGraphRoute(app);
registerDevServerRoute(app);
