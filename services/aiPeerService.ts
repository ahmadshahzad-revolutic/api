import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import { STTService } from "./sttService";
import { TTSService } from "./ttsService";
import { VADService } from "./vadService";
import { createTranslationStream, translateText } from "./claudeService";
import { DEEPGRAM_API_KEY, ELEVENLABS_API_KEY } from "../config/env";

interface CallLanguageConfig {
    caller: string;   // Language of the caller (e.g., 'ur', 'hi', 'es', 'auto')
    receiver: string; // Language of the receiver (e.g., 'en')
}

enum CallState {
    LISTENING = 'LISTENING',
    PROCESSING = 'PROCESSING',
    SPEAKING = 'SPEAKING',
    INTERRUPTED = 'INTERRUPTED'
}

export class AIPeerService {
    public pc: RTCPeerConnection;
    private stt: STTService;
    private tts: TTSService;
    private vad: VADService;
    private chatHistory: any[] = [];
    private outputTrack: MediaStreamTrack;
    private sequenceNumber = 0;
    private timestamp = 0;
    private ssrc = Math.floor(Math.random() * 1000000);
    private audioQueue: Buffer = Buffer.alloc(0);
    private pacerInterval: any = null;

    // Per-call language configuration
    private callLanguages: CallLanguageConfig = { caller: 'en', receiver: 'en' };
    private callId: string;
    private isTranslationActive = false;
    private sentenceBuffer = ""; // Move to class level for easier clearing
    private lastProcessedTranscript = "";
    private callerName = "User"; // Default name
    private hasSentGreeting = false;
    private claudeAbortController: AbortController | null = null;
    public isAISpeaking: boolean = false;
    private controlChannel: any = null;
    private isSilencing = false;
    private lastInterruptionTime = 0;
    private currentResponseText = ""; // Track what the AI is currently saying
    private isInterrupted = false;
    private lastPartialResponse = ""; // Store the text before interruption
    private lastInterruptedQuestion = ""; // Store the question that was being answered

    private state: CallState = CallState.LISTENING;
    private silenceTimer: any = null;
    private transcriptBuffer: string = "";
    private readonly SILENCE_THRESHOLD = 2500; // 2.5 seconds as requested (2-3s)

    // Distance-Based Filtering Constants
    private readonly VOLUME_THRESHOLD_DB = -25; // dB
    private readonly DURATION_THRESHOLD_MS = 500; // ms
    private readonly CONFIDENCE_THRESHOLD = 0.85;

    // Distance-Based Filtering State
    private userSpeechStartTime: number | null = null;
    private currentMaxConfidence = 0;
    private lastAudioLevelDb = -100;

    constructor(callId: string = 'default') {
        console.log("[AI_PEER] Initializing AIPeerService...");
        this.callId = callId;

        try {
            this.pc = new RTCPeerConnection({
                codecs: {
                    audio: [
                        new RTCRtpCodecParameters({
                            mimeType: "audio/PCMU",
                            clockRate: 8000,
                            channels: 1,
                            payloadType: 0
                        }),
                    ],
                },
                iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
            });
            console.log("[AI_PEER] RTCPeerConnection created with PCMU support");

            // Initialize STT with caller's language - Use Deepgram Nova-3 (Premium Accuracy)
            console.log("[AI_PEER] Using Deepgram STT (Nova-3)");
            this.stt = new STTService(DEEPGRAM_API_KEY, this.callLanguages.caller);

            // Initialize TTS with Deepgram as default for lower latency
            this.tts = new TTSService(DEEPGRAM_API_KEY, ELEVENLABS_API_KEY);
            this.tts.setProvider('deepgram');

            // Initialize Silero VAD
            this.vad = new VADService();
            this.vad.init().catch(err => console.error("[AI_PEER] VAD initialization failed:", err));

            this.outputTrack = new MediaStreamTrack({ kind: "audio" });
            console.log("[AI_PEER] Services and Tracks initialized");

            // Create DataChannel for control messages
            this.controlChannel = this.pc.createDataChannel("control");
            this.setupDataChannel();

            this.setupHandlers();
        } catch (error: any) {
            console.error("[AI_PEER] Constructor failed:", error.message);
            throw error;
        }
    }

    /**
     * Initialize call with language configuration
     */
    initializeCall(callerLanguage: string = 'en', receiverLanguage: string = 'en', callerName: string = 'User') {
        this.callerName = callerName;
        this.callLanguages = {
            caller: callerLanguage,
            receiver: receiverLanguage
        };

        // Update STT language to match caller
        this.stt.setLanguage(callerLanguage);

        // Pre-start STT for lower latency
        this.stt.start().catch(err => console.error("[AI_PEER] STT pre-start failed:", err));

        console.log(`[AI_PEER] Call ${this.callId} initialized: ${callerLanguage} ↔ ${receiverLanguage}`);
    }

