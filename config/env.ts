import dotenv from 'dotenv';

dotenv.config();

export const PORT = process.env.PORT || 5000;
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY as string;
export const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY as string;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY as string;
export const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY as string;
export const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION as string;
export const MONGO_URI = process.env.MONGO_URI || process.env.MongoDB || 'mongodb://localhost:27017/calling-agent';
export const CLAUDE_MODEL_NAME = "claude-haiku-4-5-20251001";
