import { EventEmitter } from "events";
import Groq from "groq-sdk";
import * as fs from "fs";
import * as path from "path";
import { STTService } from "./types";
import { GROQ_API_KEY } from "../../config/env";

export type { STTService };

export function createSTTService(language: string = 'auto'): STTService {
    return createGroqSTTService(language);
}

export function createGroqSTTService(initialLanguage: string = 'en'): STTService {
    const emitter = new EventEmitter();

    // Ensure API Key is available
    if (!process.env.GROQ_API_KEY && !GROQ_API_KEY) {
        console.error("[GroqSTT] CRITICAL: GROQ_API_KEY is missing!");
    }

    const groq = new Groq({
        apiKey: process.env.GROQ_API_KEY || GROQ_API_KEY
    });

    let isRunning = false;
    let audioBuffer: Buffer = Buffer.alloc(0);
    let isProcessing = false;
    let currentLanguage = initialLanguage;

    // 8kHz mulaw * 5 seconds = 40000 bytes
    // 8000 samples/sec * 1 byte/sample * 5 sec
    const CHUNK_SIZE = 40000;

    // Ensure temp directory exists
    const TEMP_DIR = path.join(__dirname, "temp");
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
    const TEMP_FILE = path.join(TEMP_DIR, "temp_audio.wav");

    const start = async () => {
        isRunning = true;
        emitter.emit("open");
        console.log(`[GroqSTT] Service started (Language: ${currentLanguage})`);
    };

    /**
     * Decode a single G.711 mu-law byte to a 16-bit linear PCM sample.
     * Standard ITU-T G.711 mu-law decode table.
     */
    const mulawToLinear = (mulawByte: number): number => {
        mulawByte = ~mulawByte & 0xFF; // invert all bits
        const sign = mulawByte & 0x80;
        const exponent = (mulawByte >> 4) & 0x07;
        const mantissa = mulawByte & 0x0F;
        let sample = ((mantissa << 1) + 33) << exponent;
        sample -= 33;
        return sign ? -sample : sample;
    };

    /**
     * Write a valid 16-bit PCM WAV file from raw mu-law (PCMU) audio bytes.
     * Input:  8kHz mu-law bytes (1 byte per sample, from WebRTC PCMU codec)
     * Output: WAV file with 8kHz 16-bit PCM — what Whisper actually expects
     */
    const writeWavFile = (mulawBuffer: Buffer, filePath: string) => {
        // Decode mu-law → 16-bit linear PCM
        const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);
        for (let i = 0; i < mulawBuffer.length; i++) {
            const sample = mulawToLinear(mulawBuffer[i]);
            pcmBuffer.writeInt16LE(sample, i * 2);
        }

        const sampleRate = 8000;   // WebRTC PCMU is 8kHz
        const channels = 1;
        const bitDepth = 16;
        const dataSize = pcmBuffer.length;

        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);                                    // PCM chunk size
        header.writeUInt16LE(1, 20);                                     // AudioFormat: PCM = 1
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * channels * bitDepth / 8, 28); // ByteRate
        header.writeUInt16LE(channels * bitDepth / 8, 32);              // BlockAlign
        header.writeUInt16LE(bitDepth, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
    };

    // Known Whisper hallucination phrases on silence
    const HALLUCINATION_PHRASES = [
        'thank you for watching',
        'thanks for watching',
        'thank you.',
        'thanks.',
        'bye.',
        'goodbye.',
        'ご視聴ありがとうございました',
        'vielen dank',
        'merci',
        'gracias',
        'danke',
        'subscrib',
        'ignore background noise',      // Whisper echoing our own prompt
        'ignore background noise and silence',
    ];

    const processBuffer = async () => {
        if (!isRunning || audioBuffer.length === 0 || isProcessing) return;

        isProcessing = true;
        const bufferToProcess = audioBuffer;
        audioBuffer = Buffer.alloc(0);

        try {
            writeWavFile(bufferToProcess, TEMP_FILE);

            const transcription = await groq.audio.transcriptions.create({
                file: fs.createReadStream(TEMP_FILE),
                model: "whisper-large-v3",
                response_format: "verbose_json",
                prompt: "The speaker speaks in Urdu or English only. Ignore background noise and silence.",
                language: currentLanguage === 'auto' ? undefined : currentLanguage,
            });

            const text = transcription.text?.trim();
            const language = (transcription as any).language;
            const segments: any[] = (transcription as any).segments ?? [];

            // --- Noise / Hallucination Filters ---

            // 0. Islamic greeting allowlist — these are Arabic-script phrases used by
            //    Urdu speakers. Groq mislabels them as "Arabic" so we protect them first.
            const ISLAMIC_GREETINGS = [
                // Arabic script
                'السلام عليكم', 'وعليكم السلام', 'السلام عليكم ورحمة الله',
                'السلام عليكم ورحمة الله وبركاته', 'جزاك الله', 'ماشاء الله',
                'إن شاء الله', 'الحمد لله', 'سبحان الله', 'بسم الله',
                // Romanized / Latin-script variants (often mislabeled as Italian/Indonesian)
                'assalamu alaikum', 'assalamualaikum', 'assalam alaikum',
                'walaikum assalam', 'wa alaikum assalam', 'walikum assalam',
                'assalamualaikum warahmatullahi wabarakatuh',
                'jazakallah', 'mashallah', 'inshallah', 'alhamdulillah',
                'subhanallah', 'bismillah',
            ];
            const isIslamicGreeting = ISLAMIC_GREETINGS.some(g => text?.includes(g));
            if (isIslamicGreeting) {
                console.log(`[GroqSTT] Allowed Islamic greeting as Urdu: "${text}"`);
                emitter.emit('transcript', { text, language: 'urdu', isFinal: true });
                return;
            }

            // 1. Language filter: only accept English and Urdu
            // Groq verbose_json returns full names like "English", "Urdu", not ISO codes
            const ALLOWED_LANGUAGES = ['english', 'urdu', 'hindi']; // hindi kept: Whisper labels Urdu speech as Hindi
            if (language && !ALLOWED_LANGUAGES.includes(language.toLowerCase())) {
                console.log(`[GroqSTT] Dropped non-target language (${language}): "${text}"`);
                return;
            }

            // 2. no_speech_prob filter: if first segment thinks it's silence, skip
            if (segments.length > 0) {
                const noSpeechProb = segments[0].no_speech_prob ?? 0;
                if (noSpeechProb > 0.5) {
                    console.log(`[GroqSTT] Dropped likely silence (no_speech_prob=${noSpeechProb.toFixed(2)}): "${text}"`);
                    return;
                }
            }

            // 3. Hallucination phrase filter
            const lowerText = (text ?? '').toLowerCase();
            const isHallucination = HALLUCINATION_PHRASES.some(phrase => lowerText.includes(phrase));
            if (isHallucination) {
                console.log(`[GroqSTT] Dropped hallucination phrase: "${text}"`);
                return;
            }

            // 4. Minimum length guard
            if (!text || text.length < 3) {
                console.log(`[GroqSTT] Dropped too-short transcript: "${text}"`);
                return;
            }

            console.log(`[GroqSTT] Transcript (${language}): ${text}`);
            emitter.emit("transcript", text);
            emitter.emit("transcript_metadata", {
                confidence: 1.0,
                is_final: true,
                text,
                language
            });
        } catch (err) {
            console.error("[GroqSTT] Error:", err);
        } finally {
            isProcessing = false;
        }
    };

    const sendAudio = (chunk: Buffer) => {
        if (!isRunning) return;
        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        // 5 seconds of audio before processing
        if (audioBuffer.length >= CHUNK_SIZE && !isProcessing) {
            processBuffer();
        }
    };

    const stop = () => {
        isRunning = false;
        // Process remaining buffer on stop?
        if (audioBuffer.length > 0) {
            processBuffer().catch(console.error);
        }
        emitter.emit("close");
        console.log("[GroqSTT] Stopped");
    };

    const setLanguage = (language: string) => {
        currentLanguage = language;
        console.log(`[GroqSTT] Language: ${language}`);
    };

    return Object.assign(emitter, {
        setLanguage,
        start,
        sendAudio,
        stop
    }) as STTService;
}