    /**
     * Update languages mid-call
     */
    updateCallLanguages(callerLanguage: string, receiverLanguage: string) {
        this.callLanguages = {
            caller: callerLanguage,
            receiver: receiverLanguage
        };
        this.stt.setLanguage(callerLanguage);
        console.log(`[AI_PEER] Languages updated: ${callerLanguage} ↔ ${receiverLanguage}`);
    }

    private setupHandlers() {
        // Add output track to PeerConnection
        this.pc.addTrack(this.outputTrack);

        // Handle connection state changes for greeting
        this.pc.onconnectionstatechange = () => {
            console.log(`[AI_PEER] Connection state: ${this.pc.connectionState}`);
            if (this.pc.connectionState === "connected") {
                this.sendGreeting();
            }
        };

        // Handle incoming tracks
        this.pc.ontrack = (event) => {
            const track = event.track;
            if (track.kind === "audio") {
                console.log("[AI_PEER] Received audio track");
                // STT already started in initializeCall for lower latency

                track.onReceiveRtp.subscribe(async (rtp) => {
                    // Trigger greeting on first receiving packet (reliable indicator of media flow)
                    if (!this.hasSentGreeting) {
                        this.sendGreeting();
                    }
                    this.stt.sendAudio(rtp.payload);

                    // Volume Calculation (dB)
                    const db = this.calculateDb(rtp.payload);
                    this.lastAudioLevelDb = db;

                    // Robust Silero VAD Interruption
                    const isSpeech = await this.vad.processAudio(rtp.payload);
                    if (isSpeech) {
                        if (!this.userSpeechStartTime) {
                            this.userSpeechStartTime = Date.now();
                        }

                        const duration = Date.now() - this.userSpeechStartTime;

                        // Professional Interruption Rule:
                        // 1. Audio Level > -25dB (Close to mic)
                        // 2. Speech Duration > 500ms (Validate utterance)
                        // 3. (Confidence is verified in STT event)
                        if (db > this.VOLUME_THRESHOLD_DB && duration > this.DURATION_THRESHOLD_MS) {
                            console.log(`[AI_PEER] Valid Interruption: Vol=${db.toFixed(1)}dB, Dur=${duration}ms`);
                            this.handleInterruption();
                        } else {
                            // Track but don't interrupt yet
                            if (duration % 200 === 0) { // Log occasionally
                                console.log(`[AI_PEER] User speaking (wait): Vol=${db.toFixed(1)}dB, Dur=${duration}ms`);
                            }
                        }
                    } else {
                        this.userSpeechStartTime = null;
                    }
                });
            }
        };

        // Handle transcripts
        this.stt.on("transcript", async (text) => {
            const cleanText = text.trim();
            if (!cleanText) return;

            console.log("[AI_PEER] STT Transcript Update:", cleanText);
            this.transcriptBuffer = cleanText;

            // Re-start silence timer on every transcript update to ensure we wait for the full thought
            this.startSilenceTimer();
        });

        // VAD-BASED SPEECH EVENTS
        this.stt.on("speech_started", () => {
            console.log("[AI_PEER] User speech detected. Resetting silence timer.");
            this.clearSilenceTimer();
        });

        this.stt.on("speech_ended", async (interimText: string) => {
            console.log("[AI_PEER] User stopped speaking. Starting silence timer...");
            if (interimText) {
                this.transcriptBuffer = interimText.trim();
            }
            this.startSilenceTimer();
            // Reset speech tracking
            this.userSpeechStartTime = null;
        });

        this.stt.on("transcript_metadata", (data: any) => {
            if (data?.confidence) {
                this.currentMaxConfidence = Math.max(this.currentMaxConfidence, data.confidence);

                // If we haven't interrupted yet but have high confidence and high volume, trigger it
                if (this.state === CallState.SPEAKING &&
                    this.currentMaxConfidence > this.CONFIDENCE_THRESHOLD &&
                    this.lastAudioLevelDb > this.VOLUME_THRESHOLD_DB) {

                    console.log(`[AI_PEER] High-Confidence Interruption: Conf=${this.currentMaxConfidence.toFixed(2)}, Vol=${this.lastAudioLevelDb.toFixed(1)}dB`);
                    this.handleInterruption();
                }
            }
        });

        // Handle TTS audio chunks — accept direct u-law
        this.tts.on("audio", (chunk: Buffer) => {
            this.audioQueue = Buffer.concat([this.audioQueue, chunk]);

            // Start robust pacer if not running
            if (!this.pacerInterval) {
                console.log("[AI_PEER] Starting high-resolution pacer");
                let lastTime = Date.now();

                this.pacerInterval = setInterval(() => {
                    const now = Date.now();
                    const frameSize = 160; // 20ms at 8kHz u-law

                    const elapsed = now - lastTime;
                    const framesToDispatch = Math.floor(elapsed / 20);

                    const previousSpeaking = this.isAISpeaking;

                    // Logic: Speaking if queue has data AND we aren't in a silence-flush phase
                    if (this.audioQueue.length >= frameSize && !this.isSilencing) {
                        this.isAISpeaking = true;
                        if (this.state !== CallState.INTERRUPTED) {
                            this.setState(CallState.SPEAKING);
                        }
                    } else {
                        this.isAISpeaking = false;
                        if (this.state === CallState.SPEAKING) {
                            this.setState(CallState.LISTENING);
                        }
                    }

                    // Notify client on state change
                    if (previousSpeaking !== this.isAISpeaking && this.controlChannel && this.controlChannel.readyState === "open") {
                        this.controlChannel.send(JSON.stringify({ type: "STATE", isAISpeaking: this.isAISpeaking }));
                    }

                    for (let i = 0; i < framesToDispatch; i++) {
                        if (this.audioQueue.length >= frameSize) {
                            const payload = this.audioQueue.slice(0, frameSize);
                            this.audioQueue = this.audioQueue.slice(frameSize);

                            // If we just exhausted the silence flush, reset flag
                            if (this.isSilencing && this.audioQueue.length === 0) {
                                this.isSilencing = false;
                            }

                            const packet = new RtpPacket(
                                new RtpHeader({
                                    payloadType: 0, // PCMU
                                    sequenceNumber: this.sequenceNumber++,
                                    timestamp: this.timestamp,
                                    ssrc: this.ssrc,
                                }),
                                payload
                            );

                            this.outputTrack.writeRtp(packet);
                            this.timestamp += payload.length;
                            lastTime += 20;

                            if (this.sequenceNumber > 65535) this.sequenceNumber = 0;
                        } else {
                            this.isAISpeaking = false;
                            lastTime = now;
                            break;
                        }
                    }
                }, 10);
            }
        });

        this.stt.on("error", (err) => {
            console.error("[AI_PEER] STT Error:", err);
        });

        this.tts.on("error", (err) => {
            console.error("[AI_PEER] TTS Error:", err);
        });

        this.tts.on("end", () => {
            const frameSize = 160;
            const remainder = this.audioQueue.length % frameSize;
            if (this.audioQueue.length > 0 && remainder > 0) {
                const paddingSize = frameSize - remainder;
                const padding = Buffer.alloc(paddingSize, 0xFF); // PCMU silence
                this.audioQueue = Buffer.concat([this.audioQueue, padding]);
            }
        });
    }

