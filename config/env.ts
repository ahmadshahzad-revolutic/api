import dotenv from 'dotenv';

dotenv.config();

export const PORT = process.env.PORT;
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY as string;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY as string;
export const MONGO_URI = process.env.MONGO_URI;
export const GROQ_API_KEY = process.env.GROQ_API_KEY as string;
export const CLAUDE_MODEL_NAME = "claude-haiku-4-5-20251001";
