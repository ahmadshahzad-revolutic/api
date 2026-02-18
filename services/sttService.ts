import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { EventEmitter } from "events";

// Language code mapping for Deepgram STT
const DEEPGRAM_LANGUAGE_MAP: Record<string, string> = {
    'en': 'en-US',
    'en-US': 'en-US',
    'ur': 'ur',
    'hi': 'hi',
    'es': 'es',
    'fr': 'fr',
    'ar': 'ar',
    'zh': 'zh',
    'ja': 'ja',
    'de': 'de',
    'bn': 'bn',
    'pt': 'pt',
    'ru': 'ru',
    'ko': 'ko',
    'pa': 'pa',
    'te': 'te',
    'ta': 'ta',
    'mr': 'mr',
    'it': 'it',
    'auto': 'ur', // default fallback for Urdu-first experience
};

export interface STTService extends EventEmitter {
    setLanguage(language: string): void;
    start(): Promise<void>;
    sendAudio(chunk: Buffer): void;
    stop(): void;
}

export function createSTTService(apiKey: string, language: string = 'ur'): STTService {
    const emitter = new EventEmitter();
    console.log(`[STT] Initializing Deepgram with key length: ${apiKey?.length}`);
    const deepgram = createClient(apiKey);
    let currentLanguage = DEEPGRAM_LANGUAGE_MAP[language] || language;
    let connection: any;
    let lastTranscript: string = "";

    /**
     * Update the language for STT (e.g., when caller language is detected or changed)
     */
    const setLanguage = (language: string) => {
        currentLanguage = DEEPGRAM_LANGUAGE_MAP[language] || language;
        console.log(`[STT] Language updated to: ${currentLanguage}`);
    };

    const start = async () => {
        console.log(`[STT] Starting Deepgram connection with language: ${currentLanguage}...`);

        // Use Nova-3 for Urdu as Nova-2 doesn't support it for streaming
        const isUrdu = currentLanguage.startsWith('ur');
        const model = isUrdu ? "nova-3" : "nova-2";

        const options: any = {
            model,
            language: currentLanguage,
            encoding: "mulaw",
            sample_rate: 8000,
            endpointing: 150,        // Further reduced for lower latency
            utterance_timeout: 10000, // Force close utterances after 10s of noise
            interim_results: true,
        };

        // Only enable advanced features for English to be safe
        if (currentLanguage.startsWith('en')) {
            options.smart_format = true;
            options.vad_events = true;
        }

        connection = deepgram.listen.live(options);

        connection.on(LiveTranscriptionEvents.Open, () => {
            console.log("[STT] Deepgram connection opened");
            emitter.emit("open");
        });

        // Trigger 'speech_started' the moment voice is detected for barge-in
        connection.on(LiveTranscriptionEvents.SpeechStarted, (data: any) => {
            console.log("[STT] SpeechStarted (User started speaking)");
            emitter.emit("speech_started");
        });

        // Trigger 'speech_ended' with the latest transcript we have
        connection.on(LiveTranscriptionEvents.UtteranceEnd, (data: any) => {
            console.log("[STT] UtteranceEnd (VAD detected silence)");
            emitter.emit("speech_ended", lastTranscript);
        });

        connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
            const alternative = data.channel.alternatives[0];
            const transcript = alternative.transcript;
            const confidence = alternative.confidence;

            if (transcript) {
                lastTranscript = transcript;

                // Emit metadata for distance-based filtering
                emitter.emit("transcript_metadata", {
                    confidence: confidence || 0,
                    is_final: data.is_final,
                    text: transcript
                });

                if (data.is_final) {
                    console.log(`[STT] Final transcript: "${transcript}" (Confidence: ${confidence?.toFixed(2)})`);
                    emitter.emit("transcript", transcript);
                    lastTranscript = ""; // Reset after final
                } else {
                    emitter.emit("interim", transcript);
                }
            }
        });

        connection.on(LiveTranscriptionEvents.Error, (err: any) => {
            console.error("[STT] Deepgram error detail:", JSON.stringify(err, null, 2));
            if (err.message) console.error("[STT] Error message:", err.message);
            if (err.status) console.error("[STT] Status code:", err.status);
            emitter.emit("error", err);
        });

        connection.on(LiveTranscriptionEvents.Close, () => {
            console.log("[STT] Deepgram connection closed");
            emitter.emit("close");
        });
    };

    const sendAudio = (chunk: Buffer) => {
        if (connection && connection.getReadyState() === 1) {
            connection.send(chunk);
        }
    };

    const stop = () => {
        if (connection) {
            connection.finish();
        }
    };

    return Object.assign(emitter, {
        setLanguage,
        start,
        sendAudio,
        stop
    }) as STTService;
}

