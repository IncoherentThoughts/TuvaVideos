#!/usr/bin/env bun
import { loadConfig } from "./config";
import { launch } from "./launch";

await launch(loadConfig());
