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

export class STTService extends EventEmitter {
    private deepgram;
    private connection: any;
    private language: string;

    constructor(apiKey: string, language: string = 'ur') {
        super();
        console.log(`[STT] Initializing Deepgram with key length: ${apiKey?.length}`);
        this.deepgram = createClient(apiKey);
        this.language = DEEPGRAM_LANGUAGE_MAP[language] || language;
    }

    /**
     * Update the language for STT (e.g., when caller language is detected or changed)
     */
    setLanguage(language: string) {
        this.language = DEEPGRAM_LANGUAGE_MAP[language] || language;
        console.log(`[STT] Language updated to: ${this.language}`);
    }

    private lastTranscript: string = "";

    async start() {
        console.log(`[STT] Starting Deepgram connection with language: ${this.language}...`);

        // Use Nova-3 for Urdu as Nova-2 doesn't support it for streaming
        const isUrdu = this.language.startsWith('ur');
        const model = isUrdu ? "nova-3" : "nova-2";

        const options: any = {
            model,
            language: this.language,
            encoding: "mulaw",
            sample_rate: 8000,
            endpointing: 300,        // Increased to 300ms for more stable conversational flow
            utterance_timeout: 10000, // Force close utterances after 10s of noise
            interim_results: true,
        };

        // Only enable advanced features for English to be safe
        if (this.language.startsWith('en')) {
            options.smart_format = true;
            options.vad_events = true;
        }

        this.connection = this.deepgram.listen.live(options);

        this.connection.on(LiveTranscriptionEvents.Open, () => {
            console.log("[STT] Deepgram connection opened");
            this.emit("open");
        });

        // Trigger 'speech_started' the moment voice is detected for barge-in
        this.connection.on(LiveTranscriptionEvents.SpeechStarted, (data: any) => {
            console.log("[STT] SpeechStarted (User started speaking)");
            this.emit("speech_started");
        });

        // Trigger 'speech_ended' with the latest transcript we have
        this.connection.on(LiveTranscriptionEvents.UtteranceEnd, (data: any) => {
            console.log("[STT] UtteranceEnd (VAD detected silence)");
            this.emit("speech_ended", this.lastTranscript);
        });

        this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
            const alternative = data.channel.alternatives[0];
            const transcript = alternative.transcript;
            const confidence = alternative.confidence;

            if (transcript) {
                this.lastTranscript = transcript;

                // Emit metadata for distance-based filtering
                this.emit("transcript_metadata", {
                    confidence: confidence || 0,
                    is_final: data.is_final,
                    text: transcript
                });

                if (data.is_final) {
                    console.log(`[STT] Final transcript: "${transcript}" (Confidence: ${confidence?.toFixed(2)})`);
                    this.emit("transcript", transcript);
                    this.lastTranscript = ""; // Reset after final
                } else {
                    this.emit("interim", transcript);
                }
            }
        });

        this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
            console.error("[STT] Deepgram error detail:", JSON.stringify(err, null, 2));
            if (err.message) console.error("[STT] Error message:", err.message);
            if (err.status) console.error("[STT] Status code:", err.status);
            this.emit("error", err);
        });

        this.connection.on(LiveTranscriptionEvents.Close, () => {
            console.log("[STT] Deepgram connection closed");
            this.emit("close");
        });
    }

    sendAudio(chunk: Buffer) {
        if (this.connection && this.connection.getReadyState() === 1) {
            this.connection.send(chunk);
        }
    }

    stop() {
        if (this.connection) {
            this.connection.finish();
        }
    }
}