    private setupDataChannel() {
        if (!this.controlChannel) return;

        this.controlChannel.onMessage.subscribe((message: any) => {
            try {
                const data = JSON.parse(message.toString());
                console.log("[AI_PEER] DataChannel Message:", data);
                if (data.type === "INTERRUPT") {
                    this.handleInterruption();
                }
            } catch (e) {
                console.warn("[AI_PEER] Failed to parse DataChannel message:", message);
            }
        });

        this.controlChannel.stateChanged.subscribe(() => {
            console.log(`[AI_PEER] Control DataChannel state: ${this.controlChannel.readyState}`);
        });
    }

    private handleInterruption() {
        const now = Date.now();
        // Debounce interruptions to 500ms
        if (now - this.lastInterruptionTime < 500) return;

        if (this.isAISpeaking || this.isTranslationActive || this.audioQueue.length > 0) {
            this.lastInterruptionTime = now;
            console.log("[AI_PEER] User interrupted AI. Silencing audio...");

            // Capture what was being said
            this.lastPartialResponse = this.currentResponseText;
            this.isInterrupted = true;
            console.log(`[AI_PEER] Interrupted while saying: "${this.lastPartialResponse}"`);

            // Notify client immediately via DataChannel
            if (this.controlChannel && this.controlChannel.readyState === "open") {
                this.controlChannel.send(JSON.stringify({ type: "INTERRUPTED" }));
            }

            // Stop synthesis
            this.tts.stop();

            // Clear audio queue
            this.audioQueue = Buffer.alloc(0);
            this.isAISpeaking = false;

            // Abort Claude stream if active
            if (this.claudeAbortController) {
                this.claudeAbortController.abort();
                this.claudeAbortController = null;
            }

            // Inject 100ms of PCMU silence (0xFF) to flush client buffer
            const silenceFrame = Buffer.alloc(800, 0xFF);
            this.isSilencing = true;
            this.audioQueue = silenceFrame;

            this.sentenceBuffer = "";
            this.isTranslationActive = false;
            this.currentResponseText = "";
            this.setState(CallState.INTERRUPTED);
        }
    }

