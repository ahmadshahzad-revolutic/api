import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } from "werift";
import { createSTTService } from "../voice/sttservice";
import { createTTSService } from "../voice/ttsservice";
import { createVADService } from "../voice/vadservice";
import { ELEVENLABS_API_KEY } from "../../config/env";
import { AIPeerService, AIPeerContext, CallState } from "./types";
import { setupHandlers, setupDataChannel } from "./eventhandlers";
import { handleTranslation } from "./translationmanager";
import { setState } from "./statemanager";

const finalizeTurn = async (ctx: AIPeerContext) => {
    const text = ctx.transcriptBuffer.trim();
    if (!text) {
        setState(ctx, CallState.LISTENING);
        return;
    }

    console.log(`[AI_PEER] Silence timeout reached. Processing: "${text}"`);
    ctx.lastProcessedTranscript = text;
    ctx.transcriptBuffer = "";
    setState(ctx, CallState.PROCESSING);
    await handleTranslation(ctx, text);
};

export function createAIPeerService(callId: string = 'default'): AIPeerService {
    console.log(`[AI_PEER] Initializing AIPeerService for call: ${callId}`);

    // Initialize context
    const ctx: AIPeerContext = {
        callId,
        pc: new RTCPeerConnection({
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
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
            ]
        }),
        stt: createSTTService('auto'),
        tts: createTTSService(ELEVENLABS_API_KEY),
        vad: createVADService(),
        chatHistory: [],
        outputTrack: new MediaStreamTrack({ kind: "audio" }),
        sequenceNumber: 0,
        timestamp: 0,
        ssrc: Math.floor(Math.random() * 1000000),
        audioQueue: Buffer.alloc(0),
        pacerInterval: null,
        isTranslationActive: false,
        sentenceBuffer: "",
        lastProcessedTranscript: "",
        callerName: "User",
        hasSentGreeting: false,
        claudeAbortController: null,
        isAISpeaking: false,
        controlChannel: null,
        isSilencing: false,
        lastInterruptionTime: 0,
        currentResponseText: "",
        isInterrupted: false,
        lastPartialResponse: "",
        lastInterruptedQuestion: "",
        state: CallState.LISTENING,
        silenceTimer: null,
        transcriptBuffer: "",
        userSpeechStartTime: null,
        currentMaxConfidence: 0,
        lastAudioLevelDb: -100,
        peakVolumeThisUtterance: -100,
        detectedLanguage: 'english'  // default; updated from STT transcript_metadata
    };

    ctx.tts.setProvider('elevenlabs');
    ctx.vad.init().catch(err => console.error("[AI_PEER] VAD initialization failed:", err));
    ctx.controlChannel = ctx.pc.createDataChannel("control");

    const initializeCall = (clrName: string = 'User') => {
        ctx.callerName = clrName;
        ctx.stt.start().catch(err => console.error("[AI_PEER] STT pre-start failed:", err));
        console.log(`[AI_PEER] Call ${callId} initialized for: ${clrName}`);
    };

    const sendGreeting = async () => {
        if (ctx.hasSentGreeting) return;
        ctx.hasSentGreeting = true;
        const greeting = `Hello ${ctx.callerName}! I am your Revolutic Assistant. How can I help you today?`;
        ctx.tts.streamTTS(greeting, 'en');
        ctx.chatHistory.push({ role: "assistant", content: greeting });
    };

    setupDataChannel(ctx);
    setupHandlers(ctx, sendGreeting, finalizeTurn);

    return {
        pc: ctx.pc,
        get isAISpeaking() { return ctx.isAISpeaking; },
        initializeCall,
        async createAnswer(offer: any) {
            await ctx.pc.setRemoteDescription(offer);
            const answer = await ctx.pc.createAnswer();
            await ctx.pc.setLocalDescription(answer);
            return answer;
        },
        async stop() {
            if (ctx.pacerInterval) {
                clearInterval(ctx.pacerInterval);
                ctx.pacerInterval = null;
            }
            ctx.chatHistory = [];
            ctx.audioQueue = Buffer.alloc(0);
            ctx.stt.stop();
            await ctx.pc.close();
        }
    };
}

export * from "./types";
