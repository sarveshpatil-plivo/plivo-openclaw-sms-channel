import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { plivoSmsPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(plivoSmsPlugin);
