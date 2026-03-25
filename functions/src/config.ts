import "dotenv/config";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import OpenAI from "openai";

// Initialize Firebase Admin
const app = initializeApp();
export const db = getFirestore(app);
export const storage = getStorage(app);

// Environment variables — loaded from .env file
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID!;
export const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID!;
export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY!;

// OpenAI client
export const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