    private setState(newState: CallState) {
        if (this.state !== newState) {
            console.log(`[AI_PEER] State Transition: ${this.state} -> ${newState}`);
            this.state = newState;
            if (this.controlChannel && this.controlChannel.readyState === "open") {
                this.controlChannel.send(JSON.stringify({ type: "STATE_CHANGE", state: newState }));
            }

            // If we transition out of SPEAKING, reset distance state
            if (newState !== CallState.SPEAKING && newState !== CallState.INTERRUPTED) {
                this.currentMaxConfidence = 0;
            }
        }
    }

    /**
     * Calculate Volume in Decibels (dB) from PCMU buffer
     */
    private calculateDb(buffer: Buffer): number {
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
            // Simple u-law to linear approx (sufficient for RMS)
            let u = ~buffer[i];
            let sign = (u & 0x80);
            let exponent = (u & 0x70) >> 4;
            let mantissa = (u & 0x0F);
            let sample = (mantissa << 3) + 132;
            sample <<= (exponent);
            sample -= 132;
            const normalized = (sign ? -sample : sample) / 32768.0;
            sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / buffer.length);
        // Avoid log10(0)
        return 20 * Math.log10(Math.max(rms, 0.00001));
    }

    private startSilenceTimer() {
        this.clearSilenceTimer();
        this.silenceTimer = setTimeout(() => {
            this.finalizeTurn();
        }, this.SILENCE_THRESHOLD);
    }

    private clearSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    private async finalizeTurn() {
        const text = this.transcriptBuffer.trim();
        if (!text) {
            this.setState(CallState.LISTENING);
            return;
        }

        console.log(`[AI_PEER] Silence timeout reached. Processing: "${text}"`);
        this.lastProcessedTranscript = text;
        this.transcriptBuffer = "";
        this.setState(CallState.PROCESSING);
        await this.handleTranslation(text);
    }

    private async handleTranslation(text: string) {
        if (this.isTranslationActive) return;
        this.isTranslationActive = true;
        const startTime = Date.now();
        const sourceLang = this.callLanguages.caller;
        const targetLang = this.callLanguages.receiver;

        console.log(`[AI_PEER] Translation pipeline: "${text}" (${sourceLang} → ${targetLang})`);

        try {
            if (this.claudeAbortController) {
                this.claudeAbortController.abort();
            }
            this.claudeAbortController = new AbortController();

            const watchdog = setTimeout(() => {
                if (this.isTranslationActive) {
                    console.error("[AI_PEER] Pipeline Watchdog Triggered: Forcing reset");
                    this.isTranslationActive = false;
                    this.claudeAbortController?.abort();
                }
            }, 15000);

            const interruptedContext = this.isInterrupted ? this.lastPartialResponse : undefined;
            const interruptedQuestion = this.isInterrupted ? this.lastInterruptedQuestion : undefined;

            if (this.isInterrupted) {
                console.log(`[AI_PEER] Using interrupted context: Ans="${interruptedContext}", Que="${interruptedQuestion}"`);
            }

            // Store current question for potential future interruption
            this.lastInterruptedQuestion = text;

            const stream = createTranslationStream(
                text,
                targetLang,
                sourceLang,
                this.chatHistory,
                this.claudeAbortController.signal,
                interruptedContext,
                interruptedQuestion
            );

            // Reset interruption state
            this.isInterrupted = false;
            this.lastPartialResponse = "";
            // Note: we don't reset lastInterruptedQuestion here because we just updated it above for the current turn

            stream.on("error", (error: any) => {
                const isAbort = error.name === 'AbortError' ||
                    error.name === 'APIUserAbortError' ||
                    error.message?.toLowerCase().includes('aborted');

                if (isAbort) {
                    console.log("[AI_PEER] Claude stream aborted intentionally");
                    return;
                }
                console.error("[AI_PEER] Claude Stream Error:", error);
            });

            let fullTranslation = "";
            this.sentenceBuffer = "";

            stream.on("text", (delta) => {
                if (!this.isTranslationActive) return; // FIX: Prevent logic after interruption

                fullTranslation += delta;
                this.currentResponseText = fullTranslation; // Update current speaking text
                this.sentenceBuffer += delta;

                const trimmed = this.sentenceBuffer.trim();
                const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
                const hasRealContent = /[\u0600-\u06FF\u0900-\u097F\u4e00-\u9fff\w]/.test(trimmed);

                const isSentenceEnd = /[.!?;।؟۔]$/.test(trimmed);
                const isFirstChunk = fullTranslation.length === trimmed.length;
                const minWords = isFirstChunk ? 1 : 3;
                const isClauseEnd = /[,،]/.test(trimmed) && wordCount >= minWords;
                const isTooLong = wordCount >= 6;

                if (hasRealContent && (isSentenceEnd || isClauseEnd || isTooLong)) {
                    console.log(`[AI_PEER] TTS chunk (${Date.now() - startTime}ms): "${trimmed}"`);
                    this.tts.streamTTS(trimmed, targetLang);
                    this.sentenceBuffer = "";
                }
            });

            stream.on("finalMessage", () => {
                if (!this.isTranslationActive) return; // FIX: Prevent logic after interruption

                clearTimeout(watchdog);
                const latency = Date.now() - startTime;
                console.log(`[AI_PEER] Translation complete: "${fullTranslation}" (${latency}ms)`);

                const remaining = this.sentenceBuffer.trim();
                const hasRealContent = /[\u0600-\u06FF\u0900-\u097F\u4e00-\u9fff\w]/.test(remaining);
                const wordCount = remaining.split(/\s+/).filter(w => w.length > 0).length;

                if (remaining && hasRealContent && (wordCount > 0)) {
                    console.log(`[AI_PEER] Final TTS chunk (${Date.now() - startTime}ms): "${remaining}"`);
                    this.tts.streamTTS(remaining, targetLang);
                }

                this.chatHistory.push({ role: "user", content: text });
                this.chatHistory.push({ role: "assistant", content: fullTranslation });

                if (this.chatHistory.length > 10) {
                    this.chatHistory = this.chatHistory.slice(-10);
                }

                this.claudeAbortController = null;
                this.isTranslationActive = false;
                console.log(`[AI_PEER] Pipeline Complete (Total: ${Date.now() - startTime}ms)`);
            });

            await stream.finalMessage();
            clearTimeout(watchdog);

        } catch (error: any) {
            const isAbort = error.name === 'AbortError' ||
                error.name === 'APIUserAbortError' ||
                error.message?.toLowerCase().includes('aborted');

            if (isAbort) {
                console.log("[AI_PEER] Translation pipeline aborted");
                this.isTranslationActive = false;
                this.claudeAbortController = null;
                return;
            }

            console.error("[AI_PEER] Translation Error:", error);
            this.isTranslationActive = false;

            try {
                if (this.claudeAbortController?.signal.aborted) return;
                const { translation, latency } = await translateText(
                    text,
                    targetLang,
                    sourceLang,
                    this.chatHistory,
                    this.claudeAbortController?.signal
                );
                console.log(`[AI_PEER] Fallback translation: "${translation}" (${latency}ms)`);
                this.tts.streamTTS(translation, targetLang);

                this.chatHistory.push({ role: "user", content: text });
                this.chatHistory.push({ role: "assistant", content: translation });
            } catch (fallbackError: any) {
                const isFallbackAbort = fallbackError.name === 'AbortError' ||
                    fallbackError.name === 'APIUserAbortError' ||
                    fallbackError.message?.toLowerCase().includes('aborted');
                if (isFallbackAbort) return;
                console.error("[AI_PEER] Fallback translation failed:", fallbackError);
            }
        }
    }

    private async sendGreeting() {
        if (this.hasSentGreeting) return;
        this.hasSentGreeting = true;

        const greeting = `Hello ${this.callerName}! I am your Revolutic Assistant. How can I help you today?`;
        console.log(`[AI_PEER] Sending automated greeting: "${greeting}"`);

        this.tts.streamTTS(greeting, this.callLanguages.receiver);
        this.chatHistory.push({ role: "assistant", content: greeting });
    }

    async createAnswer(offer: any) {
        await this.pc.setRemoteDescription(offer);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return answer;
    }

    async stop() {
        console.log(`[AI_PEER] Stopping call ${this.callId}`);

        if (this.pacerInterval) {
            clearInterval(this.pacerInterval);
            this.pacerInterval = null;
        }

        this.chatHistory = [];
        this.audioQueue = Buffer.alloc(0);

        this.stt.stop();
        await this.pc.close();

        console.log(`[AI_PEER] Call ${this.callId} stopped and cleaned up`);
    }
}
