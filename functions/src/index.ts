/**
 * Morph Backend — Cloud Functions entry point.
 *
 * Exports:
 * - onSessionUpdate: Firestore trigger — session create with `dumpAudioUrl`
 * - onAgentCall: HTTP POST — starts ElevenLabs conversation for a session
 * - sessionWebhook: HTTP handler — ElevenLabs post-call webhook
 */

import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ maxInstances: 10 });

// Step 1+2: Firestore trigger for new audio dumps
export { onSessionUpdate } from "./onSessionUpdate.js";

// Steps 3+4: Separate Cloud Function for agent call
export { onAgentCall } from "./agentCall.js";

// Step 5: Post-call webhook from ElevenLabs
export { sessionWebhook } from "./sessionWebhook.js";
