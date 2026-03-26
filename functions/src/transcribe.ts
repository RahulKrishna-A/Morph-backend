import { ELEVENLABS_API_KEY } from "./config.js";

/**
 * Step 2a — Transcribe audio via ElevenLabs Scribe v2.
 * Downloads the audio from the given URL and sends it to
 * the ElevenLabs speech-to-text API.
 */
export async function transcribeAudio(audioUrl: string): Promise<string> {
  console.log("Transcribing audio", { audioUrl });

  // Download the audio file
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    throw new Error(`Failed to download audio: ${audioRes.status}`);
  }
  const audioBuffer = await audioRes.arrayBuffer();
  const audioBlob = new Blob([audioBuffer]);

  // Build multipart form data for ElevenLabs STT
  const formData = new FormData();
  formData.append("file", audioBlob, "dump.webm");
  formData.append("model_id", "scribe_v2");

  const sttRes = await fetch(
    "https://api.elevenlabs.io/v1/speech-to-text",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: formData,
    }
  );

  if (!sttRes.ok) {
    const errText = await sttRes.text();
    throw new Error(`ElevenLabs STT failed (${sttRes.status}): ${errText}`);
  }

  const result = await sttRes.json() as { text: string };
  console.log("STT result", result);
  console.log("Transcription complete", { length: result.text.length });
  return result.text;
}
